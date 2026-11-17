import path from 'node:path';
import {open} from 'node:fs/promises';
import {randomInt,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertId} from '../model.ts';
import {acquireLock,atomicBytes,jsonBytes,safePath} from '../installation/paths.ts';
import {normalizePairEvent,parsePairCommand} from './capture.ts';
import type {Candidate,InstallContext} from '../installation/model.ts';
import type {PairActivation,PairDeps,PairIntent,PairIssue,PairState,PairTransaction} from './model.ts';

const MAX_BYTES=262144,MAX_RECORDS=128,INTENT_MS=120000,CODE_MS=300000,RETAIN_MS=86400000;
const ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE=/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
function fail(code:string):never{throw Error(code);}
function object(v:any){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function id(v:any){try{assertId(v);return true;}catch{return false;}}
function stamp(v:any):boolean{return typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
function now(deps:PairDeps){const n=(deps.now??(()=>new Date()))().getTime();if(!Number.isFinite(n))fail('pairing_store_invalid');return n;}
function candidate(v:any):v is Candidate{return object(v)&&['codex','claude'].includes(v.provider)&&id(v.sessionId)&&typeof v.workspaceRoot==='string'&&path.isAbsolute(v.workspaceRoot)&&['candidate','live_endpoint'].includes(v.availability)&&(v.title===undefined||typeof v.title==='string');}
function validIntent(v:any):v is PairIntent{
 if(!object(v)||!id(v.intentId)||!id(v.nativeInputId)||!candidate(v.source)||!object(v.command)||!stamp(v.capturedAt)||!stamp(v.expiresAt)||Date.parse(v.expiresAt)-Date.parse(v.capturedAt)!==INTENT_MS)return false;
 if(typeof v.proofRef!=='string'||!v.proofRef.endsWith('#'+v.nativeInputId)||!path.isAbsolute(v.proofRef.slice(0,-37)))return false;
 return v.command.kind==='issue'||v.command.kind==='redeem'&&['codex','claude'].includes(v.command.target)&&typeof v.command.code==='string'&&CODE.test(v.command.code);
}
function validState(s:any):asserts s is PairState{
 if(!object(s)||s.schemaVersion!==1||!Array.isArray(s.requests)||!Array.isArray(s.intents)||!Array.isArray(s.invitations)||!Array.isArray(s.activations))fail('pairing_store_invalid');
 if(s.requests.length+s.intents.length+s.invitations.length+s.activations.length>MAX_RECORDS)fail('pairing_store_limit');
 if(!s.intents.every(validIntent))fail('pairing_store_invalid');
 const ids=[...s.requests.map((x:any)=>x?.requestId),...s.intents.map((x:any)=>x.intentId),...s.invitations.map((x:any)=>x?.invitationId),...s.activations.map((x:any)=>x?.activationId)];
 if(ids.some(x=>!id(x))||new Set(ids).size!==ids.length)fail('pairing_store_invalid');
 const inputs=new Set<string>();
 for(const r of s.requests){
  if(!object(r))fail('pairing_store_invalid');const event=normalizePairEvent(r.provider,r.event);
  if(!event||!stamp(r.observedAt)||!stamp(r.expiresAt)||Date.parse(r.expiresAt)-Date.parse(r.observedAt)!==INTENT_MS||!isDeepStrictEqual(event,r.event))fail('pairing_store_invalid');
  const inputId=r.provider==='codex'?r.event.turn_id:r.event.prompt_id,key=[r.provider,r.event.session_id,inputId].join(':');if(inputs.has(key))fail('pairing_store_invalid');inputs.add(key);
  if(r.intentId!==undefined){const i=s.intents.find((x:any)=>x.intentId===r.intentId);if(!i||i.source.provider!==r.provider||i.source.sessionId!==r.event.session_id||i.nativeInputId!==inputId||i.source.workspaceRoot!==r.event.cwd||i.proofRef!==r.event.transcript_path+'#'+inputId||!isDeepStrictEqual(i.command,parsePairCommand(r.event.prompt)))fail('pairing_store_invalid');}
 }
 for(const i of s.invitations){
  if(!object(i))fail('pairing_store_invalid');
  const source=s.intents.find((x:any)=>x.intentId===i.issueIntentId);
  if(!object(i)||!source||source.command.kind!=='issue'||!isDeepStrictEqual(source.source,i.issuer)||!CODE.test(i.code)||!stamp(i.expiresAt)||!['available','revoked','claimed'].includes(i.state)||(i.terminalAt!==undefined&&!stamp(i.terminalAt)))fail('pairing_store_invalid');
  if(i.state==='claimed'){
   if(!s.activations.some((a:any)=>a?.activationId===i.activationId&&a.invitationId===i.invitationId))fail('pairing_store_invalid');
  }else if(i.activationId!==undefined||i.state==='revoked'&&!i.terminalAt||i.state==='available'&&i.terminalAt!==undefined)fail('pairing_store_invalid');
 }
 if(new Set(s.invitations.map((x:any)=>x.code)).size!==s.invitations.length)fail('pairing_store_invalid');
 for(const a of s.activations){
  if(a?.reuse!==undefined&&(!object(a.reuse)||![1,2].includes(a.reuse.schemaVersion)||a.reuse.schemaVersion===2&&!id(a.reuse.activationId)||a.reuse.schemaVersion===1&&a.reuse.activationId!==undefined))fail('pairing_store_invalid');
  if(!object(a)||!id(a.connectionId)||!candidate(a.codex)||a.codex.provider!=='codex'||!candidate(a.claude)||a.claude.provider!=='claude'||!['activating','paired','needs_check'].includes(a.phase)||!stamp(a.createdAt)||(a.terminalAt!==undefined&&!stamp(a.terminalAt))||a.phase==='paired'&&!a.terminalAt||(a.errorCode!==undefined&&!/^[a-z_]{1,80}$/.test(a.errorCode)))fail('pairing_store_invalid');
  const inv=s.invitations.find((x:any)=>x.invitationId===a.invitationId),intent=s.intents.find((x:any)=>x.intentId===a.redeemIntentId);
  if(!inv||inv.state!=='claimed'||inv.activationId!==a.activationId||!intent||intent.command.kind!=='redeem'||intent.command.target!==inv.issuer.provider||intent.source.provider===inv.issuer.provider||intent.command.code!==inv.code||!isDeepStrictEqual(a[inv.issuer.provider as 'codex'|'claude'],inv.issuer)||!isDeepStrictEqual(a[intent.source.provider as 'codex'|'claude'],intent.source))fail('pairing_store_invalid');
  if(a.phase==='paired'?inv.terminalAt!==a.terminalAt:a.terminalAt!==undefined||inv.terminalAt!==undefined)fail('pairing_store_invalid');
 }
 if(new Set(s.activations.map((x:any)=>x.redeemIntentId)).size!==s.activations.length||new Set(s.invitations.map((x:any)=>x.issueIntentId)).size!==s.invitations.length)fail('pairing_store_invalid');
}
function prune(s:PairState,t:number){
 for(const i of s.invitations)if(i.state==='available'&&t>=Date.parse(i.expiresAt)){i.state='revoked';i.terminalAt=i.expiresAt;}
 const old=(at:string|undefined)=>at!==undefined&&t>=Date.parse(at)+RETAIN_MS;
 const removable=new Set(s.activations.filter(a=>a.phase==='paired'&&old(a.terminalAt)).map(a=>a.activationId));
 s.invitations=s.invitations.filter(i=>!old(i.terminalAt)||i.state==='claimed'&&!removable.has(i.activationId!));
 const keepInv=new Set(s.invitations.map(i=>i.invitationId));s.activations=s.activations.filter(a=>keepInv.has(a.invitationId));
 const keepIntent=new Set([...s.invitations.map(i=>i.issueIntentId),...s.activations.map(a=>a.redeemIntentId)]);
 s.intents=s.intents.filter(i=>keepIntent.has(i.intentId)||!old(i.expiresAt));
 const intents=new Set(s.intents.map(i=>i.intentId));s.requests=s.requests.filter(r=>r.intentId?intents.has(r.intentId):!old(r.expiresAt));
}
async function load(file:string):Promise<PairState>{
 let h;try{h=await open(file,'r');}catch(e:any){if(e.code==='ENOENT')return {schemaVersion:1,requests:[],intents:[],invitations:[],activations:[]};throw e;}
 try{
  const first=await h.stat();if(!first.isFile())fail('pairing_store_invalid');if(first.size>MAX_BYTES)fail('pairing_store_limit');
  const b=Buffer.alloc(MAX_BYTES+1),r=await h.read(b,0,b.length,0),last=await h.stat();if(r.bytesRead>MAX_BYTES)fail('pairing_store_limit');
  if(first.size!==last.size||first.mtimeMs!==last.mtimeMs||r.bytesRead!==last.size)fail('pairing_store_invalid');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,r.bytesRead)));}catch{fail('pairing_store_invalid');}validState(value);return value;
 }finally{await h.close();}
}
/** All public mutations share connection.lock with connection activation.
 * Callers inside this callback must use tx.state/commit, never re-enter a public
 * pairing or connection operation that acquires the same non-reentrant lock.
 * This internal API accepts only previously verified PairIntent data; no CLI or
 * Hook is wired to it yet, and loading state does not confer native authority.
 */
