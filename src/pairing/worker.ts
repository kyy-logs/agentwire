import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {optional,atomicBytes,jsonBytes,acquireLock,deadPid,withInstallLock} from '../installation/paths.ts';
import {notifyPairJob,settlePairNotification} from './notifications.ts';
import {withPairOperation} from './operations.ts';
import {spawnPairWorker} from './process.ts';
import {automationPath,readAutomation,listPairJobs,readPairJob,updatePairJob,updatePairJobLocked,jobAuthorized,terminalJob,automationLock} from './jobs.ts';
import {readPairState} from './store.ts';
import {executePairRequest} from './executor.ts';
import type {InstallContext} from '../installation/model.ts';import type {PairDeps} from './model.ts';

type WorkerDeps=PairDeps&{sleep?:(ms:number)=>Promise<void>;notify?:(c:InstallContext,id:string)=>Promise<void>;launch?:(args:string[])=>Promise<{pid:number}>;afterIdle?:()=>Promise<void>};
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function startLock(c:InstallContext){const file=await automationPath(c,'worker-start.lock');for(let n=0;;n++){try{return await acquireLock(file);}catch(e:any){if(e.message!=='installation_busy'||n>=40)throw e;await pause(25);}}}
export async function inspectPairWorker(c:InstallContext){
 const file=await automationPath(c,'worker.json'),bytes=await optional(file);if(!bytes)return {active:false};if(bytes.length>4096)throw Error('pairing_worker_invalid');const m=JSON.parse(bytes.toString());
 if(m.schemaVersion!==1||!Number.isSafeInteger(m.pid)||m.pid<=0||!['starting','accepting','closed'].includes(m.phase))throw Error('pairing_worker_invalid');return {schemaVersion:1,pid:m.pid,phase:m.phase,active:m.phase!=='closed'&&!deadPid(m.pid)};
}
export async function schedulePairWorker(c:InstallContext,deps:WorkerDeps={}){
 return withInstallLock(c,async()=>{const release=await startLock(c);try{if(!(await readAutomation(c)).enabled)throw Error('pairing_automation_disabled');const marker=await inspectPairWorker(c);if(marker.active)return marker;
  const args=['--experimental-strip-types',path.join(c.installRoot,'runtime','src','pairing','worker.ts'),'--root',c.installRoot];
  let child;try{child=await(deps.launch?deps.launch(args):spawnPairWorker(c));}catch(e:any){if(Number.isSafeInteger(e.startedPid)&&e.startedPid>0)await atomicBytes(await automationPath(c,'worker.json'),jsonBytes({schemaVersion:1,pid:e.startedPid,phase:'starting'}));throw e;}
  await atomicBytes(await automationPath(c,'worker.json'),jsonBytes({schemaVersion:1,pid:child.pid,phase:'starting'}));return {active:true,pid:child.pid};
 }finally{await release();}});
}
export async function runPairWorker(c:InstallContext,deps:WorkerDeps={}){
 const workFile=await automationPath(c,'worker.lock');let releaseWork;
 for(let n=0;;n++){try{releaseWork=await acquireLock(workFile);break;}catch(e:any){if(e.message!=='installation_busy'||n>=40)throw e;await pause(25);}}
 const mark=async(phase:string)=>atomicBytes(await automationPath(c,'worker.json'),jsonBytes({schemaVersion:1,pid:process.pid,phase}));
 try{
  const releaseStart=await startLock(c);try{await mark('accepting');}finally{await releaseStart();}
  let delay=200;
  for(;;){
   let waiting=false;const jobs=await listPairJobs(c);
   for(const original of jobs){
    let j=(await readPairJob(c,original.requestId))!;
    if(terminalJob(j)){if(j.result&&j.notification.phase==='pending'&&deps.notify)await deps.notify(c,j.requestId);continue;}
    if(!await jobAuthorized(c,j)){await updatePairJob(c,{...j,phase:'disabled',errorCode:'pairing_automation_disabled'});continue;}
    const now=+(deps.now?.()||new Date());
    // Already-started activation recovery is handled by the same executor before
    // expiry rejection; unverified/never-started jobs do not acquire new rights.
    if(now>=Date.parse(j.expiresAt)&&j.phase==='waiting_native'){await updatePairJob(c,{...j,phase:'failed',errorCode:'pairing_intent_expired',result:{ok:false,errorCode:'pairing_intent_expired'}});continue;}
    const result=await automationLock(c,async()=>{
     j=(await readPairJob(c,j.requestId))!;if(terminalJob(j))return j.result||{ok:false,errorCode:j.errorCode};
     if(!await jobAuthorized(c,j))return {ok:false,errorCode:'pairing_automation_disabled'};
     return executePairRequest(c,j.requestId,{...deps,beforeOperation:async intentId=>{j=await updatePairJobLocked(c,{...j,intentId,phase:'applying'});}});
    });
    if(!result.ok&&result.errorCode==='pairing_identity_unconfirmed'&&now<Date.parse(j.expiresAt)){waiting=true;continue;}
    const phase=result.ok?'succeeded':result.errorCode==='pairing_automation_disabled'?'disabled':result.errorCode==='pairing_identity_unconfirmed'||result.errorCode==='pairing_intent_expired'?'failed':'needs_check';
    j=await updatePairJob(c,{...j,phase,result,...(result.intentId?{intentId:result.intentId}:{}),...(!result.ok?{errorCode:result.errorCode}:{})});
    if(deps.notify)await deps.notify(c,j.requestId);
   }
   if(waiting){await(deps.sleep||pause)(delay);delay=Math.min(delay*2,1000);continue;}
   await deps.afterIdle?.();const releaseStart=await startLock(c);
   try{const remaining=await listPairJobs(c);if(remaining.some(j=>!terminalJob(j)))continue;await mark('closed');return;}finally{await releaseStart();}
  }
 }finally{
  const releaseStart=await startLock(c);try{const m=await inspectPairWorker(c);if(m.pid===process.pid)await mark('closed');}finally{await releaseStart();await releaseWork!();}
 }
}
export async function recoverPairJob(c:InstallContext,id:string,deps:PairDeps={}){
 return withPairOperation(c,()=>automationLock(c,async()=>{
  let j=await readPairJob(c,id);if(!j)throw Error('pairing_job_missing');if(j.phase==='succeeded')return j;
  const state=await readPairState(c),intentId=state.requests.find(r=>r.requestId===id)?.intentId;
  const started=!!intentId&&(state.activations.some(a=>a.redeemIntentId===intentId)||state.invitations.some(i=>i.issueIntentId===intentId));
  if(!started&&!await jobAuthorized(c,j))throw Error('pairing_automation_disabled');
  const result=await executePairRequest(c,id,{...deps,beforeOperation:async checked=>{j=await updatePairJobLocked(c,{...j!,intentId:checked,phase:'applying'});}});
  return updatePairJobLocked(c,{...j!,phase:result.ok?'succeeded':'needs_check',result,...(!result.ok?{errorCode:result.errorCode}:{errorCode:undefined})});
 }));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4||process.argv[2]!=='--root'||!path.isAbsolute(process.argv[3]))throw Error('invalid_arguments');const c={installRoot:process.argv[3],home:os.homedir(),sourceRoot:path.join(process.argv[3],'runtime'),nodeExe:process.execPath};let notificationDeadline:number|undefined;await runPairWorker(c,{notify:async(c,id)=>{try{await notifyPairJob(c,id);notificationDeadline??=Date.now()+60000;await settlePairNotification(c,id,{maxWaitMs:Math.max(0,notificationDeadline-Date.now())});}catch{process.stderr.write('pair_notification_requires_check\n');}}});}catch(e:any){process.stderr.write('pair_worker_error '+(/^[a-z_]+$/.test(e.message||'')?e.message:'requires_check')+'\n');process.exitCode=1;}
}
