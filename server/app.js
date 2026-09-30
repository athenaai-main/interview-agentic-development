import express from 'express';
import { z } from 'zod';
import { Fault, requireThat, secret, id } from './store.js';
import { readFile } from 'node:fs/promises';
import { git } from './runtime.js';
const text=z.string().trim().min(1).max(100000),version=z.number().int().positive(),refs=z.record(z.string(),z.string());
const plan=z.object({expectedIssueVersion:version,prd:text,slices:z.array(z.object({title:text,description:text})).min(1),acceptanceCriteria:z.array(text).min(1)});
const result=z.object({inputRefs:refs,outcome:text,rationale:text,summary:text,commitSha:z.string().optional(),branch:z.string().optional(),worktree:z.string().optional(),prUrl:z.string().url().optional(),checks:z.array(z.object({command:text,exitCode:z.number().int(),commitSha:text,output:z.string()})).optional(),findings:z.array(text).optional(),providerThreadId:z.string().optional(),usage:z.record(z.string(),z.number()).nullable().optional()});
export function createApp({store,runtime,operatorToken,workerToken,pairingCode,origin='http://127.0.0.1:4310'}) {
  const app=express();let pair=pairingCode,pairExpires=Date.now()+10*60000;
  app.use((req,res,next)=>{if(req.headers.host && req.headers.host!==new URL(origin).host){return res.status(403).json({code:'invalid_host'});}res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
  app.use(express.json({limit:'1mb'}));
  const bearer=req=>req.headers.authorization?.replace(/^Bearer /,'')||'';
  function human(req,mutation=false) {requireThat(!req.headers.authorization,'human_session_required',403);const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('factory_session='))?.slice(16);const t=store.auth(cookie,'human');if(mutation){requireThat(req.headers.origin===origin,'invalid_origin',403);requireThat(req.headers['x-csrf-token']===t.csrf,'invalid_csrf',403);}return t;}
  function reader(req,issueId) {if(req.headers.authorization)return store.auth(bearer(req),'read',issueId);return human(req);}
  function operator(req) {requireThat(bearer(req)===operatorToken,'operator_required',403);}
  function reservation(req,rid) {const t=store.auth(bearer(req),'reservation');requireThat(t.reservationId===rid,'wrong_reservation',403);return t;}
  const once=(req,scope,b,fn)=>store.once(scope,req.headers['idempotency-key'],b,fn);
  const route=(method,path,fn)=>app[method](path,async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}});
  const checkpoint=async(cid)=>{const c=store.row('checkpoints',cid),i=store.issue(c.issueId);const bound=JSON.stringify(c.artifactRefs)===JSON.stringify(i.refs);
    let current=c.status==='pending' && i.checkpointId===cid && bound;
    if(current && c.kind!=='plan'){const a=store.row('artifacts',c.kind==='final'?c.artifactRefs.implementation:c.artifactRefs.prototype);try{current=await git(a.worktree,'rev-parse','HEAD')===a.commitSha && !(await git(a.worktree,'status','--porcelain'));}catch{current=false;}}
    const previews=runtime.snapshot(i.id);if(current && c.kind!=='plan')current=previews.baseline?.status==='ready' && previews.candidate?.status==='ready';
    const failures=Object.entries(previews).filter(([,p])=>p?.startupError).map(([label,p])=>`Preview startup failure (${label}), exact commit ${p.commitSha}: ${p.startupError}. Log: ${p.logPath}. Diagnose in ${p.path}, preserve the reviewed commit, then restart previews via the human session. If source changes are needed, do not approve this revision.`).join('\n');
    return {...c,status:c.status==='pending'&&!current?'unavailable':c.status,issueVersion:i.version,allowedActions:current?c.allowedActions:[],previews,artifacts:store.artifacts(i.id),harnessPrompt:`${failures ? failures+'\n' : ''}Issue ${i.id}, checkpoint ${cid}. Open ${origin}/checkpoints/${cid}. The human must personally review and click the controls. Run npm run factory -- checkpoint wait ${cid}. If rejected, ask the human why and submit the explanation with decisionId. Retrieve current issue version before mutation. Final review is read-only.`};};
  route('get','/api/v1/health',async(req,res)=>res.json({status:'ok',...store.summary()}));
  route('post','/api/v1/auth/pairing/complete',async(req,res)=>{requireThat(req.headers.origin===origin,'invalid_origin',403);requireThat(pair && req.body.code===pair && Date.now()<pairExpires,'invalid_pairing',403);const csrf=secret(),sessionId=id(),token=store.mint({ops:['human'],csrf,sessionId},24*3600000);pair=null;res.setHeader('Set-Cookie',`factory_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);res.json({csrf,sessionId});});
  route('get','/api/v1/auth/session',async(req,res)=>{const t=human(req);res.json({csrf:t.csrf,sessionId:t.sessionId});});
  route('get','/api/v1/issues',async(req,res)=>{if(req.headers.authorization)operator(req);else human(req);res.json({issues:store.list(),workers:store.summary()});});
  route('post','/api/v1/issues',async(req,res)=>{operator(req);const b=z.object({title:text,description:text,repositoryId:text,baselineRevision:text}).parse(req.body);const baselineSha=await runtime.baseline(b.repositoryId,b.baselineRevision);res.status(201).json(once(req,'intake',b,()=>store.create({...b,baselineSha})));});
  route('get','/api/v1/issues/:id',async(req,res)=>{reader(req,req.params.id);const i=store.issue(req.params.id);res.json({...i,artifacts:store.artifacts(i.id),jobs:store.jobs(i.id),events:store.events(i.id),previews:runtime.snapshot(i.id)});});
  route('get','/api/v1/issues/:id/events',async(req,res)=>{reader(req,req.params.id);const after=z.coerce.number().int().nonnegative().parse(req.query.after||0);res.json(store.events(req.params.id,after));});
  route('post','/api/v1/issues/:id/plans',async(req,res)=>{store.auth(bearer(req),'plan',req.params.id);const b=plan.parse(req.body);res.json(once(req,`plan:${req.params.id}`,b,()=>store.submitPlan(req.params.id,b)));});
  route('post','/api/v1/issues/:id/agent-tokens',async(req,res)=>{human(req,true);store.issue(req.params.id);const b=z.object({operations:z.array(z.enum(['read','plan','reason'])).min(1)}).parse(req.body);res.json(once(req,`token:${req.params.id}`,b,()=>({agentToken:store.mint({issueId:req.params.id,ops:b.operations})})));});
  route('get','/api/v1/checkpoints/:id',async(req,res)=>{const c=store.row('checkpoints',req.params.id);reader(req,c.issueId);res.json(await checkpoint(c.id));});
  route('get','/api/v1/checkpoints/:id/decision',async(req,res)=>{const c=store.row('checkpoints',req.params.id);reader(req,c.issueId);const seconds=z.coerce.number().min(0).max(25).parse(req.query.waitSeconds||0);let deadline=Date.now()+seconds*1000;let current=c;while(!current.decision && Date.now()<deadline && !res.destroyed){await new Promise(r=>setTimeout(r,200));current=store.row('checkpoints',c.id);}if(res.destroyed)return;res.json(current.decision?{status:'decided',checkpointId:c.id,...current.decision,requiresRejectionReason:current.decision.decision==='reject',issueVersion:store.issue(c.issueId).version}:{status:'pending',retryAfterMs:1000,allowedActions:current.allowedActions});});
  route('post','/api/v1/checkpoints/:id/decision',async(req,res)=>{const h=human(req,true);const b=z.object({decision:z.enum(['approve','reject']),expectedIssueVersion:version,artifactRefs:refs}).parse(req.body);const c=await checkpoint(req.params.id);const scope=`decision:${c.id}`;
    // A stored idempotent response remains retrievable even after the checkpoint moved on.
    const old=store.db.prepare('SELECT key FROM idempotency WHERE scope=? AND key=?').get(scope,req.headers['idempotency-key']||'');
    if(!old)requireThat(c.allowedActions.includes(b.decision),'checkpoint_unavailable');const out=once(req,scope,b,()=>store.decision(c.id,b,h.sessionId));if(b.decision==='reject' && c.kind==='prototype')runtime.stopIssue(c.issueId);res.json(out);});
  route('post','/api/v1/checkpoints/:id/rejection-reason',async(req,res)=>{const c=store.row('checkpoints',req.params.id);store.auth(bearer(req),'reason',c.issueId);const b=z.object({decisionId:text,reason:text,expectedIssueVersion:version}).parse(req.body);res.json(once(req,`reason:${c.id}`,b,()=>store.reason(c.id,b)));});
  route('post','/api/v1/issues/:id/resume',async(req,res)=>{human(req,true);const b=z.object({expectedIssueVersion:version,sideEffectsReconciled:z.literal(true)}).parse(req.body);res.json(once(req,`resume:${req.params.id}`,b,()=>store.resume(req.params.id,b)));});
  route('post','/api/v1/worker/reservations',async(req,res)=>{requireThat(bearer(req)===workerToken,'worker_required',403);store.recover();const b=z.object({workerId:text}).parse(req.body);const r=store.reserve(b.workerId);if(!r)return res.sendStatus(204);res.json({...r,repository:runtime.repo(r.issue.repositoryId),dataDir:runtime.dataDir});});
  route('post','/api/v1/reservations/:id/heartbeat',async(req,res)=>{reservation(req,req.params.id);res.json(store.heartbeat(req.params.id));});
  route('post','/api/v1/reservations/:id/provider',async(req,res)=>{reservation(req,req.params.id);const b=z.object({threadId:text,model:z.enum(['gpt-6-luna','gpt-6.1-sol'])}).parse(req.body);res.json(store.tx(()=>{const j=store.reservation(req.params.id);j.provider=b;store.saveJob(j);store.event(j.issueId,'provider_started',b);return b;}));});
  route('post','/api/v1/reservations/:id/result',async(req,res)=>{reservation(req,req.params.id);const b=result.parse(req.body),scope=`result:${req.params.id}`;const old=store.db.prepare('SELECT key FROM idempotency WHERE scope=? AND key=?').get(scope,req.headers['idempotency-key']||'');
    if(!old){const j=store.reservation(req.params.id),i=store.issue(j.issueId);
      if(['prototype','implementation'].includes(j.type)&&b.outcome!=='blocked')await runtime.verify(i,b);
      if(j.type==='prototype'&&b.outcome==='ready_for_review')await runtime.ensurePreviews(i,b);
      if(j.type==='code_review'&&b.outcome==='pass'){const a=store.row('artifacts',j.inputRefs.implementation);await runtime.verify(i,a);requireThat(a.checks?.length>0&&a.checks.every(c=>c.exitCode===0),'checks_not_passing');requireThat(b.commitSha===a.commitSha,'review_commit_mismatch');await runtime.ensurePreviews(i,a);}
    }res.json(once(req,scope,b,()=>store.result(req.params.id,b)));});
  route('post','/api/v1/reservations/:id/failure',async(req,res)=>{reservation(req,req.params.id);const b=z.object({message:text,transient:z.boolean(),sideEffectsReconciled:z.boolean()}).parse(req.body);res.json(once(req,`failure:${req.params.id}`,b,()=>store.failure(req.params.id,b)));});
  route('post','/api/v1/issues/:id/previews/restart',async(req,res)=>{human(req,true);const i=store.issue(req.params.id);requireThat(['awaiting_prototype_approval','awaiting_final_review'].includes(i.state),'invalid_state');const a=store.row('artifacts',i.state==='awaiting_final_review'?i.refs.implementation:i.refs.prototype);await runtime.verify(i,a);res.json(await runtime.ensurePreviews(i,a));});
  route('get','/',async(req,res)=>res.type('html').send(await readFile(new URL('./review.html',import.meta.url),'utf8')));
  route('get','/checkpoints/:id',async(req,res)=>res.type('html').send(await readFile(new URL('./review.html',import.meta.url),'utf8')));
  app.use((e,req,res,next)=>{if(res.headersSent)return next(e);const status=e instanceof z.ZodError?400:e.status||500;res.status(status).json({code:e instanceof z.ZodError?'invalid_request':e.code||'execution_error',message:e.message,details:e instanceof z.ZodError?e.issues:undefined});});
  return app;
}
