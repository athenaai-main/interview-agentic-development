import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store, secret } from './store.js';
import { Runtime } from './runtime.js';
import { createApp } from './app.js';
const dataDir=resolve(process.env.FACTORY_DATA_DIR||'.factory');await mkdir(dataDir,{recursive:true,mode:0o700});await chmod(dataDir,0o700);
const configPath=resolve(process.env.FACTORY_CONFIG||'factory.config.json');let config;
try{config=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;config={repositories:{}};console.log('No factory.config.json: run npm run factory -- demo-setup or copy factory.config.example.json.');}
const credentialsPath=resolve(dataDir,'credentials.json');let credentials;
try{credentials=JSON.parse(await readFile(credentialsPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;credentials={operatorToken:secret(),workerToken:secret()};await writeFile(credentialsPath,JSON.stringify(credentials,null,2),{mode:0o600});}
const port=Number(process.env.PORT||4310),origin=`http://127.0.0.1:${port}`,pairingCode=secret().slice(0,12);
const store=new Store(resolve(dataDir,'factory.sqlite'));store.recover(true);const runtime=new Runtime(config,dataDir,store);const app=createApp({store,runtime,...credentials,pairingCode,origin});
const server=app.listen(port,'127.0.0.1',()=>console.log(`Factory: ${origin}\nHuman pairing code (10 minutes): ${pairingCode}\nCLI credentials: ${credentialsPath}\nWorkers: npm run worker (starts three local workers)`));
const timer=setInterval(()=>store.recover(),5000);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);runtime.stopAll();server.close(()=>{store.close();process.exit(0);});});
