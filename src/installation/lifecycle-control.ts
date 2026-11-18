import path from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {assertId,realClock} from '../model.ts';
import {FileMessageStore} from '../store.ts';
import {eventKey,executionKey,validateEvent,validateRef,digest} from '../lifecycle/model.ts';
import type {ExecutionRef} from '../lifecycle/model.ts';
import type {InstallContext} from './model.ts';
import {readConnection,sameChat} from './connections.ts';
import {safePath} from './paths.ts';
import {validateIntent} from '../native/identity-store.ts';
import type {DispatchIntent} from '../native/model.ts';

async function json(c:InstallContext,file:string){
 try{const b=await readFile(await safePath(c.installRoot,file));if(b.length>1048576)throw Error('control_evidence_limit');return JSON.parse(b.toString('utf8'));}catch(e:any){if(e.code==='ENOENT')return;throw e;}
}
async function entries(c:InstallContext,dir:string){
 try{const names=await readdir(await safePath(c.installRoot,dir),{withFileTypes:true});if(names.length>1000)throw Error('control_evidence_limit');if(names.some(e=>!e.isFile()||!e.name.endsWith('.json')))throw Error('control_evidence_invalid');return names.map(e=>e.name);}catch(e:any){if(e.code==='ENOENT')return [];throw e;}
}
async function informationalReply(c:InstallContext,state:string,i:DispatchIntent){
 // Exclude only a positively identified non-auto information reply. This does
 // not prove its delivery or associate this Stop with that reply's transport.
 if(!await json(c,path.join(state,'messages',i.messageId+'.json')))return false;
 const r=await new FileMessageStore(state,realClock).get(i.messageId),m=r?.message;
 return !!r&&!!m&&m.schemaVersion===2&&m.kind==='reply'&&m.returnMode===undefined&&r.returnMode!=='auto'&&r.activeAttemptId===i.attemptId&&r.attempts>0&&m.to===i.provider&&m.from===(i.provider==='codex'?'claude':'codex')&&m.targetSessionId===i.targetSessionId&&m.sourceSessionId===i.sourceSessionId&&digest(m.body)===i.bodySha256;
}

/** A completed switch may move this turn's Stop to the new route. Prove an
 * already-applied ordinary input in that switch's source; never copy it or
 * infer a task association. Any ambiguous/corrupt evidence fails closed. */
export async function isSwitchControlExecution(c:InstallContext,connectionId:string,ref:ExecutionRef){
 try{
  validateRef(ref);const target=await readConnection(c,connectionId);if(target.schemaVersion!==2||target[ref.provider].sessionId!==ref.sessionId)return false;
  const dir=path.join(c.installRoot,'install','connection-switches');let witnesses=0;
  for(const name of await entries(c,dir)){
   const p=await json(c,path.join(dir,name));if(!p||p.status!=='applied'||p.schemaVersion!==1)continue;
   assertId(p.operationId);if(name!==p.operationId+'.json')return false;
   if(p.to?.connectionId!==connectionId||p.source?.provider!==ref.provider||p.source?.sessionId!==ref.sessionId)continue;
   if(p.to.schemaVersion!==2||p.to.pairing?.activationId!==target.pairing.activationId||!sameChat(p.to.codex,target.codex)||!sameChat(p.to.claude,target.claude)||!p.from||p.from.connectionId===connectionId)return false;
   const from=await readConnection(c,p.from.connectionId);if(from.schemaVersion!==2||from.phase!=='disconnected'||p.from.schemaVersion!==2||from.pairing.activationId!==p.from.pairing?.activationId||!sameChat(from.codex,p.from.codex)||!sameChat(from.claude,p.from.claude)||!sameChat(from[ref.provider],target[ref.provider]))return false;
   const state=path.join(c.installRoot,'connections',from.connectionId,'state'),key=eventKey(ref,'input'),input=await json(c,path.join(state,'lifecycle','events',key+'.json'));if(!input)continue;
   validateEvent(input);
   const previewAt=Date.parse(p.expiresAt)-300000;
   if(input.phase!=='input'||input.eventKey!==key||input.provider!==ref.provider||input.sessionId!==ref.sessionId||input.nativeExecutionId!==ref.nativeExecutionId||input.inputKind!=='ordinary'||input.messageId||input.dispatchNonce||input.output!==undefined||input.errorCode||input.backgroundPending||input.continuation||input.incomplete||!Number.isFinite(previewAt)||Date.parse(input.observedAt)>previewAt)return false;
   const applied=await json(c,path.join(state,'lifecycle','applied',key+'.json'));if(applied?.eventKey!==key)return false;
   for(const kind of ['executions','conflicts'])if(await json(c,path.join(state,'lifecycle',kind,executionKey(ref)+'.json')))return false;
   const attempts=path.join(state,'native','attempts');
   for(const name of await entries(c,attempts)){
    const i=await json(c,path.join(attempts,name));validateIntent(i);if(name!==i.attemptId+'.json'||i.connectionId!==from.connectionId)return false;
    if(i.provider!==ref.provider||i.targetSessionId!==ref.sessionId)continue;
    if(i.sourceSessionId!==from[ref.provider==='codex'?'claude':'codex'].sessionId)return false;
    if(i.nativeExecutionId===ref.nativeExecutionId)return false;
    if(!i.nativeExecutionId&&i.phase!=='not_written'&&!await informationalReply(c,state,i))return false;
   }
   witnesses++;
  }
  return witnesses===1;
 }catch{return false;}
}
