import type {LocalBus} from '../bus.ts';
import {FileLifecycleStore} from './store.ts';
import {validateEvent,resultHeading,eventKey} from './model.ts';
import type {CapturedResult} from './model.ts';
import type {LifecycleEvent,ExecutionRef,EventApplyResult} from './model.ts';
export class LifecycleProcessor{
  bus:LocalBus;store:FileLifecycleStore;lastError?:string;
  constructor(bus:LocalBus,store:FileLifecycleStore){this.bus=bus;this.store=store;}
  process(e:LifecycleEvent){return this.bus.serial(()=>this.processOne(e));}
  async eligibleInput(e:LifecycleEvent|undefined){
    if(!e||e.phase!=='input'||!['task','followup'].includes(e.inputKind||'')||!e.messageId||!e.dispatchNonce)return;
    const r=await this.bus.store.get(e.messageId),binding=r&&this.bus.bindings.get(r.message.to);
    if(r&&r.message.schemaVersion===1&&r.returnMode==='auto'&&r.message.kind===e.inputKind&&r.dispatchNonce===e.dispatchNonce&&r.message.targetSessionId===e.sessionId&&binding?.kind===e.provider&&binding.sessionId===e.sessionId&&r.attempts>0)return r;
  }
  async benignInputConflict(e:LifecycleEvent){return e.phase==='input'&&!await this.store.getExecution(e)&&!await this.eligibleInput(e)&&!await this.eligibleInput(await this.store.getEvent(e.eventKey));}
  async pause(ref:ExecutionRef,reason:string,hint?:LifecycleEvent){
    let execution=await this.store.getExecution(ref);
    if(!execution){const candidates=[await this.store.getEvent(eventKey(ref,'input')),hint];for(const input of candidates){const r=await this.eligibleInput(input);if(r&&input?.dispatchNonce){execution={provider:ref.provider,sessionId:ref.sessionId,nativeExecutionId:ref.nativeExecutionId,messageId:r.message.messageId,dispatchNonce:input.dispatchNonce,phase:'needs_check'};break;}}}
    if(!execution)return;
    execution.phase='needs_check';execution.reason=reason;await this.store.bindExecution(execution);
    const r=await this.bus.store.get(execution.messageId);if(r&&!['completed','stopped','expired'].includes(r.state)){r.state='needs_check';r.lastError=reason;await this.bus.update(r);}
  }
  async cleanOwned(e:LifecycleEvent){const execution=await this.store.getExecution(e);return !!execution&&(await this.bus.store.get(execution.messageId))?.message.schemaVersion===2;}
  async processOne(e:LifecycleEvent):Promise<EventApplyResult>{
    validateEvent(e);
    if(await this.cleanOwned(e)){await this.store.markApplied(e.eventKey);return {status:'ignored',reason:'clean_native_processor_owns_execution'};}
    try{await this.store.putEvent(e);}catch(error){if((error as Error).message!=='lifecycle_event_conflict')throw error;if(await this.benignInputConflict(e))return {status:'ignored',reason:'non_auto_inputs'};this.lastError='lifecycle_event_conflict';await this.store.markConflict(e,this.lastError);await this.pause(e,this.lastError,e);return {status:'needs_check',reason:this.lastError};}
    if(await this.store.hasConflict(e)){await this.pause(e,'lifecycle_event_conflict');return {status:'needs_check',reason:'lifecycle_event_conflict'};}
    if(await this.store.isApplied(e.eventKey))return {status:'ignored',reason:'already_applied'};
    if(e.phase==='input'){
      if(!['task','followup'].includes(e.inputKind||'')||!e.messageId||!e.dispatchNonce){await this.store.markApplied(e.eventKey);return {status:'ignored'};}
      const r=await this.eligibleInput(e);
      if(!r){await this.store.markApplied(e.eventKey);return {status:'ignored',reason:'not_registered_auto_input'};}
      const executions=await this.store.executions();
      const others=executions.filter(x=>x.messageId===e.messageId&&(x.nativeExecutionId!==e.nativeExecutionId||x.provider!==e.provider||x.sessionId!==e.sessionId));
      if(others.length){for(const other of others)await this.pause(other,'multiple_native_executions');r.state='needs_check';r.lastError='multiple_native_executions';await this.bus.update(r);return {status:'needs_check'};}
      await this.store.bindExecution({provider:e.provider,sessionId:e.sessionId,nativeExecutionId:e.nativeExecutionId,messageId:e.messageId,dispatchNonce:e.dispatchNonce,phase:'bound'});
      await this.store.markApplied(e.eventKey);return {status:'applied'};
    }
    const execution=await this.store.getExecution(e);
    if(!execution){const inputs=(await this.store.events()).filter(x=>x.phase==='input'&&x.provider===e.provider&&x.sessionId===e.sessionId&&x.nativeExecutionId===e.nativeExecutionId);if(inputs.length){await this.store.markApplied(e.eventKey);return {status:'ignored',reason:'non_auto_execution'};}return {status:'deferred',reason:'missing_input_binding'};}
    if(execution.phase==='needs_check')return {status:'needs_check',reason:execution.reason};
    const competing=(await this.store.events()).filter(x=>x.phase!=='input'&&x.provider===e.provider&&x.sessionId===e.sessionId&&x.nativeExecutionId===e.nativeExecutionId);
    if(competing.length>1){await this.store.markConflict(e,'multiple_terminal_events');await this.pause(e,'multiple_terminal_events');return {status:'needs_check',reason:'multiple_terminal_events'};}
    if(e.backgroundPending||e.continuation||e.incomplete||(e.phase==='stop'&&!e.output?.trim())){
      const reason=e.backgroundPending?'background_pending':e.continuation?'stop_continuation_unverified':e.incomplete?'captured_output_incomplete':'missing_final_output';
      await this.pause(e,reason);return {status:'needs_check',reason};
    }
    const result:CapturedResult={messageId:execution.messageId,ref:{provider:e.provider,sessionId:e.sessionId,nativeExecutionId:e.nativeExecutionId},terminalEventKey:e.eventKey,
      nativeOutcome:e.phase==='stop'?'response_ended':e.phase==='failure'?'error':'interrupted',businessVerdict:'unverified',
      body:e.output?.trim()?e.output:e.phase==='failure'?'原生执行报告失败，未提供最终文本；请检查原窗口。':'原生执行被中断，未提供最终文本；请检查原窗口。',
      truncated:false};
    result.truncated=Buffer.byteLength(result.body)>2048-Buffer.byteLength(resultHeading(result.nativeOutcome));
    const saved=await this.store.saveResult(result);execution.phase='result_saved';execution.terminalEventKey=e.eventKey;await this.store.bindExecution(execution);
    if(this.bus.dispatchStopped)return {status:'deferred',reason:'service_shutdown_result_retained'};
    const reply=await this.bus.applyCapturedResultOne(saved);
    execution.phase='applied';if(reply)execution.replyMessageId=reply.message.messageId;await this.store.bindExecution(execution);await this.store.markApplied(e.eventKey);
    return {status:'applied'};
  }
  drain(){return this.bus.serial(()=>this.drainOne());}
  async drainOne(){
    for(const file of await this.store.readInbox()){
      let event:LifecycleEvent;
      try{event=await this.store.consumeInbox(file);validateEvent(event);}
      catch(error){if((error as any)?.code)throw error;await this.store.quarantine(file);this.lastError='lifecycle_inbox_invalid';throw new Error(this.lastError);}
      if(await this.cleanOwned(event)){await this.store.markApplied(event.eventKey);await this.store.removeInbox(file);continue;}
      try{await this.store.putEvent(event);}catch(error){if((error as Error).message!=='lifecycle_event_conflict')throw error;if(await this.benignInputConflict(event)){await this.store.removeInbox(file);continue;}await this.store.markConflict(event,'lifecycle_event_conflict');await this.pause(event,'lifecycle_event_conflict',event);await this.store.quarantine(file);this.lastError='lifecycle_event_conflict';continue;}
      await this.store.removeInbox(file);
    }
    const events=await this.store.events();
    for(const event of events.filter(e=>e.phase==='input'))if(!await this.store.isApplied(event.eventKey))await this.processOne(event);
    for(const event of events.filter(e=>e.phase!=='input'))if(!await this.store.isApplied(event.eventKey))await this.processOne(event);
  }
  async recover(){await this.store.recover();await this.drain();}
  async health(){const executions=await this.store.executions();return {mapped:executions.length,waiting:executions.filter(e=>['bound','waiting','result_saved'].includes(e.phase)).length,needsCheck:executions.filter(e=>e.phase==='needs_check').length,results:(await this.store.files('results')).length,quarantined:(await this.store.files('quarantine')).length,lastError:this.lastError};}
}
