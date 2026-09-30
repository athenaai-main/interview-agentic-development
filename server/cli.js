import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec, git } from './runtime.js';
const origin=process.env.FACTORY_URL||'http://127.0.0.1:4310',dataDir=resolve(process.env.FACTORY_DATA_DIR||'.factory');
const args=process.argv.slice(2);
async function request(path,{body,token,method}={}){const r=await fetch(origin+'/api/v1'+path,{method:method||(body?'POST':'GET'),headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}: {})},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;}
async function credential(){return JSON.parse(await readFile(resolve(dataDir,'credentials.json'),'utf8'));}
try {
if(args[0]==='demo-setup') {
 const path=resolve(dataDir,'demo-app');await mkdir(path,{recursive:true});
 try{await git(path,'rev-parse','HEAD');}catch{await exec('git',['init','-b','main',path]);await writeFile(resolve(path,'app.js'),`import {createServer} from 'node:http';\ncreateServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Task board</title><h1>Task board</h1><p>Nothing here yet.</p>');}).listen(Number(process.env.PORT||4200),'127.0.0.1');\n`);await writeFile(resolve(path,'.gitignore'),'node_modules/\n');await git(path,'add','.');await git(path,'-c','user.name=Factory Demo','-c','user.email=factory@localhost','commit','-m','Demo baseline');}
 const configPath=resolve('factory.config.json');let config;try{config=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;config={repositories:{}};}
 config.repositories.demo={path,startCommand:'node app.js',checkCommand:'node --check app.js',readinessPath:'/',publishDraftPr:false};await writeFile(configPath,JSON.stringify(config,null,2));console.log(`Created local demo repository ${path}. Restart server to load configuration. Draft PR publication is disabled; use a configured GitHub target for full workflow.`);
}else if(args[0]==='intake') {const input=JSON.parse(await readFile(args[1],'utf8'));const c=await credential();const out=await request('/issues',{body:input,token:c.operatorToken});await writeFile(resolve(dataDir,`${out.issue.id}.token`),out.agentToken,{mode:0o600});console.log(JSON.stringify(out,null,2));}
else if(args[0]==='issues') {const c=await credential();console.log(JSON.stringify(await request('/issues',{token:c.operatorToken}),null,2));}
else {const token=process.env.FACTORY_AGENT_TOKEN;if(!token)throw Error('Set FACTORY_AGENT_TOKEN to the scoped token returned by intake or issued by the human session.');
 if(args[0]==='plan')console.log(JSON.stringify(await request(`/issues/${args[1]}/plans`,{token,body:JSON.parse(await readFile(args[2],'utf8'))}),null,2));
 else if(args[0]==='issue')console.log(JSON.stringify(await request(`/issues/${args[1]}`,{token}),null,2));
 else if(args[0]==='reason')console.log(JSON.stringify(await request(`/checkpoints/${args[1]}/rejection-reason`,{token,body:JSON.parse(await readFile(args[2],'utf8'))}),null,2));
 else if(args[0]==='checkpoint'&&args[1]==='wait') {for(;;){const d=await request(`/checkpoints/${args[2]}/decision?waitSeconds=25`,{token});if(d.status==='decided'){console.log(JSON.stringify(d,null,2));break;}if(d.allowedActions?.length===0){console.log(JSON.stringify({status:'read_only',checkpointId:args[2]}));break;}await new Promise(r=>setTimeout(r,1000));}}
 else throw Error('Commands: demo-setup | intake <json> | issues | issue <id> | plan <issueId> <json> | reason <checkpointId> <json> | checkpoint wait <id>');
}
}catch(e){console.error(e.message);process.exitCode=1;}
