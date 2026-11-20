import type {LocalBus} from '../bus.ts';import type {MessageRecord} from '../model.ts';import type {CleanTerminalHint} from '../native/model.ts';import {FileLifecycleStore} from './store.ts';import {eventKey,outputLimit,digest} from './model.ts';import type {CapturedResult} from './model.ts';import {IdentityStore} from '../native/identity-store.ts';import type {Provider,EvidenceReader} from '../native/model.ts';
export class CleanProcessor{
 bus:LocalBus;identity:IdentityStore;life:FileLifecycleStore;readers:Record<Provider,EvidenceReader>;
 constructor(bus:LocalBus,identity:IdentityStore,life:FileLifecycleStore,readers:Record<Provider,EvidenceReader>){this.bus=bus;this.identity=identity;this.life=life;this.readers=readers;}
 async repairCommittedProjection(parent:MessageRecord,saved:CapturedResult,reply:MessageRecord,hints:CleanTerminalHint[]){
  const old=await this.life.getExecution(saved.ref);if(old?.phase==='applied'||await this.life.hasConflict(saved.ref))return;
  if(old&&(old.messageId!==parent.message.messageId||old.dispatchNonce!==parent.dispatchNonce))return;
  let repair=!old;
  if(old?.phase==='needs_check'&&old.reason==='missing_final_output'){
   const event=await this.life.getEvent(saved.terminalEventKey),exact=hints.filter(h=>h.provider===saved.ref.provider&&h.sessionId===saved.ref.sessionId&&h.nativeExecutionId===saved.ref.nativeExecutionId);
   repair=!!event&&event.phase==='stop'&&!event.output?.trim()&&[event.backgroundPending,event.continuation,event.incomplete].every(x=>x!==true)&&exact.length===1&&exact[0].phase==='stop'&&[exact[0].backgroundPending,exact[0].continuation,exact[0].incomplete].every(x=>x===false);
  }
  if(repair)await this.life.bindExecution({...saved.ref,messageId:parent.message.messageId,dispatchNonce:parent.dispatchNonce!,phase:'applied',terminalEventKey:saved.terminalEventKey,replyMessageId:reply.message.messageId});
 }

 async settleStructuredTerminal(parent:MessageRecord,saved:CapturedResult):Promise<boolean>{
  const task=await this.bus.collaboration?.store.getTask(parent.message.taskId);
  if(!task||!['needs_check','stopped','expired'].includes(task.phase))return false;
  if(await this.life.hasConflict(saved.ref))return false;
  const old=await this.life.getExecution(saved.ref);
  if(old&&(old.messageId!==parent.message.messageId||old.dispatchNonce!==parent.dispatchNonce||old.replyMessageId))return false;
  // This records only native termination; no reply or business success is invented.
  if(old?.phase!=='applied'||old.terminalEventKey!==saved.terminalEventKey||old.reason!=='collaboration_terminal_without_reply')
   await this.life.bindExecution({...saved.ref,messageId:parent.message.messageId,dispatchNonce:parent.dispatchNonce!,phase:'applied',terminalEventKey:saved.terminalEventKey,reason:'collaboration_terminal_without_reply'});
  const current=await this.identity.get(parent.activeAttemptId!);
  if(current&&current.phase!=='terminal')await this.identity.advance(current.attemptId,current.phase,{phase:'terminal'});
  return true;
 }
 async recover(){const r=await this.identity.recover();if(r.corruptFiles.length)throw Error('native_storage_requires_check');await this.drain();}
 drain(){return this.bus.serial(async()=>{if(this.bus.dispatchStopped)return;const hints=await this.life.listCleanHints();for(const parent of await this.bus.store.list()){
 if(parent.message.schemaVersion!==2||parent.returnMode!=='auto'||parent.message.kind==='reply'||!parent.activeAttemptId||parent.attempts<1||['stopped','expired','failed'].includes(parent.state))continue;
 const i=await this.identity.get(parent.activeAttemptId);if(!i)continue;
 if(i.phase==='reply_committed'&&parent.state==='completed'&&parent.resultRef){const saved=await this.life.getResult(parent.message.messageId),reply=await this.bus.store.get(parent.resultRef);const hex=digest('local-agent-bus:auto-reply:'+parent.message.messageId),autoId=hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);if(saved&&reply?.message.kind==='reply'&&reply.message.replyTo===parent.message.messageId&&(parent.resultRef!==autoId||parent.completion?.eventKey===saved.terminalEventKey)){await this.repairCommittedProjection(parent,saved,reply,hints);continue;}}
if(i.errorCode==='native_binding_conflict'||i.errorCode==='multiple_native_executions')continue;
 const e=await this.bus.nativeDispatcher!.reconcile(i);const pause=async(reason:string)=>{if(parent.state!=='completed'){parent.state='needs_check';parent.lastError=reason;await this.bus.update(parent);}};
 if(e.status==='conflict'){await pause(e.errorCode||'native_binding_conflict');continue;}if(e.status==='limit'){await pause(e.errorCode||'native_read_limit');continue;}if(e.status!=='mapped')continue;
 const ref={provider:e.identity.provider,sessionId:e.identity.sessionId,nativeExecutionId:e.identity.nativeExecutionId};const exact=hints.filter(h=>h.provider===ref.provider&&h.sessionId===ref.sessionId&&h.nativeExecutionId===ref.nativeExecutionId);if(!exact.length)continue;
 if(exact.length>1){await pause('multiple_terminal_events');continue;}const h=exact[0];if([h.backgroundPending,h.continuation,h.incomplete].some(x=>x!==false)){await pause(h.backgroundPending?'background_pending':h.continuation?'stop_continuation_unverified':h.incomplete?'captured_output_incomplete':'missing_terminal_flags');continue;}
 const existing=await this.life.getResult(parent.message.messageId);let saved=existing;
 if(!saved){const terminal=e.terminal;if(h.phase==='stop'&&(!terminal||!terminal.body.trim()))continue;if(terminal&&(terminal.ref.provider!==ref.provider||terminal.ref.sessionId!==ref.sessionId||terminal.ref.nativeExecutionId!==ref.nativeExecutionId)){await pause('native_result_identity_mismatch');continue;}if(terminal&&(terminal.backgroundPending||terminal.continuation||terminal.incomplete||Buffer.byteLength(terminal.body)>outputLimit)){await pause('native_result_incomplete');continue;}
 const result:CapturedResult={messageId:parent.message.messageId,ref,terminalEventKey:eventKey(ref,h.phase),nativeOutcome:h.phase==='stop'?'response_ended':h.phase==='failure'?'error':'interrupted',businessVerdict:'unverified',body:terminal?.body|| (h.phase==='failure'?'原生执行报告失败，请检查原窗口。':'原生执行被中断，请检查原窗口。'),truncated:Buffer.byteLength(terminal?.body||'')>1800};saved=await this.life.saveResult(result);}
 if(this.bus.dispatchStopped)continue;const reply=await this.bus.applyCapturedResultOne(saved);if(!reply&&await this.bus.collaboration?.isStructuredFamily(parent.message.taskId)){await this.settleStructuredTerminal(parent,saved);continue;}const current=await this.identity.get(i.attemptId);if(current&&current.phase!=='reply_committed')await this.identity.advance(i.attemptId,current.phase,{phase:'reply_committed'});
 if(reply)await this.life.bindExecution({...ref,messageId:parent.message.messageId,dispatchNonce:parent.dispatchNonce!,phase:'applied',terminalEventKey:saved.terminalEventKey,replyMessageId:reply.message.messageId});
 }});}
 async close(){await this.bus.chain;}
}
