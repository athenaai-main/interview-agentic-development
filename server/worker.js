import { Codex } from '@openai/codex-sdk';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runtime, git, exec } from './runtime.js';
const origin=process.env.FACTORY_URL||'http://127.0.0.1:4310',dataDir=resolve(process.env.FACTORY_DATA_DIR||'.factory');
const credentials=JSON.parse(await readFile(resolve(dataDir,'credentials.json'),'utf8'));
let stopping=false;const controllers=new Set();for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{stopping=true;for(const c of controllers)c.abort();});
async function api(path,token,body,key=randomUUID()){const r=await fetch(origin+'/api/v1'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});if(r.status===204)return null;const d=await r.json();if(!r.ok)throw Error(`${d.code}: ${d.message}`);return d;}
const outcomes={plan_review:['pass','needs_clarification'],prototype:['ready_for_review','blocked'],implementation:['ready_for_code_review','blocked'],code_review:['pass','needs_revision','needs_human_input']};
function schema(type){return {type:'object',properties:{outcome:{type:'string',enum:outcomes[type]},rationale:{type:'string'},summary:{type:'string'},findings:{type:'array',items:{type:'string'}}},required:['outcome','rationale','summary','findings'],additionalProperties:false};}
function cleanEnvironment(){const env={};for(const [k,v]of Object.entries(process.env))if(!/^(FACTORY_|GITHUB_TOKEN$|GH_TOKEN$)/.test(k)&&typeof v==='string')env[k]=v;return env;}
async function runTask(r) {
  const {job:j,issue:i,reservationToken:token}=r,rid=j.reservation.id;
  const rt=new Runtime({repositories:{[i.repositoryId]:r.repository}},r.dataDir),review=j.type==='plan_review'||j.type==='code_review';
  const implementation=r.artifacts.find(a=>a.id===j.inputRefs.implementation);
  let wt;
  if(j.type==='code_review')wt=await rt.reviewTree(i,implementation.commitSha);
  else if(j.type==='plan_review')wt=await rt.worktree(i,'baseline');
  else wt=await rt.worktree(i,j.type);
  // Every retry reuses the issue-owned checkout and reconciles its actual Git state.
  // The agent loop itself cannot publish; only this worker's explicit publish step can.
  const lock=wt.path+'.execution-lock';
  try{await mkdir(lock);await writeFile(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid,reservationId:rid}));}
  catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(await readFile(resolve(lock,'owner.json'),'utf8'));}catch{throw Error('Interrupted execution: worktree lock could not be reconciled');}
    let alive=true;try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    if(alive)throw Error('Interrupted execution: previous worker still owns the worktree');
    await rm(lock,{recursive:true});await mkdir(lock);await writeFile(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid,reservationId:rid}));
  }
  const model=j.type==='implementation'?'gpt-6-luna':'gpt-6.1-sol';
  const abort=new AbortController();controllers.add(abort);let heartbeatError;const deadline=setTimeout(()=>abort.abort(new Error('Autonomous execution timeout')),10*60000);
  const heart=setInterval(()=>api(`/reservations/${rid}/heartbeat`,token,{}).catch(e=>{heartbeatError=e;abort.abort();}),15000);
  try {
    const codex=new Codex({env:cleanEnvironment(),...(process.env.FACTORY_CODEX_PATH?{codexPathOverride:process.env.FACTORY_CODEX_PATH}:{})});
    const options={model,modelReasoningEffort:'medium',workingDirectory:wt.path,sandboxMode:review?'read-only':'workspace-write',approvalPolicy:'never',networkAccessEnabled:false,webSearchMode:'disabled'};
    // An interrupted turn is not blindly replayed as a remote publishing operation. A fresh
    // turn reconciles local changes using persisted job artifacts and prior provider identity.
    const thread=codex.startThread(options);
    const prompt=`You are performing ${j.type} for a local software factory. Use exactly the provided task outcome schema.\nIssue: ${JSON.stringify(i)}\nInput manifest: ${JSON.stringify(j.inputRefs)}\nArtifacts: ${JSON.stringify(r.artifacts)}\nPrior provider: ${JSON.stringify(j.provider||null)}\nExecution attempt ${j.attempt}; interrupted attempts: ${JSON.stringify(j.interruptions||[])}. Inspect actual worktree before continuing. Do not push, create PRs, merge, deploy, change other checkouts, or interact with human decision controls. Worker owns Git commit/check/publication operations.\n${review?'Review only. Challenge requirements/slices for planning review; for code review compare exact implementation commit to original baseline and approved plan, including check evidence. Pass only with no actionable findings.':'Implement the requested small web change in this checkout. '+(j.type==='implementation'?'Start from the original baseline on this separate branch. Use approved prototype as reference; do not merge it automatically.':'Create a usable prototype of the approved plan.')}\nReturn rationale and concrete findings. If blocked, select the allowed blocked/human-input outcome.`;
    const {events}=await thread.runStreamed(prompt,{outputSchema:schema(j.type),signal:abort.signal});let output='',usage=null;
    for await(const event of events){if(event.type==='thread.started')await api(`/reservations/${rid}/provider`,token,{threadId:event.thread_id,model});if(event.type==='item.completed'&&event.item.type==='agent_message')output=event.item.text;if(event.type==='turn.completed')usage=event.usage;if(event.type==='turn.failed'||event.type==='error')throw Error(event.error?.message||event.message);}
    if(heartbeatError)throw heartbeatError;
    const result={...JSON.parse(output),inputRefs:j.inputRefs,providerThreadId:thread.id,usage};
    if(!outcomes[j.type].includes(result.outcome))throw Error('Unexpected model outcome');
    await api(`/reservations/${rid}/heartbeat`,token,{});
    if(!review && result.outcome!=='blocked') {
      if(await git(wt.path,'status','--porcelain')){await git(wt.path,'add','--all');await git(wt.path,'commit','-m',`Factory ${j.type}: ${i.title}`);}
      result.commitSha=await git(wt.path,'rev-parse','HEAD');result.branch=wt.branch;result.worktree=wt.path;
      const command=r.repository.checkCommand;if(!command)throw Error('Repository checkCommand required');
      let check;try{const c=await exec('/bin/sh',['-c',command],{cwd:wt.path,timeout:120000,maxBuffer:4*1024*1024});check={exitCode:0,output:c.stdout+c.stderr};}catch(e){check={exitCode:Number.isInteger(e.code)?e.code:1,output:(e.stdout||'')+(e.stderr||'')+e.message};}
      result.checks=[{command,commitSha:result.commitSha,...check}];
      if(j.type==='prototype') {
        if(!r.repository.publishDraftPr){result.outcome='blocked';result.rationale='Prototype is committed locally. Draft PR publishing is disabled; explicitly enable publishDraftPr in trusted repository configuration to continue.';}
        else {
          const repo=r.repository.githubRepository;if(!repo)throw Error('githubRepository is required for draft PR');
          // Find by deterministic branch before creation, including on retry.
          await exec('git',['push','-u','origin',wt.branch],{cwd:wt.path});
          const {stdout}=await exec('gh',['pr','list','--repo',repo,'--head',wt.branch,'--state','open','--json','url,isDraft'],{cwd:wt.path});const found=JSON.parse(stdout)[0];
          if(found&&!found.isDraft)throw Error('Existing PR is not draft');
          if(found)result.prUrl=found.url;
          else {const bodyPath=resolve(r.dataDir,`${j.id}-pr-body.md`);const {writeFile}=await import('node:fs/promises');await writeFile(bodyPath,result.summary);result.prUrl=(await exec('gh',['pr','create','--repo',repo,'--draft','--head',wt.branch,'--title',`Prototype: ${i.title}`,'--body-file',bodyPath],{cwd:wt.path})).stdout.trim();}
        }
      }
    }
    if(j.type==='code_review')result.commitSha=implementation.commitSha;
    // Retry a disconnected submission with the same identity. Never rerun inference here.
    const key=`result-${j.id}-${j.attempt}`;for(let n=0;n<2;n++){try{await api(`/reservations/${rid}/result`,token,result,key);return;}catch(e){if(n)throw e;await new Promise(r=>setTimeout(r,1000));}}
  }finally{clearInterval(heart);clearTimeout(deadline);controllers.delete(abort);await rm(lock,{recursive:true,force:true});}
}
async function loop(workerId){while(!stopping){let r;try{r=await api('/worker/reservations',credentials.workerToken,{workerId});if(!r){await new Promise(r=>setTimeout(r,1000));continue;}console.log(`[${workerId}] ${r.job.type} ${r.issue.id} attempt ${r.job.attempt}`);await runTask(r);}catch(e){console.error(`[${workerId}] ${e.message}`);if(r){try{const transient=/timeout|ECONNRESET|429|503|aborted|interrupt/i.test(e.message);await api(`/reservations/${r.job.reservation.id}/failure`,r.reservationToken,{message:e.message,transient,sideEffectsReconciled:transient},`failure-${r.job.id}-${r.job.attempt}`);}catch(report){console.error(report.message);}}else await new Promise(r=>setTimeout(r,2000));}}}
const count=Number(process.env.FACTORY_WORKERS||3);if(!Number.isInteger(count)||count<1||count>3)throw Error('FACTORY_WORKERS must be 1..3');await Promise.all(Array.from({length:count},(_,n)=>loop(`worker-${process.pid}-${n+1}`)));
