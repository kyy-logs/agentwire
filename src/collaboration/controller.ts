import {actionDigest,derivedId,sameActor,validateActor} from './model.ts';import type {Actor,ActionRequest,ActionRecord,TaskRecord,ActionEvidenceReader} from './model.ts';
import {CollaborationStore} from './store.ts';import {verifyActionOwnership} from './native-actions.ts';import {validateResult,clipUtf8} from '../lifecycle/model.ts';import type {CapturedResult} from '../lifecycle/model.ts';import type {AgentBinding,Clock,MessageInput,MessageRecord,SubmitOptions} from '../model.ts';import type {DispatchIntent} from '../native/model.ts';
type Options={store:CollaborationStore;clock:Clock;connectionId:string;bindings:AgentBinding[];proof:ActionEvidenceReader;inputs:()=>Promise<DispatchIntent[]>;commitTransport:(i:MessageInput)=>Promise<MessageRecord>;readTransport?:(id:string)=>Promise<MessageRecord|undefined>;isStopped:()=>boolean};
export class CollaborationController{
 o:Options;store:CollaborationStore;constructor(o:Options){this.o=o;this.store=o.store;}
 async isStructuredFamily(id:string){return !!await this.store.getTask(id);}
 async task(id:string){const t=await this.store.getTask(id);if(!t)throw Error('collaboration_task_missing');if(t.connectionId!==this.o.connectionId)throw Error('collaboration_connection_mismatch');return t;}
 guard(t:TaskRecord){if(this.o.isStopped())throw Error('collaboration_shutting_down');if(Date.parse(t.deadline)<=+this.o.clock.now())throw Error('collaboration_expired');if(['expired','stopped','completed','needs_check'].includes(t.phase))throw Error('collaboration_task_paused');for(const actor of [t.initiator,t.executor])if(!this.o.bindings.some(b=>b.kind===actor.provider&&b.sessionId===actor.sessionId))throw Error('collaboration_binding_mismatch');}
 async openOne(input:MessageInput,actor:Actor){validateActor(actor);if(input.kind!=='task'||input.from!==actor.provider||input.returnMode!=='auto')throw Error('invalid_collaboration_task');const source=this.o.bindings.find(b=>b.agentId===input.from),target=this.o.bindings.find(b=>b.agentId===input.to);if(!source||source.sessionId!==actor.sessionId||source.kind!==actor.provider||!target)throw Error('source_session_mismatch');const task:TaskRecord={schemaVersion:1,taskId:input.messageId,connectionId:this.o.connectionId,initiator:actor,executor:{provider:target.kind as any,sessionId:target.sessionId},phase:'working',revision:0,deadline:new Date(+this.o.clock.now()+1800000).toISOString(),executions:1,questions:0,currentMessageId:input.messageId,businessVerdict:'unverified',initialMessage:input,initialDispatch:'prepared'};
 const saved=await this.store.createTask(task,input);if(saved.initialDispatch==='prepared'){this.guard(saved);await this.o.commitTransport(saved.initialMessage);await this.store.markInitialCommitted(task.taskId);}return (await this.task(task.taskId));
 }
 async submitActionOne(request:ActionRequest){const requestSha256=actionDigest(request),old=await this.store.getAction(request.operationId);if(old){if(old.requestSha256!==requestSha256)throw Error('collaboration_operation_conflict');return old;}
 const task=await this.task(request.taskId);this.guard(task);this.check(task,request);return this.store.putAction({schemaVersion:1,request,requestSha256,phase:'pending_verification'});}
 check(t:TaskRecord,r:ActionRequest){
 const role=['question','deliver'].includes(r.kind)?t.executor:t.initiator;if(!sameActor(role,r.actor))throw Error('collaboration_role_mismatch');
 if(['question','deliver'].includes(r.kind)&&['question_pending','delivery_pending'].includes(t.phase))throw Error('collaboration_terminal_action_exists');
 if(r.expectedRevision!==t.revision)throw Error('collaboration_revision_conflict');
 if(['question','deliver'].includes(r.kind)&&t.phase!=='working'||r.kind==='answer'&&t.phase!=='waiting_answer'||['accept','revise'].includes(r.kind)&&t.phase!=='waiting_acceptance')throw Error('collaboration_phase_mismatch');
 if(r.kind==='question'&&t.questions>=3)throw Error('collaboration_question_budget_exhausted');
 if(['answer','revise'].includes(r.kind)&&t.executions>=6)throw Error('collaboration_execution_budget_exhausted');
 if(r.kind==='answer'&&r.questionId!==t.questionId)throw Error('collaboration_question_mismatch');
 if(['accept','revise'].includes(r.kind)&&r.deliveryId!==t.deliveryId)throw Error('collaboration_delivery_mismatch');
 }
 async advanceActionOne(id:string){let a=await this.store.getAction(id);if(!a)throw Error('collaboration_action_missing');if(['committed','needs_check'].includes(a.phase))return a;let t=await this.task(a.request.taskId);this.guard(t);
 if(a.phase==='pending_verification'){const e=await this.o.proof.proveAction(a.request);if(['pending','limit','unavailable'].includes(e.status)){a.errorCode=e.status==='pending'?undefined:e.errorCode??'collaboration_action_unverified';await this.store.saveAction(a);return a;}if(e.status!=='verified'){a.phase='needs_check';a.errorCode='collaboration_action_unverified';a.evidence=e;await this.store.saveAction(a);return a;}try{verifyActionOwnership(t,a.request,e,await this.o.inputs());this.check(t,a.request);}catch(error:any){a.phase='needs_check';a.errorCode=error.message;await this.store.saveAction(a);return a;}if(a.result&&(a.result.ref.nativeExecutionId!==e.ref.nativeExecutionId||!sameActor(a.result.ref,e.ref))){a.phase='needs_check';a.errorCode='collaboration_execution_mismatch';await this.store.saveAction(a);await this.pauseOne(t,a.errorCode);return a;}a.evidence=e;a.phase='verified';await this.store.saveAction(a);}
 if(['question','deliver'].includes(a.request.kind)){
 if(a.phase==='verified'){if(a.checkpoints?.intent){await this.store.commitTransition(id,'intent',a.checkpoints.intent.nextTask);}else{this.check(t,a.request);const next={...t,revision:t.revision+1,phase:a.request.kind==='question'?'question_pending':'delivery_pending',...(a.request.kind==='question'?{questionId:id,questions:t.questions+1}:{deliveryId:id})} as TaskRecord;await this.store.commitTransition(id,'intent',next);}a=(await this.store.getAction(id))!;a.phase='waiting_stop';await this.store.saveAction(a);}
 if(a.phase==='waiting_stop'&&a.result)return this.finishTerminal(a);if(a.phase==='prepared')return this.finishOutbox(a);return a;
 }
 if(a.phase==='verified'){this.check(t,a.request);const next={...t,revision:t.revision+1} as TaskRecord;
 if(a.request.kind==='accept'){next.phase='completed';next.businessVerdict='unverified';}else{next.phase='working';next.executions++;next.currentMessageId=derivedId(id+':followup');delete next.lastError;a.outbox={messageId:next.currentMessageId,kind:'followup',from:a.request.actor.provider,replyTo:t.currentMessageId,body:a.request.body!};}
 a.phase='prepared';a.checkpoints={intent:{expectedRevision:t.revision,nextTask:next,phase:'prepared'}};await this.store.saveAction(a);}
 return this.finishOutbox(a);
 }
 async finishOutbox(a:ActionRecord){const cp=a.checkpoints?.terminal??a.checkpoints?.intent;if(!cp)throw Error('collaboration_checkpoint_missing');let t=await this.task(a.request.taskId);if(a.request.kind==='accept'&&t.phase==='completed')this.guardForCommit(t,'accept');else this.guard(t);const key=a.checkpoints?.terminal?'terminal':'intent';await this.store.commitTransition(a.request.operationId,key,cp.nextTask);t=await this.task(t.taskId);this.guardForCommit(t,a.request.kind);
 if(a.outbox)await this.o.commitTransport(a.outbox);a=(await this.store.getAction(a.request.operationId))!;a.phase='committed';await this.store.saveAction(a);return a;
 }
 guardForCommit(t:TaskRecord,kind:string){if(kind==='accept'){if(this.o.isStopped())throw Error('collaboration_shutting_down');if(Date.parse(t.deadline)<=+this.o.clock.now())throw Error('collaboration_expired');return;}this.guard(t);}
 async finishTerminal(a:ActionRecord){const t=await this.task(a.request.taskId);this.guard(t);const result=a.result!;if(result.nativeOutcome!=='response_ended'){await this.pauseOne(t,'collaboration_native_'+result.nativeOutcome);a.phase='needs_check';a.errorCode='collaboration_native_'+result.nativeOutcome;await this.store.saveAction(a);return a;}
 const question=a.request.kind==='question',id=derivedId(a.request.operationId+':reply'),next:TaskRecord={...t,revision:t.revision+1,phase:question?'waiting_answer':'waiting_acceptance',currentMessageId:id,...(!question?{delivery:result}:{})};
 const body=question?a.request.body!:'[交付报告；等待发起方验收]\n'+clipUtf8(result.body,60000);
 a.outbox={messageId:id,kind:'reply',from:t.executor.provider,replyTo:result.messageId,body};a.terminalEventKey=result.terminalEventKey;a.phase='prepared';a.checkpoints={...a.checkpoints,terminal:{expectedRevision:t.revision,nextTask:next,phase:'prepared'}};await this.store.saveAction(a);return this.finishOutbox(a);
 }
 async pauseOne(t:TaskRecord,error:string){if(['stopped','expired','completed'].includes(t.phase))return;t.phase='needs_check';t.lastError=error;await this.store.write('tasks',t.taskId,t);}
 async consumeTerminalOne(result:CapturedResult):Promise<{handled:boolean;reply?:MessageRecord}>{
 validateResult(result);const tasks=(await this.store.listTasks()).filter(t=>t.currentMessageId===result.messageId||t.taskId===result.messageId);if(!tasks.length){const actions=await this.store.listActions();if(actions.some(a=>a.result?.messageId===result.messageId))return {handled:true};return {handled:false};}if(tasks.length!==1)throw Error('collaboration_execution_mismatch');let t=tasks[0];if(['stopped','expired','completed'].includes(t.phase))return {handled:true};
 if(t.currentMessageId!==result.messageId)return {handled:true};this.guard(t);
 if(!sameActor(result.ref,t.executor))return {handled:true};const actions=(await this.store.listActions()).filter(a=>a.request.taskId===t.taskId&&['question','deliver'].includes(a.request.kind)&&a.request.expectedRevision===(['question_pending','delivery_pending'].includes(t.phase)?t.revision-1:t.revision));
 if(!actions.length){await this.pauseOne(t,'collaboration_action_required');return {handled:true};}
 if(actions.length!==1){await this.pauseOne(t,'collaboration_terminal_action_conflict');return {handled:true};}
 let a=actions[0];if(a.evidence?.status==='verified'&&a.evidence.ref.nativeExecutionId!==result.ref.nativeExecutionId){await this.pauseOne(t,'collaboration_execution_mismatch');return {handled:true};}
 if(a.result&&a.result.terminalEventKey!==result.terminalEventKey){await this.pauseOne(t,'collaboration_terminal_event_conflict');return {handled:true};}
 a.result??=result;await this.store.saveAction(a);a=await this.advanceActionOne(a.request.operationId);const reply=a.phase==='committed'&&a.outbox?await this.o.readTransport?.(a.outbox.messageId):undefined;return {handled:true,...(reply?{reply}:{})};
 }
 async drainOne(){
 for(const t of await this.store.listTasks()){if(this.o.isStopped())return;
 if(!['completed','expired','stopped'].includes(t.phase)&&Date.parse(t.deadline)<=+this.o.clock.now()){t.phase='expired';t.lastError='collaboration_expired';await this.store.write('tasks',t.taskId,t);continue;}
 if(t.initialDispatch==='prepared'&&!['stopped','expired','completed','needs_check'].includes(t.phase)){this.guard(t);await this.o.commitTransport(t.initialMessage);await this.store.markInitialCommitted(t.taskId);}}
 for(const a of await this.store.listActions()){if(this.o.isStopped())return;const t=await this.task(a.request.taskId);
 if(['stopped','expired'].includes(t.phase)){if(a.phase!=='committed'){a.phase='committed';a.errorCode=t.phase==='stopped'?'bus_stopped_native_agent_not_cancelled':'collaboration_expired';await this.store.saveAction(a);}continue;}
 if(a.phase==='prepared'&&a.request.kind==='accept'&&t.phase==='completed'){await this.finishOutbox(a);continue;}
 if(!['completed','needs_check'].includes(t.phase))await this.advanceActionOne(a.request.operationId);}}
 async stopOne(id:string){const t=await this.store.getTask(id);if(!t)return;if(t.phase==='completed')return;t.phase='stopped';t.lastError='bus_stopped_native_agent_not_cancelled';await this.store.write('tasks',id,t);for(const a of await this.store.listActions())if(a.request.taskId===id&&a.phase!=='committed'){a.phase='committed';a.errorCode='bus_stopped_native_agent_not_cancelled';await this.store.saveAction(a);}}
 async contextOne(messageId:string):Promise<SubmitOptions['collaboration']>{const tasks=await this.store.listTasks();let t=tasks.find(t=>t.taskId===messageId);if(!t){const a=(await this.store.listActions()).find(a=>a.outbox?.messageId===messageId);if(a)t=(a.checkpoints?.terminal??a.checkpoints?.intent)?.nextTask;}if(!t)return;return {taskId:t.taskId,revision:t.taskId===messageId?0:t.revision,phase:t.taskId===messageId?'working':t.phase,questionId:t.questionId,deliveryId:t.deliveryId};}
}
