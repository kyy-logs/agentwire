import path from 'node:path';
import {readFile,readdir,stat,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assertId} from '../model.ts';
import {optional,safePath,atomicBytes,jsonBytes,acquireLock} from '../installation/paths.ts';
import {readPairState} from './store.ts';
import type {InstallContext} from '../installation/model.ts';
import type {PairDeps} from './model.ts';

export type Automation={schemaVersion:1;enabled:boolean;generation:string;enabledAt:string};
export type PairJob={schemaVersion:1;requestId:string;generation:string;createdAt:string;expiresAt:string;revision:number;phase:'waiting_native'|'verified'|'applying'|'succeeded'|'failed'|'needs_check'|'disabled';intentId?:string;result?:any;errorCode?:string;startup?:{ownerPid:number;startedAt:string};notification:{phase:'pending'|'attempted'|'delivered'|'needs_check'|'offline'|'suppressed';suppressedAt?:string;transportId?:string;body?:string;intent?:any;evidenceRef?:string;errorCode?:string}};
export const terminalJob=(j:PairJob)=>['succeeded','failed','needs_check','disabled'].includes(j.phase);
export async function automationPath(c:InstallContext,rel:string){return safePath(c.installRoot,path.join(c.installRoot,'pairing',rel));}
const stamp=(s:any)=>typeof s==='string'&&Number.isFinite(Date.parse(s));
async function bounded(file:string){if((await stat(file)).size>262144)throw Error('pairing_job_limit');return JSON.parse(await readFile(file,'utf8'));}
export async function automationLock<T>(c:InstallContext,fn:()=>Promise<T>):Promise<T>{
 const file=await automationPath(c,'automation.lock');let release;
 for(let i=0;i<40;i++){try{release=await acquireLock(file);break;}catch(e:any){if(e.message!=='installation_busy'||i===39)throw e;await new Promise(r=>setTimeout(r,25));}}
 try{return await fn();}finally{await release!();}
}
export async function readAutomation(c:InstallContext):Promise<Automation>{
 const file=await automationPath(c,'automation.json');if(!await optional(file))return {schemaVersion:1,enabled:false,generation:'manual',enabledAt:new Date(0).toISOString()};
 const a=await bounded(file);if(a.schemaVersion!==1||typeof a.enabled!=='boolean'||typeof a.generation!=='string'||!stamp(a.enabledAt))throw Error('pairing_automation_invalid');assertId(a.generation);return a;
}
export async function setAutomation(c:InstallContext,enabled:boolean,deps:Pick<PairDeps,'now'>={}):Promise<Automation>{
 return automationLock(c,async()=>{const previous=await readAutomation(c);if(previous.enabled===enabled)return previous;const a:Automation={schemaVersion:1,enabled,generation:randomUUID(),enabledAt:(deps.now?.()||new Date()).toISOString()};await atomicBytes(await automationPath(c,'automation.json'),jsonBytes(a));return a;});
}
function validate(j:any):asserts j is PairJob{
 if(!j||j.schemaVersion!==1||!stamp(j.createdAt)||!stamp(j.expiresAt)||!Number.isSafeInteger(j.revision)||j.revision<0||!['waiting_native','verified','applying','succeeded','failed','needs_check','disabled'].includes(j.phase)||!['pending','attempted','delivered','needs_check','offline','suppressed'].includes(j.notification?.phase))throw Error('pairing_job_invalid');
 if(j.notification.phase==='suppressed'&&(j.phase!=='failed'||j.errorCode!=='pairing_intent_expired'||j.result?.ok!==false||j.result.errorCode!=='pairing_intent_expired'||j.intentId||j.notification.intent||j.notification.transportId||j.notification.evidenceRef||j.notification.errorCode!=='expired_by_user'||!stamp(j.notification.suppressedAt)||Date.parse(j.notification.suppressedAt)<Date.parse(j.expiresAt)))throw Error('pairing_job_invalid');
 if(j.startup!==undefined&&(!j.startup||!Number.isSafeInteger(j.startup.ownerPid)||j.startup.ownerPid<=0||!stamp(j.startup.startedAt)))throw Error('pairing_job_invalid');
 try{assertId(j.requestId);assertId(j.generation);if(j.intentId)assertId(j.intentId);if(j.notification.transportId)assertId(j.notification.transportId);}catch{throw Error('pairing_job_invalid');}
 if(j.phase==='succeeded'&&j.result?.ok!==true||j.notification.body!==undefined&&(typeof j.notification.body!=='string'||Buffer.byteLength(j.notification.body)>32768))throw Error('pairing_job_invalid');
}
export async function readPairJob(c:InstallContext,id:string):Promise<PairJob|undefined>{assertId(id);const f=await automationPath(c,path.join('jobs',id+'.json'));if(!await optional(f))return;const j=await bounded(f);validate(j);if(j.requestId!==id)throw Error('pairing_job_invalid');return j;}
export async function listPairJobs(c:InstallContext):Promise<PairJob[]>{
 const dir=await automationPath(c,'jobs');let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return [];throw e;}
 if(entries.length>1024)throw Error('pairing_job_limit');const out:PairJob[]=[];
 for(const e of entries){if(e.name.endsWith('.tmp'))throw Error('pairing_job_requires_check');if(!e.isFile()||!e.name.endsWith('.json'))throw Error('pairing_job_invalid');const j=await readPairJob(c,e.name.slice(0,-5));if(j)out.push(j);}
 return out.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.requestId.localeCompare(b.requestId));
}
export async function jobAuthorized(c:InstallContext,j:PairJob){const a=await readAutomation(c);return a.enabled&&a.generation===j.generation&&Date.parse(j.createdAt)>=Date.parse(a.enabledAt);}
export async function enqueuePairJob(c:InstallContext,id:string,deps:Pick<PairDeps,'now'>&{startupOwnerPid?:number}={}):Promise<PairJob>{
 assertId(id);if(deps.startupOwnerPid!==undefined&&(!Number.isSafeInteger(deps.startupOwnerPid)||deps.startupOwnerPid<=0))throw Error('pairing_job_invalid');return automationLock(c,async()=>{
  await pruneLocked(c,deps);
  const prior=await readPairJob(c,id);if(prior){if(deps.startupOwnerPid&&prior.phase==='waiting_native'&&!prior.intentId&&!prior.result&&!prior.startup&&await jobAuthorized(c,prior))return updatePairJobLocked(c,{...prior,startup:{ownerPid:deps.startupOwnerPid,startedAt:(deps.now?.()||new Date()).toISOString()}});return prior;}const a=await readAutomation(c),r=(await readPairState(c)).requests.find(r=>r.requestId===id),now=+(deps.now?.()||new Date());
  if(!a.enabled||!r||Date.parse(r.observedAt)<Date.parse(a.enabledAt)||now>=Date.parse(r.expiresAt))throw Error('automation_request_not_eligible');
  if((await listPairJobs(c)).filter(j=>!terminalJob(j)).length>=32)throw Error('pairing_job_limit');
  const j:PairJob={schemaVersion:1,requestId:id,generation:a.generation,createdAt:r.observedAt,expiresAt:r.expiresAt,revision:0,phase:'waiting_native',...(deps.startupOwnerPid?{startup:{ownerPid:deps.startupOwnerPid,startedAt:new Date(now).toISOString()}}:{}),notification:{phase:'pending'}};
  await atomicBytes(await automationPath(c,path.join('jobs',id+'.json')),jsonBytes(j));return j;
 });
}
export async function updatePairJob(c:InstallContext,j:PairJob):Promise<PairJob>{
 return automationLock(c,()=>updatePairJobLocked(c,j));
}
/** Internal: caller owns automation.lock, including mode/execution admission. */
export async function updatePairJobLocked(c:InstallContext,j:PairJob):Promise<PairJob>{validate(j);const before=await readPairJob(c,j.requestId);if(!before||before.revision!==j.revision||before.generation!==j.generation||before.createdAt!==j.createdAt||before.expiresAt!==j.expiresAt)throw Error('pairing_job_changed');const next={...j,revision:j.revision+1};await atomicBytes(await automationPath(c,path.join('jobs',j.requestId+'.json')),jsonBytes(next));return next;}
async function pruneLocked(c:InstallContext,deps:Pick<PairDeps,'now'>){const now=+(deps.now?.()||new Date());for(const j of await listPairJobs(c)){if(now-Date.parse(j.createdAt)<86400000||!terminalJob(j)||j.phase==='needs_check'||['attempted','needs_check','suppressed'].includes(j.notification.phase))continue;await unlink(await automationPath(c,path.join('jobs',j.requestId+'.json')));}}
export const prunePairJobs=(c:InstallContext,deps:Pick<PairDeps,'now'>={})=>automationLock(c,()=>pruneLocked(c,deps));


/** User-authorized retirement of expired pre-identity notices; never settles a write. */
export async function suppressExpiredPairNotification(c:InstallContext,id:string,deps:Pick<PairDeps,'now'>={}){
 assertId(id);return automationLock(c,async()=>{
  const j=await readPairJob(c,id);if(!j)throw Error('pairing_job_missing');if(j.notification.phase==='suppressed')return j;
  const now=deps.now?.()||new Date();if(now.getTime()<Date.parse(j.expiresAt)||j.phase!=='failed'||j.errorCode!=='pairing_intent_expired'||j.result?.ok!==false||j.result.errorCode!=='pairing_intent_expired'||j.intentId||j.notification.phase!=='pending'||j.notification.intent||j.notification.transportId||j.notification.evidenceRef)throw Error('notification_suppression_requires_check');
  return updatePairJobLocked(c,{...j,notification:{phase:'suppressed',errorCode:'expired_by_user',suppressedAt:now.toISOString()}});
 });
}
