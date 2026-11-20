import {CollaborationController} from './collaboration/controller.ts';
import type {CollaborationStore} from './collaboration/store.ts';
import type {ActionEvidenceReader} from './collaboration/model.ts';
import type {Timing} from './latency.ts';
import type {NativeDispatcher} from './native/dispatcher.ts';
import type {DispatchIntent} from './native/model.ts';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {defaultPolicy,realClock,assertId,assertAgent,validateMessage} from './model.ts';
import type {AgentAdapter,AgentBinding,AgentMessage,MessageInput,MessageRecord,MessageStore,Clock,SubmitResult} from './model.ts';
import {validateResult,clipUtf8,digest,resultHeading} from './lifecycle/model.ts';
import type {CapturedResult} from './lifecycle/model.ts';
type Options={onTiming?:(event:Timing)=>Promise<void>;store:MessageStore;adapters:AgentAdapter[];bindings:AgentBinding[];clock?:Clock;policy?:typeof defaultPolicy;saveBindings?:(b:AgentBinding[])=>Promise<void>;newAutoWireVersion?:'legacy'|'clean-v1';nativeDispatcher?:NativeDispatcher;connectionId?:string};
const terminal=new Set(['completed','delivered','failed','expired','stopped']);
const expiredReplyCheck=(r:MessageRecord)=>r.state==='expired'&&r.message.schemaVersion===2&&r.message.kind==='reply'&&r.attempts>0&&!!r.activeAttemptId;
export class LocalBus {
  store:MessageStore;adapters:Map<string,AgentAdapter>;bindings:Map<string,AgentBinding>;clock:Clock;policy:typeof defaultPolicy;chain:Promise<unknown>=Promise.resolve();saveBindings?:Options['saveBindings'];
  collaboration?:CollaborationController;
  enableCollaboration(o:{store:CollaborationStore;proof:ActionEvidenceReader}){if(!this.connectionId)throw Error('collaboration_connection_required');this.collaboration=new CollaborationController({...o,clock:this.clock,connectionId:this.connectionId,bindings:[...this.bindings.values()],inputs:async()=>this.nativeDispatcher?this.nativeDispatcher.store.list():[],commitTransport:i=>this.acceptOne(i,true),readTransport:id=>this.store.get(id),isStopped:()=>this.dispatchStopped});return this.collaboration;}
  onTiming?:Options['onTiming'];
  async timing(event:Timing){try{await this.onTiming?.(event);}catch{}}
  nativeDispatcher?:NativeDispatcher;connectionId?:string;dispatchStopped=false;newAutoWireVersion:'legacy'|'clean-v1';
  constructor(o:Options){this.onTiming=o.onTiming;this.nativeDispatcher=o.nativeDispatcher;this.connectionId=o.connectionId;this.newAutoWireVersion=o.newAutoWireVersion||'legacy';this.store=o.store;this.adapters=new Map(o.adapters.map(a=>[a.kind,a]));this.bindings=new Map(o.bindings.map(b=>[b.agentId,{...b}]));this.clock=o.clock||realClock;this.policy=o.policy||defaultPolicy;this.saveBindings=o.saveBindings;}
  serial<T>(fn:()=>Promise<T>):Promise<T>{const p=this.chain.then(fn);this.chain=p.catch(()=>{});return p;}
  now(){return this.clock.now().toISOString();}
  requestShutdown(){this.dispatchStopped=true;}
  binding(id:string){const b=this.bindings.get(id);if(!b)throw new Error('unknown_agent');return b;}
  async update(r:MessageRecord){r.updatedAt=this.now();await this.store.replace(r);return r;}
  async bind(b:AgentBinding){return this.serial(async()=>{
    assertAgent(b.agentId);assertId(b.sessionId);if(!this.adapters.has(b.kind)||!path.isAbsolute(b.workspaceRoot))throw new Error('invalid_binding');
    const old=this.bindings.get(b.agentId);
    if(old&&!isDeepStrictEqual(old,b)&&(await this.store.list()).some(r=>[r.message.from,r.message.to].includes(b.agentId)))throw new Error('binding_in_use_use_new_agent_id');
    const next=[...this.bindings.values()].filter(x=>x.agentId!==b.agentId).concat({...b});await this.saveBindings?.(next);this.bindings.set(b.agentId,{...b});
    return {binding:b,probe:await this.adapters.get(b.kind)!.probe(b)};
  });}
  async accept(input:MessageInput):Promise<MessageRecord>{return this.serial(()=>this.acceptOne(input));}
  async replyCurrent(input:Omit<MessageInput,'replyTo'|'to'>):Promise<MessageRecord>{return this.serial(async()=>{
    if(!input||Object.keys(input).some(k=>!['messageId','kind','from','body'].includes(k))||input.kind!=='reply')throw new Error('invalid_input');
    assertId(input.messageId);assertAgent(input.from);const binding=this.binding(input.from);
    const old=await this.store.get(input.messageId);
    // Resolve a retry by its original outbound ID before looking at newer tasks.
    if(old){if(old.message.kind!=='reply')throw new Error('conflict');return this.acceptOne({...input,replyTo:old.message.replyTo});}
    const all=await this.store.list();const candidates=all.filter(r=>{
      const m=r.message,root=all.find(x=>x.message.messageId===m.taskId);
      return m.kind!=='reply'&&m.to===input.from&&m.targetSessionId===binding.sessionId&&['submitted','needs_check'].includes(r.state)&&r.receipt?.status==='accepted'
        &&root&&!root.stoppedAt&&!['stopped','expired'].includes(root.state)&&Date.parse(root.message.expiresAt)>+this.clock.now()
        &&!all.some(x=>x.message.replyTo===m.messageId&&x.message.kind==='reply');
    });
    if(candidates.length!==1)throw new Error(candidates.length?'ambiguous_current_task':'no_current_task');
    return this.acceptOne({...input,replyTo:candidates[0].message.messageId});
  });}
  private async acceptOne(input:MessageInput,structuredInternal=false):Promise<MessageRecord>{
    if(!input||Object.keys(input).some(k=>!['messageId','kind','from','to','replyTo','body','returnMode'].includes(k)))throw new Error('invalid_input');
    if(input.returnMode!==undefined&&(!['manual','auto'].includes(input.returnMode)||input.kind!=='task'))throw new Error('invalid_return_mode');
    assertId(input.messageId);assertAgent(input.from);if(!['task','reply','followup'].includes(input.kind))throw new Error('invalid_kind');
    if(!structuredInternal&&this.collaboration){const parent=input.replyTo?await this.store.get(input.replyTo):undefined;const family=parent?.message.taskId??input.messageId;if(await this.collaboration.isStructuredFamily(family))throw Error('collaboration_action_required');}
    const old=await this.store.get(input.messageId);
    if(old){const m=old.message;if((input.kind==='task'&&(m.returnMode??'manual')!==(input.returnMode??'manual'))||m.kind!==input.kind||m.from!==input.from||m.body!==input.body||m.replyTo!==input.replyTo||(input.kind==='task'?m.to!==input.to:input.to!==undefined))throw new Error('conflict');if(m.kind==='reply'&&!old.late){const parent=await this.store.get(m.replyTo!);if(parent&&!['stopped','expired'].includes(parent.state)&&!parent.stoppedAt&&parent.state!=='completed'){parent.state='completed';parent.resultRef=m.messageId;await this.update(parent);}}return old;}
    this.binding(input.from);const all=await this.store.list();let m:AgentMessage,late=false;
    if(input.kind==='task'){
      if(input.replyTo||!input.to)throw new Error('invalid_task');const target=this.binding(input.to);
      m={schemaVersion:1,messageId:input.messageId,taskId:input.messageId,kind:'task',from:input.from,to:input.to,targetSessionId:target.sessionId,body:input.body,createdAt:this.now(),expiresAt:new Date(+this.clock.now()+this.policy.taskTtlMs).toISOString(),executionIndex:1,...(input.returnMode==='auto'?{returnMode:'auto' as const}:{})};
    }else{
      if(input.to!==undefined||!input.replyTo)throw new Error('invalid_reference');assertId(input.replyTo);
      const parent=await this.store.get(input.replyTo);if(!parent)throw new Error('unknown_reference');const p=parent.message;
      if(input.from!==p.to)throw new Error('invalid_direction');if(this.binding(input.from).sessionId!==p.targetSessionId)throw new Error('source_session_mismatch');
      const family=all.filter(r=>r.message.taskId===p.taskId),root=family.find(r=>r.message.messageId===p.taskId);if(!root)throw new Error('missing_root');
      late=family.some(r=>r.stoppedAt||['stopped','expired'].includes(r.state))||Date.parse(root.message.expiresAt)<=+this.clock.now();
      if(input.kind==='reply'){
        if(p.kind==='reply')throw new Error('reply_to_reply');if(family.some(r=>r.message.kind==='reply'&&r.message.replyTo===p.messageId))throw new Error('already_replied');
        if(parent.attempts===0)throw new Error('task_not_submitted');
      }else{
        if(late||family.some(r=>r.state==='needs_check'))throw new Error('task_paused');
        if(p.kind!=='reply')throw new Error('followup_requires_reply');
        if(family.some(r=>r.message.kind==='followup'&&r.message.replyTo===p.messageId))throw new Error('already_followed_up');
      }
      const index=input.kind==='reply'?p.executionIndex:Math.max(...family.map(r=>r.message.executionIndex))+1;
      if(index>this.policy.maxExecutions)throw new Error('execution_budget_exhausted');
      m={schemaVersion:1,messageId:input.messageId,taskId:p.taskId,replyTo:p.messageId,kind:input.kind,from:input.from,to:p.from,targetSessionId:this.binding(p.from).sessionId,body:input.body,createdAt:this.now(),expiresAt:root.message.expiresAt,executionIndex:index,...(input.kind==='followup'&&root.message.returnMode==='auto'?{returnMode:'auto' as const}:{})};
    }
    const rootVersion=input.kind==='task'?(input.returnMode==='auto'?this.newAutoWireVersion:'legacy'):(await this.store.get(m.taskId))!.message.schemaVersion===2?'clean-v1':'legacy';
    if(rootVersion==='clean-v1'){const sourceSessionId=this.binding(input.from).sessionId;if(input.kind!=='task'){const parent=(await this.store.get(input.replyTo!))!.message;if(parent.schemaVersion!==2)throw Error('wire_version_conflict');m.targetSessionId=parent.sourceSessionId;}m={...m,schemaVersion:2,wireVersion:'clean-v1',sourceSessionId};}
    validateMessage(m);let {record}=await this.store.putNew(m);
    if(late){record={...record,late:true,state:'stopped',lastError:'late_reply_no_forward'};await this.update(record);}
    if(input.kind==='reply'&&!late){const parent=(await this.store.get(input.replyTo!))!;parent.state='completed';parent.resultRef=m.messageId;await this.update(parent);}
    return record;
  }
  async status(taskId?:string){return this.serial(async()=>{if(taskId)assertId(taskId);return (await this.store.list()).filter(r=>!taskId||r.message.taskId===taskId);});}
  applyCapturedResult(result:CapturedResult){return this.serial(()=>this.applyCapturedResultOne(result));}
  async applyCapturedResultOne(result:CapturedResult):Promise<MessageRecord|undefined>{
    const captureStarted=performance.now();validateResult(result);const parent=await this.store.get(result.messageId);if(!parent)throw new Error('captured_parent_missing');
    if(this.collaboration&&await this.collaboration.isStructuredFamily(parent.message.taskId)){const consumed=await this.collaboration.consumeTerminalOne(result);if(consumed.handled)return consumed.reply;}
    const binding=this.binding(parent.message.to);
    if(parent.returnMode!=='auto'||parent.message.kind==='reply'||parent.message.targetSessionId!==result.ref.sessionId||binding.kind!==result.ref.provider||parent.attempts<1)throw new Error('captured_parent_mismatch');
    const family=(await this.store.list()).filter(r=>r.message.taskId===parent.message.taskId),root=family.find(r=>r.message.messageId===parent.message.taskId);
    if(!root)throw new Error('missing_root');
    if(this.dispatchStopped||family.some(r=>r.stoppedAt||['stopped','expired'].includes(r.state))||Date.parse(root.message.expiresAt)<=+this.clock.now())return;
    const hex=digest('local-agent-bus:auto-reply:'+result.messageId);
    const id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);
    const old=family.find(r=>r.message.kind==='reply'&&r.message.replyTo===result.messageId);
    if(old&&old.message.messageId!==id)return; // First durable manual reply wins.
    const clean=parent.message.schemaVersion===2;const prefix=clean?'[本回合已结束；业务结论未验证]\n':resultHeading(result.nativeOutcome);
    const suffix=result.truncated&&clean?'\n[结果已截断，完整内容可在本地状态中查看]':result.truncated?`\n[摘要已截断；本地结果 ${result.artifactRef}；SHA256 ${result.sha256}]`:'';
    const body=prefix+clipUtf8(result.body,2048-Buffer.byteLength(prefix+suffix))+suffix;
    const reply=await this.acceptOne({messageId:id,kind:'reply',from:parent.message.to,replyTo:result.messageId,body});
    const latest=(await this.store.get(result.messageId))!;
    latest.completion={nativeOutcome:result.nativeOutcome,businessVerdict:'unverified',eventKey:result.terminalEventKey,artifactRef:result.artifactRef,sha256:result.sha256,truncated:result.truncated};
    await this.update(latest);if(!old)await this.timing({stage:'automatic_result_committed',messageId:result.messageId,taskId:parent.message.taskId,state:latest.state,durationsMs:{captureMs:performance.now()-captureStarted}});return reply;
  }
  async tick(){return this.serial(async()=>{
    await this.collaboration?.drainOne();
    let all=await this.store.list();
    for(const r of all){
      if(terminal.has(r.state))continue;
      if(Date.parse(r.message.expiresAt)<=+this.clock.now()){r.state='expired';r.lastError='root_deadline_no_native_cancel';await this.update(r);continue;}
      if(r.state==='submitted'&&r.resultDeadlineAt&&Date.parse(r.resultDeadlineAt)<=+this.clock.now()){r.state='needs_check';r.lastError='result_timeout_no_native_cancel';await this.update(r);}
      // A reply can arrive after the adapter's short observation window. Read
      // exact native evidence again; never resend an unknown delivery.
      if(['submitted','needs_check'].includes(r.state)&&(r.message.kind==='reply'||r.message.schemaVersion===2))await this.reconcileRecord(r);
    }
    all=await this.store.list();
    for(const r of all){
      if(this.dispatchStopped)break;
      if(r.state!=='pending'||r.late||r.nextAttemptAt&&Date.parse(r.nextAttemptAt)>+this.clock.now())continue;
      // A preceding adapter may have waited across this message's deadline.
      if(Date.parse(r.message.expiresAt)<=+this.clock.now()){r.state='expired';r.lastError='root_deadline_no_native_cancel';await this.update(r);continue;}
      for(const sibling of all.filter(x=>x.message.taskId===r.message.taskId)){
        if(sibling.state==='submitted'&&sibling.resultDeadlineAt&&Date.parse(sibling.resultDeadlineAt)<=+this.clock.now()){sibling.state='needs_check';sibling.lastError='result_timeout_no_native_cancel';await this.update(sibling);}
      }
      if(all.some(x=>x.message.taskId===r.message.taskId&&(x.stoppedAt||['needs_check','stopped','expired'].includes(x.state))))continue;
      if(r.message.kind!=='reply'&&all.some(x=>x.message.messageId!==r.message.messageId&&x.message.targetSessionId===r.message.targetSessionId&&x.message.kind!=='reply'&&['submitting','submitted','needs_check'].includes(x.state)))continue;
      const binding=this.binding(r.message.to);if(binding.sessionId!==r.message.targetSessionId){r.state='needs_check';r.lastError='binding_mismatch';await this.update(r);continue;}
      const adapter=this.adapters.get(binding.kind);if(!adapter){r.state='failed';r.lastError='unsupported_adapter';await this.update(r);continue;}
      if(r.message.returnMode==='auto'){r.returnMode='auto';r.dispatchNonce??=randomUUID();}
      if(r.message.schemaVersion===2){if(!this.nativeDispatcher||!this.connectionId){r.state='needs_check';r.lastError='native_dispatch_unavailable';await this.update(r);continue;}r.activeAttemptId=randomUUID();}
      r.state='submitting';r.attempts++;await this.update(r);
      // The durable submitting write itself is asynchronous. Shutdown/expiry
      // during it must not start a new side effect; no adapter call occurred.
      if(this.dispatchStopped||Date.parse(r.message.expiresAt)<=+this.clock.now()){
        r.attempts--;r.state=this.dispatchStopped?'pending':'expired';r.lastError=this.dispatchStopped?'shutdown_before_submit':'root_deadline_no_native_cancel';await this.update(r);if(this.dispatchStopped)break;continue;
      }
      const submissionStarted=performance.now(),queueAgeMs=+this.clock.now()-Date.parse(r.message.createdAt);
      let receipt:SubmitResult;
      if(r.message.schemaVersion===2){const intent:DispatchIntent={schemaVersion:1,connectionId:this.connectionId!,provider:binding.kind,targetSessionId:r.message.targetSessionId,sourceSessionId:r.message.sourceSessionId,messageId:r.message.messageId,attemptId:r.activeAttemptId!,transportId:randomUUID(),wireVersion:'clean-v1',bodySha256:digest(r.message.body),createdAt:this.now(),updatedAt:this.now(),phase:'prepared'};
        receipt=await this.nativeDispatcher!.submit(intent,transportId=>adapter.submit(binding,r.message,{wireVersion:'clean-v1',transportId,returnMode:r.returnMode,dispatchNonce:r.dispatchNonce}),()=>!this.dispatchStopped&&Date.parse(r.message.expiresAt)>+this.clock.now());
        if(receipt.errorCode==='submit_not_started'){r.attempts--;r.state=this.dispatchStopped?'pending':'expired';r.lastError=receipt.errorCode;await this.update(r);continue;}
      }else try{receipt=await adapter.submit(binding,r.message,r.returnMode==='auto'?{returnMode:'auto',dispatchNonce:r.dispatchNonce}:undefined);}catch{receipt={status:'unknown',retryable:false,errorCode:'adapter_exception'};}
      r.receipt=receipt;r.lastError=receipt.errorCode;
      if(receipt.status==='accepted'){
        r.state='submitted';r.submittedAt??=this.now();r.resultDeadlineAt??=new Date(Math.min(Date.parse(r.submittedAt)+this.policy.resultTimeoutMs,Date.parse(r.message.expiresAt))).toISOString();delete r.nextAttemptAt;
      }else if(receipt.status==='unknown'){r.state='needs_check';}
      else if(receipt.retryable&&r.attempts<this.policy.maxAttempts){r.state='pending';r.nextAttemptAt=new Date(+this.clock.now()+this.policy.retryDelaysMs[r.attempts-1]).toISOString();}
      else r.state='failed';
      await this.update(r);await this.timing({stage:'submission_settled',messageId:r.message.messageId,taskId:r.message.taskId,state:r.state,durationsMs:{queueAgeMs,submissionMs:performance.now()-submissionStarted}});
    }
    // Reminders are transport notices, not new delegation records or executions.
    // Commit the attempt before transport: a crash/unknown result never replays it.
    all=await this.store.list();
    for(const r of all){
      if(this.dispatchStopped)break;
      const now=+this.clock.now();
      if(r.message.schemaVersion===2&&r.returnMode==='auto')continue;
      if(r.state!=='submitted'||r.message.kind==='reply'||r.reminder||r.receipt?.status!=='accepted'||!r.submittedAt||!r.resultDeadlineAt
        ||now-Date.parse(r.submittedAt)<this.policy.reminderAfterMs||now>=Date.parse(r.resultDeadlineAt)||now>=Date.parse(r.message.expiresAt))continue;
      if(all.some(x=>x.message.taskId===r.message.taskId&&(x.stoppedAt||['stopped','expired','needs_check'].includes(x.state))))continue;
      const binding=this.binding(r.message.to),adapter=this.adapters.get(binding.kind);if(!adapter||binding.sessionId!==r.message.targetSessionId)continue;
      r.reminder={messageId:randomUUID(),attemptedAt:this.now(),receipt:{status:'unknown',errorCode:'reminder_attempt_committed'}};await this.update(r);
      if(this.dispatchStopped||+this.clock.now()>=Date.parse(r.resultDeadlineAt)||+this.clock.now()>=Date.parse(r.message.expiresAt)){
        r.reminder.receipt={status:'rejected',retryable:false,errorCode:'reminder_cancelled_before_submit'};await this.update(r);continue;
      }
      const notice={...r.message,messageId:r.reminder.messageId,createdAt:this.now()};
      try{r.reminder.receipt=await adapter.submit(binding,notice,{reminderFor:r.message.messageId,returnMode:r.returnMode});}
      catch{r.reminder.receipt={status:'unknown',retryable:false,errorCode:'reminder_exception'};}
      await this.update(r);
    }
  });}
  async reconcileRecord(r:MessageRecord,allowExpiredReply=false){
    const binding=this.binding(r.message.to);if(binding.sessionId!==r.message.targetSessionId)return r;
    const adapter=this.adapters.get(binding.kind);if(!adapter)return r;
    if(r.message.schemaVersion===2){const lateDelivery=allowExpiredReply&&expiredReplyCheck(r);if(r.message.kind!=='reply'&&r.state==='needs_check'&&['background_pending','stop_continuation_unverified','captured_output_incomplete','missing_terminal_flags','multiple_terminal_events','native_result_identity_mismatch','native_result_incomplete','result_timeout_no_native_cancel'].includes(r.lastError||''))return r;if(!this.nativeDispatcher||!r.activeAttemptId)return r;const i=await this.nativeDispatcher.store.get(r.activeAttemptId);if(!i){r.state='needs_check';r.lastError='native_intent_missing';await this.update(r);return r;}const e=await this.nativeDispatcher.reconcile(i);if(e.status==='limit'){r.state='needs_check';r.lastError=e.errorCode||'native_read_limit';await this.update(r);return r;}if(e.status==='conflict'){r.state='needs_check';r.lastError=e.errorCode||'native_binding_conflict';await this.update(r);return r;}if((e.status==='mapped'||e.status==='delivered')&&(['needs_check','submitted'].includes(r.state)||lateDelivery)){const evidenceRef=e.status==='mapped'?e.identity.evidenceRef:e.evidenceRef;r.state=r.message.kind==='reply'?'delivered':'submitted';if(lateDelivery)r.late=true;r.receipt={status:'accepted',evidenceRef};r.submittedAt??=this.now();r.resultDeadlineAt??=new Date(Math.min(Date.parse(r.submittedAt)+this.policy.resultTimeoutMs,Date.parse(r.message.expiresAt))).toISOString();delete r.lastError;delete r.nextAttemptAt;await this.update(r);if(r.state==='delivered')await this.timing({stage:'delivery_confirmed',messageId:r.message.messageId,taskId:r.message.taskId,state:r.state,durationsMs:{deliveryAgeMs:+this.clock.now()-Date.parse(r.message.createdAt)}});}return r;}
    let result;try{result=await adapter.reconcile(binding,r);}catch{return r;}
    // An observed inbound confirms submission, never task completion. Only explicit reply completes work.
    if(result.status==='submitted'&&['needs_check','submitted'].includes(r.state)){
      r.state=r.message.kind==='reply'?'delivered':'submitted';r.submittedAt??=this.now();r.resultDeadlineAt??=new Date(Math.min(Date.parse(r.submittedAt)+this.policy.resultTimeoutMs,Date.parse(r.message.expiresAt))).toISOString();
      r.receipt={status:'accepted',evidenceRef:result.evidenceRef,nativeId:result.nativeId||r.receipt?.nativeId};
      if(r.message.kind==='reply'){delete r.lastError;delete r.nextAttemptAt;}await this.update(r);if(r.state==='delivered')await this.timing({stage:'delivery_confirmed',messageId:r.message.messageId,taskId:r.message.taskId,state:r.state,durationsMs:{deliveryAgeMs:+this.clock.now()-Date.parse(r.message.createdAt)}});
    }
    return r;
  }
  async check(id:string){return this.serial(async()=>{assertId(id);const r=await this.store.get(id);if(!r)throw new Error('message_not_found');if(['needs_check','submitted'].includes(r.state)||expiredReplyCheck(r))await this.reconcileRecord(r,true);return r;});}
  async stop(taskId:string){return this.serial(async()=>{assertId(taskId);const family=(await this.store.list()).filter(r=>r.message.taskId===taskId);if(!family.length)throw new Error('task_not_found');const root=family.find(r=>r.message.messageId===taskId);if(!root)throw new Error('missing_root');await this.collaboration?.stopOne(taskId);root.stoppedAt??=this.now();await this.update(root);for(const r of family)if(!terminal.has(r.state)){r.state='stopped';r.lastError='bus_stopped_native_agent_not_cancelled';await this.update(r);}});}
  async recover(){return this.serial(()=>this.store.recover(this.clock.now()));}
}
