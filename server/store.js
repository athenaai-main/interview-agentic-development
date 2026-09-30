import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
export const id = () => randomUUID();
export const hash = s => createHash('sha256').update(s).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export class Fault extends Error { constructor(status, code, message = code) { super(message); this.status = status; this.code = code; } }
export const requireThat = (condition, code, status = 409) => { if (!condition) throw new Fault(status, code); };
const now = () => Date.now();
const allowed = { plan_review:['pass','needs_clarification'], prototype:['ready_for_review','blocked'], implementation:['ready_for_code_review','blocked'], code_review:['pass','needs_revision','needs_human_input'] };
export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path); this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id), kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id), type TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_issue ON jobs(issue_id) WHERE status='running';
      CREATE TABLE IF NOT EXISTS slots(slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 3), job_id TEXT UNIQUE);
      INSERT OR IGNORE INTO slots VALUES(1,NULL),(2,NULL),(3,NULL);
      CREATE TABLE IF NOT EXISTS tokens(digest TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,key));`);
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value=fn(); this.db.exec('COMMIT'); return value; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  once(scope,key,body,fn) {
    requireThat(typeof key==='string' && key.length>0 && key.length<=200,'idempotency_key_required',400);
    return this.tx(()=>{ const digest=hash(JSON.stringify(body)); const old=this.db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope,key);
      if(old) { requireThat(old.digest===digest,'idempotency_conflict'); return JSON.parse(old.result); }
      const result=fn(); this.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope,key,digest,JSON.stringify(result)); return result;
    });
  }
  row(table,key) { const row=this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key); requireThat(row,'not_found',404); return JSON.parse(row.data); }
  issue(key) { return this.row('issues',key); }
  event(issueId,type,details={}) { this.db.prepare('INSERT INTO events(issue_id,time,data) VALUES(?,?,?)').run(issueId,now(),JSON.stringify({type,...details})); }
  save(i,state=i.state) { const before=i.state; i.state=state; i.version++; i.updatedAt=now(); this.db.prepare('UPDATE issues SET version=?,state=?,data=? WHERE id=?').run(i.version,state,JSON.stringify(i),i.id); this.event(i.id,'state_changed',{from:before,to:state,issueVersion:i.version}); }
  expected(i,v) { requireThat(i.version===v,'stale_issue_version'); }
  mint(scope,expiresMs=3600000) { const token=secret(); this.db.prepare('INSERT INTO tokens VALUES(?,?)').run(hash(token),JSON.stringify({...scope,expiresAt:now()+expiresMs})); return token; }
  auth(token,op,issueId) { const row=this.db.prepare('SELECT data FROM tokens WHERE digest=?').get(hash(token||'')); requireThat(row,'unauthorized',401); const t=JSON.parse(row.data); requireThat(t.expiresAt>now(),'token_expired',401); requireThat(t.ops.includes(op) && (!issueId || t.issueId===issueId),'forbidden',403); return t; }
  artifact(i,kind,data) { const a={id:id(),issueId:i.id,kind,createdAt:now(),...data}; this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?)').run(a.id,i.id,kind,JSON.stringify(a)); return a; }
  artifacts(issueId) { return this.db.prepare('SELECT data FROM artifacts WHERE issue_id=? ORDER BY rowid').all(issueId).map(r=>JSON.parse(r.data)); }
  enqueue(i,type) { const j={id:id(),issueId:i.id,type,status:'queued',attempt:0,createdAt:now(),inputRefs:{...i.refs},baselineSha:i.baselineSha,repositoryId:i.repositoryId}; this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(j.id,i.id,type,j.status,JSON.stringify(j)); this.event(i.id,'job_queued',{jobId:j.id,type,inputRefs:j.inputRefs}); return j; }
  saveJob(j) { this.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(j.status,JSON.stringify(j),j.id); }
  create(body) {
    const i={id:id(),title:body.title,description:body.description,repositoryId:body.repositoryId,baselineSha:body.baselineSha,state:'clarification',version:1,refs:{},rounds:{plan:0,prototype:0,implementation:0},createdAt:now(),updatedAt:now()};
    this.db.prepare('INSERT INTO issues VALUES(?,?,?,?)').run(i.id,i.version,i.state,JSON.stringify(i)); this.event(i.id,'issue_created');
    return {issue:i,agentToken:this.mint({issueId:i.id,ops:['read','plan','reason']})};
  }
  submitPlan(issueId,b) { const i=this.issue(issueId); this.expected(i,b.expectedIssueVersion); requireThat(i.state==='clarification','invalid_state'); requireThat(i.rounds.plan<3,'round_limit'); const a=this.artifact(i,'plan',{prd:b.prd,slices:b.slices,acceptanceCriteria:b.acceptanceCriteria}); i.refs.plan=a.id; i.rounds.plan++; this.save(i,'plan_review'); this.enqueue(i,'plan_review'); return {issue:i,artifact:a}; }
  checkpoint(i,kind) { const c={id:id(),checkpointId:null,issueId:i.id,kind,status:'pending',artifactRefs:{...i.refs},createdAt:now(),decision:null,allowedActions:kind==='final'?[]:['approve','reject']}; c.checkpointId=c.id;
    this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?)').run(c.id,i.id,JSON.stringify(c)); i.checkpointId=c.id; this.save(i,kind==='final'?'awaiting_final_review':`awaiting_${kind}_approval`); return c; }
  saveCheckpoint(c) { this.db.prepare('UPDATE checkpoints SET data=? WHERE id=?').run(JSON.stringify(c),c.id); }
  decision(checkpointId,b,sessionId) {
    const c=this.row('checkpoints',checkpointId),i=this.issue(c.issueId); this.expected(i,b.expectedIssueVersion);
    requireThat(c.status==='pending' && i.checkpointId===c.id,'checkpoint_not_current'); requireThat(c.allowedActions.includes(b.decision),'decision_not_allowed'); requireThat(JSON.stringify(c.artifactRefs)===JSON.stringify(b.artifactRefs),'stale_artifact_binding');
    c.decision={id:id(),decision:b.decision,sessionId,time:now(),artifactRefs:c.artifactRefs}; c.status='decided'; this.saveCheckpoint(c); this.event(i.id,'human_decision',{checkpointId:c.id,...c.decision});
    if(b.decision==='reject') { i.rejectedCheckpointId=c.id; this.save(i,'awaiting_rejection_reason'); }
    else if(c.kind==='plan') { i.refs.approvedPlan=i.refs.plan; this.save(i,'prototype_queued'); this.enqueue(i,'prototype'); }
    else { i.refs.approvedPrototype=i.refs.prototype; this.save(i,'implementation_queued'); this.enqueue(i,'implementation'); }
    return {checkpoint:c,issue:i};
  }
  reason(checkpointId,b) { const c=this.row('checkpoints',checkpointId),i=this.issue(c.issueId); this.expected(i,b.expectedIssueVersion); requireThat(i.state==='awaiting_rejection_reason' && i.rejectedCheckpointId===c.id && c.decision?.id===b.decisionId,'invalid_rejection');
    const a=this.artifact(i,'rejection_reason',{checkpointId:c.id,decisionId:b.decisionId,reason:b.reason}); i.refs.feedback=a.id; this.event(i.id,'rejection_reason_received',{checkpointId:c.id});
    if(c.kind==='plan') { if(i.rounds.plan>=3)i.pauseReason='plan_round_limit'; this.save(i,i.rounds.plan>=3?'paused':'clarification'); }
    else if(i.rounds.prototype>=3) { i.pauseReason='prototype_round_limit'; this.save(i,'paused'); }
    else { this.save(i,'prototype_queued'); this.enqueue(i,'prototype'); } return {issue:i,artifact:a};
  }
  reserve(workerId) { return this.tx(()=>{ const slot=this.db.prepare('SELECT slot FROM slots WHERE job_id IS NULL ORDER BY slot LIMIT 1').get(); if(!slot)return null;
    const row=this.db.prepare("SELECT data FROM jobs WHERE status='queued' AND issue_id NOT IN(SELECT issue_id FROM jobs WHERE status='running') ORDER BY rowid LIMIT 1").get(); if(!row)return null;
    const j=JSON.parse(row.data),i=this.issue(j.issueId); j.status='running'; j.attempt++; j.reservation={id:id(),workerId,slot:slot.slot,leaseExpiry:now()+60000,startedAt:now()};
    this.db.prepare('UPDATE slots SET job_id=? WHERE slot=?').run(j.id,slot.slot); this.saveJob(j); this.save(i,j.type==='prototype'?'prototype_running':j.type==='implementation'?'implementation_running':i.state);
    const token=this.mint({issueId:i.id,reservationId:j.reservation.id,ops:['reservation','read']},24*3600000); this.event(i.id,'job_reserved',{jobId:j.id,reservation:j.reservation});
    return {job:j,issue:i,artifacts:this.artifacts(i.id),reservationToken:token}; }); }
  reservation(rid) { const rows=this.db.prepare("SELECT data FROM jobs WHERE status='running'").all(); const j=rows.map(r=>JSON.parse(r.data)).find(j=>j.reservation.id===rid); requireThat(j,'reservation_inactive'); requireThat(j.reservation.leaseExpiry>now(),'lease_expired'); return j; }
  heartbeat(rid) { return this.tx(()=>{const j=this.reservation(rid);j.reservation.leaseExpiry=now()+60000;this.saveJob(j);return j.reservation;}); }
  release(j,status) { j.status=status;j.finishedAt=now();this.saveJob(j);this.db.prepare('UPDATE slots SET job_id=NULL WHERE job_id=?').run(j.id); }
  result(rid,b) { const j=this.reservation(rid),i=this.issue(j.issueId); requireThat(JSON.stringify(j.inputRefs)===JSON.stringify(b.inputRefs),'stale_input_refs'); requireThat(allowed[j.type].includes(b.outcome),'invalid_outcome',400);
    if(['prototype','implementation'].includes(j.type) && b.outcome!=='blocked') { requireThat(b.commitSha && b.branch && b.worktree && b.checks?.every(c=>c.commitSha===b.commitSha),'missing_commit_evidence',400); if(j.type==='prototype') requireThat(b.prUrl,'draft_pr_required',400); }
    this.release(j,'completed'); j.result=b; this.saveJob(j); const a=this.artifact(i,j.type,{...b,jobId:j.id,attempt:j.attempt}); i.refs[j.type]=a.id; this.event(i.id,'job_completed',{jobId:j.id,outcome:b.outcome,rationale:b.rationale});
    if(b.outcome==='blocked' || b.outcome==='needs_human_input') { i.pauseReason=b.rationale; i.resumeJobType=j.type; this.save(i,'paused'); }
    else if(j.type==='plan_review') { if(b.outcome==='pass') this.checkpoint(i,'plan'); else {i.pauseReason=i.rounds.plan>=3?'plan_round_limit':undefined;this.save(i,i.rounds.plan>=3?'paused':'clarification');} }
    else if(j.type==='prototype') { i.rounds.prototype++;this.checkpoint(i,'prototype'); }
    else if(j.type==='implementation') { i.rounds.implementation++;this.save(i,'code_review');this.enqueue(i,'code_review'); }
    else if(b.outcome==='pass') this.checkpoint(i,'final');
    else if(i.rounds.implementation>=3) {i.pauseReason='implementation_round_limit';this.save(i,'paused');}
    else {this.save(i,'implementation_queued');this.enqueue(i,'implementation');}
    return {issue:i,artifact:a};
  }
  failure(rid,b) { const j=this.reservation(rid),i=this.issue(j.issueId);j.errors=[...(j.errors||[]),{...b,time:now()}];this.release(j,'failed');this.event(i.id,'job_failed',{jobId:j.id,...b});
    if(b.transient===true && b.sideEffectsReconciled===true && j.attempt<2) {j.status='queued';delete j.reservation;this.saveJob(j);this.save(i,j.type==='prototype'?'prototype_queued':j.type==='implementation'?'implementation_queued':j.type);}
    else {i.pauseReason=b.message;i.resumeJobType=j.type;this.save(i,'paused');}return {issue:i,job:j}; }
  recover(all=false) { return this.tx(()=>{const rows=this.db.prepare("SELECT data FROM jobs WHERE status='running'").all();for(const row of rows){const j=JSON.parse(row.data);if(!all && j.reservation.leaseExpiry>now())continue;const i=this.issue(j.issueId);j.interruptions=[...(j.interruptions||[]),{reservation:j.reservation,time:now()}];this.release(j,'interrupted');this.event(i.id,'reservation_interrupted',{jobId:j.id,attempt:j.attempt});
      if(j.attempt<2){j.status='queued';delete j.reservation;this.saveJob(j);this.save(i,j.type==='prototype'?'prototype_queued':j.type==='implementation'?'implementation_queued':j.type);this.event(i.id,'automatic_retry_queued',{jobId:j.id,reason:'interrupted_execution'});}
      else {i.pauseReason='interrupted_execution_retries_exhausted';i.resumeJobType=j.type;this.save(i,'paused');}
    }}); }
  resume(issueId,b) { const i=this.issue(issueId);this.expected(i,b.expectedIssueVersion);requireThat(i.state==='paused' && i.resumeJobType,'not_resumable');requireThat(b.sideEffectsReconciled===true,'reconciliation_required',400);const t=i.resumeJobType;delete i.pauseReason;delete i.resumeJobType;this.save(i,t==='prototype'?'prototype_queued':t==='implementation'?'implementation_queued':t);this.enqueue(i,t);return {issue:i}; }
  list() {return this.db.prepare('SELECT data FROM issues ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data));}
  jobs(issueId) {return this.db.prepare('SELECT data FROM jobs WHERE issue_id=? ORDER BY rowid').all(issueId).map(r=>JSON.parse(r.data));}
  events(issueId,after=0) {return this.db.prepare('SELECT * FROM events WHERE issue_id=? AND seq>? ORDER BY seq').all(issueId,after).map(r=>({sequence:r.seq,time:r.time,...JSON.parse(r.data)}));}
  summary() {return {capacity:3,busy:this.db.prepare('SELECT COUNT(*) AS n FROM slots WHERE job_id IS NOT NULL').get().n,queued:this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'").get().n};}
}