export async function withPairState<T>(c:InstallContext,fn:(tx:PairTransaction)=>Promise<T>,deps:PairDeps={}):Promise<T>{
 await safePath(c.installRoot,c.installRoot);const file=await safePath(c.installRoot,path.join(c.installRoot,'pairing','state.json'));
 const release=await acquireLock(path.join(c.installRoot,'connection.lock'));
 try{
  await safePath(c.installRoot,file);const state=await load(file);prune(state,now(deps));
  const tx:PairTransaction={state,async commit(){prune(state,now(deps));validState(state);const bytes=jsonBytes(state);if(bytes.length>MAX_BYTES)fail('pairing_store_limit');await safePath(c.installRoot,file);await atomicBytes(file,bytes);}};
  return await fn(tx);
 }finally{await release();}
}
function requireIntent(tx:PairTransaction,intentId:string,kind:'issue'|'redeem',t:number){
 const i=tx.state.intents.find(x=>x.intentId===intentId);if(!i||i.command.kind!==kind)fail('pairing_identity_unconfirmed');
 if(t<Date.parse(i.capturedAt))fail('pairing_identity_unconfirmed');if(t>=Date.parse(i.expiresAt))fail('pairing_intent_expired');return i;
}
export async function capturePairIntent(c:InstallContext,intent:PairIntent,deps:PairDeps={}):Promise<void>{
 if(!validIntent(intent)||Date.parse(intent.capturedAt)>now(deps))fail('pairing_identity_unconfirmed');
 await withPairState(c,async tx=>{
  const old=tx.state.intents.find(i=>i.intentId===intent.intentId);if(old){if(!isDeepStrictEqual(old,intent))fail('pairing_identity_unconfirmed');return;}
  if(now(deps)>=Date.parse(intent.expiresAt))fail('pairing_intent_expired');tx.state.intents.push(structuredClone(intent));await tx.commit();
 },deps);
}
function issueResult(i:PairState['invitations'][number]):PairIssue{return {invitationId:i.invitationId,code:i.code,issuer:structuredClone(i.issuer),expiresAt:i.expiresAt};}
export async function issueCode(c:InstallContext,intentId:string,deps:PairDeps={}):Promise<PairIssue>{
 return withPairState(c,async tx=>{
  const existing=tx.state.invitations.find(i=>i.issueIntentId===intentId);if(existing)return issueResult(existing);
  const t=now(deps),intent=requireIntent(tx,intentId,'issue',t);let code:string|undefined;
  for(let attempt=0;attempt<32;attempt++){let raw='';for(let n=0;n<8;n++)raw+=ALPHABET[randomInt(32)];const value=raw.slice(0,4)+'-'+raw.slice(4);if(!tx.state.invitations.some(i=>i.code===value)){code=value;break;}}
  if(!code)fail('pairing_code_unavailable');
  for(const i of tx.state.invitations)if(i.state==='available'&&i.issuer.provider===intent.source.provider&&i.issuer.sessionId===intent.source.sessionId){i.state='revoked';i.terminalAt=new Date(t).toISOString();}
  const i={invitationId:randomUUID(),code,issuer:structuredClone(intent.source),expiresAt:new Date(t+CODE_MS).toISOString(),issueIntentId:intentId,state:'available' as const};tx.state.invitations.push(i);await tx.commit();return issueResult(i);
 },deps);
}
/** Only claims an invitation. Service code must check active connections and
 * exact target availability BEFORE claiming inside one withPairState callback.
 * No adapter, process, route, connection file or active pointer is touched here.
 */
