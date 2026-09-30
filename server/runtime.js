import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { requireThat } from './store.js';
export const exec = promisify(execFile);
export async function git(cwd,...args) { return (await exec('git',args,{cwd,maxBuffer:4*1024*1024})).stdout.trim(); }
export class Runtime {
  constructor(config,dataDir) { this.config=config;this.dataDir=resolve(dataDir);this.processes=new Map();this.previews=new Map(); }
  repo(key) {const r=this.config.repositories[key];requireThat(r,'unknown_repository',400);return r;}
  async baseline(key,revision) {const r=this.repo(key);const sha=await git(r.path,'rev-parse','--verify',`${revision}^{commit}`);requireThat(/^[a-f0-9]{40,64}$/.test(sha),'invalid_baseline',400);return sha;}
  async worktree(i,kind,commit) {
    const r=this.repo(i.repositoryId),path=join(this.dataDir,'worktrees',i.id,kind);await mkdir(join(this.dataDir,'worktrees',i.id),{recursive:true});
    const branch=`codex/factory-${i.id}-${kind}`;
    try { const metadata=JSON.parse(await readFile(`${path}.json`,'utf8'));requireThat(metadata.branch===(kind==='review'||kind==='baseline'?null:branch),'worktree_mismatch');requireThat(await git(path,'branch','--show-current')===(metadata.branch||''),'branch_mismatch');return metadata; }
    catch(e) {if(e.code!=='ENOENT')throw e;}
    if(kind==='review' || kind==='baseline') await git(r.path,'worktree','add','--detach',path,commit||i.baselineSha);
    else await git(r.path,'worktree','add','-b',branch,path,i.baselineSha);
    const metadata={path,branch:kind==='review'||kind==='baseline'?null:branch};await writeFile(`${path}.json`,JSON.stringify(metadata));return metadata;
  }
  async reviewTree(i,sha) {
    const p=join(this.dataDir,'worktrees',i.id,`review-${sha}`);await mkdir(join(this.dataDir,'worktrees',i.id),{recursive:true});
    try {await git(p,'rev-parse','HEAD');}catch {await git(this.repo(i.repositoryId).path,'worktree','add','--detach',p,sha);}
    requireThat(await git(p,'rev-parse','HEAD')===sha,'review_commit_mismatch');return {path:p};
  }
  async verify(i,result) {
    const base=await realpath(join(this.dataDir,'worktrees',i.id));const path=await realpath(result.worktree);requireThat(path.startsWith(`${base}/`),'unowned_worktree');
    requireThat(await git(path,'rev-parse','HEAD')===result.commitSha,'commit_changed');requireThat(await git(path,'branch','--show-current')===result.branch,'branch_changed');
    requireThat(!(await git(path,'status','--porcelain')),'dirty_worktree');await git(path,'merge-base','--is-ancestor',i.baselineSha,result.commitSha);
  }
  async port() {return new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
  async preview(i,label,path,sha) {
    const key=`${i.id}:${label}`,old=this.previews.get(key);if(old?.commitSha===sha && old.status==='ready')return old;this.stop(key);
    const r=this.repo(i.repositoryId),port=await this.port(),logPath=join(this.dataDir,`${i.id}-${label}-preview.log`);
    const m={url:`http://127.0.0.1:${port}`,commitSha:sha,status:'starting',startupError:null,port,path,logPath};this.previews.set(key,m);
    await writeFile(logPath,'');
    if(r.installCommand) {try {await exec('/bin/sh',['-c',r.installCommand],{cwd:path,timeout:120000,maxBuffer:4*1024*1024});}catch(e){m.status='failed';m.startupError=e.message;throw new Error(`${label} install failed: ${e.message}`);}}
    const child=spawn('/bin/sh',['-c',r.startCommand.replaceAll('{port}',String(port))],{cwd:path,env:{...process.env,PORT:String(port)},detached:true,stdio:['ignore','pipe','pipe']});this.processes.set(key,child);
    let log='';const capture=b=>{log=(log+b.toString()).slice(-12000);writeFile(logPath,log).catch(()=>{});};child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.on('error',e=>{m.status='failed';m.startupError=e.message;});child.on('exit',(code)=>{if(m.status!=='stopped'){m.status='failed';m.startupError=`Process exited (${code})\n${log}`;}});
    const deadline=Date.now()+30000;while(Date.now()<deadline && m.status!=='failed') {try {const response=await fetch(m.url+(r.readinessPath||'/'),{signal:AbortSignal.timeout(800)});if(response.ok){m.status='ready';return m;}}catch{}await new Promise(r=>setTimeout(r,200));}
    m.status='failed';m.startupError ||= `Preview readiness timed out\n${log}`;this.stop(key);m.status='failed';throw new Error(`${label} preview failed: ${m.startupError}`);
  }
  async ensurePreviews(i,result) {const baseline=await this.worktree(i,'baseline');return {baseline:await this.preview(i,'baseline',baseline.path,i.baselineSha),candidate:await this.preview(i,'candidate',result.worktree,result.commitSha)};}
  stop(key) {const child=this.processes.get(key);if(child){try{process.kill(-child.pid,'SIGTERM');}catch{}this.processes.delete(key);}const p=this.previews.get(key);if(p)p.status='stopped';}
  stopIssue(id) {this.stop(`${id}:candidate`);}
  stopAll() {for(const key of this.processes.keys())this.stop(key);}
  snapshot(issueId) {return {baseline:this.previews.get(`${issueId}:baseline`)||null,candidate:this.previews.get(`${issueId}:candidate`)||null};}
}