export async function claimCode(c:InstallContext,intentId:string,deps:PairDeps={}):Promise<PairActivation>{
 return withPairState(c,tx=>claimCodeLocked(tx,intentId,deps),deps);
}
/** Internal transaction helpers: caller owns connection.lock. */
export function inspectClaimLocked(tx:PairTransaction,intentId:string,deps:PairDeps={}){
  const t=now(deps),intent=requireIntent(tx,intentId,'redeem',t);if(intent.command.kind!=='redeem')fail('pairing_identity_unconfirmed');
  const command=intent.command,inv=tx.state.invitations.find(i=>i.code===command.code);if(!inv)fail('pairing_code_invalid');
  if(inv.issuer.provider!==command.target||intent.source.provider===inv.issuer.provider)fail('pairing_provider_mismatch');
  if(inv.state==='claimed')fail('pairing_code_used');if(t>=Date.parse(inv.expiresAt))fail('pairing_code_expired');if(inv.state!=='available')fail('pairing_code_used');
  return {intent,inv};
}
export async function claimCodeLocked(tx:PairTransaction,intentId:string,deps:PairDeps={},connectionId?:string,reuse?:PairActivation['reuse']):Promise<PairActivation>{
  const existing=tx.state.activations.find(a=>a.redeemIntentId===intentId);if(existing)return structuredClone(existing);
  const {intent,inv}=inspectClaimLocked(tx,intentId,deps),t=now(deps);
  const a:PairActivation={activationId:randomUUID(),invitationId:inv.invitationId,redeemIntentId:intentId,connectionId:connectionId??randomUUID(),codex:structuredClone(intent.source.provider==='codex'?intent.source:inv.issuer),claude:structuredClone(intent.source.provider==='claude'?intent.source:inv.issuer),phase:'activating',createdAt:new Date(t).toISOString(),...(reuse?{reuse:structuredClone(reuse)}:{})};
  inv.state='claimed';inv.activationId=a.activationId;tx.state.activations.push(a);await tx.commit();return structuredClone(a);
}
export async function completeActivation(c:InstallContext,activationId:string,deps:PairDeps={}):Promise<void>{
 return withPairState(c,tx=>completeActivationLocked(tx,activationId,deps),deps);
}
export async function completeActivationLocked(tx:PairTransaction,activationId:string,deps:PairDeps={}):Promise<void>{
  const a=tx.state.activations.find(a=>a.activationId===activationId);if(!a||a.phase==='needs_check')fail('pairing_activation_requires_check');if(a.phase==='paired')return;
  a.phase='paired';a.terminalAt=new Date(now(deps)).toISOString();tx.state.invitations.find(i=>i.invitationId===a.invitationId)!.terminalAt=a.terminalAt;await tx.commit();
}
export async function readPairActivation(c:InstallContext,activationId:string,deps:PairDeps={}):Promise<PairActivation>{
 return withPairState(c,async tx=>{const a=tx.state.activations.find(a=>a.activationId===activationId);if(!a)fail('pairing_activation_requires_check');return structuredClone(a);},deps);
}
