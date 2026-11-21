import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {temp,clock,taskInput} from '../helpers.ts';
import {CollaborationStore} from '../../src/collaboration/store.ts';
import {CollaborationController} from '../../src/collaboration/controller.ts';
import {actionDigest} from '../../src/collaboration/model.ts';

async function setup(t:any,timeoutMinutes?:number){
 const root=await temp(t),store=new CollaborationStore(root),time=clock(),turn=randomUUID();
 const initiator:any={provider:'codex',sessionId:randomUUID()},executor:any={provider:'claude',sessionId:randomUUID()},sent=new Map(),maps:any[]=[];
 const options:any={store,clock:time,connectionId:randomUUID(),bindings:[initiator,executor].map(a=>({agentId:a.provider,kind:a.provider,sessionId:a.sessionId})),proof:{async proveAction(r:any){return {status:'verified',ref:{...r.actor,nativeExecutionId:turn},human:true,evidenceRef:'fixture',requestSha256:actionDigest(r)};}},inputs:async()=>maps,commitTransport:async(i:any)=>{sent.set(i.messageId,i);return {message:{...i,taskId:input.messageId}};},isStopped:()=>false};
 const c=new CollaborationController(options),input=taskInput({returnMode:'auto'});
 const task=await c.openOne(input,initiator,{timeoutMinutes} as any);
 maps.push({phase:'mapped',provider:'claude',targetSessionId:executor.sessionId,nativeExecutionId:turn,messageId:task.taskId});
 const deliver:any={operationId:randomUUID(),taskId:task.taskId,actor:executor,kind:'deliver',expectedRevision:0};
 const stop:any={messageId:task.taskId,ref:{...executor,nativeExecutionId:turn},terminalEventKey:'1'.repeat(64),nativeOutcome:'response_ended',businessVerdict:'unverified',body:'Report',truncated:false};
 return {root,store,time,c,options,input,task,initiator,executor,sent,deliver,stop};
}

test('one-hour structured creation pins its deadline across replay, questions and answers',async t=>{
 const s=await setup(t,60),deadline=s.task.deadline;
 assert.equal(Date.parse(deadline)-s.time.value,3600000);
 s.time.value+=31*60000;
 assert.equal((await s.c.openOne(s.input,s.initiator,{timeoutMinutes:60} as any)).deadline,deadline);
 await assert.rejects(s.c.openOne(s.input,s.initiator,{timeoutMinutes:30} as any),/collaboration_operation_conflict/);
 const q={...s.deliver,kind:'question' as const,body:'Parameters?'};
 await s.c.submitActionOne(q);await s.c.advanceActionOne(q.operationId);await s.c.consumeTerminalOne(s.stop);
 const answer:any={operationId:randomUUID(),taskId:s.task.taskId,actor:s.initiator,kind:'answer',expectedRevision:2,questionId:q.operationId,body:'17 and 19'};
 await s.c.submitActionOne(answer);await s.c.advanceActionOne(answer.operationId);
 assert.equal((await s.store.getTask(s.task.taskId))!.deadline,deadline);
 s.time.value=Date.parse(deadline);
 await assert.rejects(s.c.submitActionOne({...s.deliver,operationId:randomUUID(),expectedRevision:3}),/collaboration_expired/);
});

test('default remains thirty minutes; invalid timeout cannot create or send a task',async t=>{
 const s=await setup(t);assert.equal(Date.parse(s.task.deadline)-s.time.value,1800000);
 for(const timeoutMinutes of [0,1,59,61,NaN,'60',null]){
  const input=taskInput({returnMode:'auto'});
  await assert.rejects(s.c.openOne(input,s.initiator,{timeoutMinutes} as any),/invalid_collaboration_timeout/);
  assert.equal(await s.store.getTask(input.messageId),undefined);assert.equal(s.sent.has(input.messageId),false);
 }
});

test('expiry while native proof is pending settles only that task and recovery continues',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);
 s.options.proof={async proveAction(){s.time.value=Date.parse(s.task.deadline);return {status:'pending'};}};
 await s.c.drainOne();
 assert.equal((await s.store.getTask(s.task.taskId))!.phase,'expired');
 assert.equal((await s.store.getAction(s.deliver.operationId))!.phase,'committed');
 assert.equal(s.sent.size,1);await s.c.drainOne();
 const next=await s.c.openOne(taskInput({returnMode:'auto'}),s.initiator);assert.equal(next.phase,'working');
});

test('expiry between task scan and action processing does not escape the recovery worker',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);
 const list=s.store.listActions.bind(s.store);s.store.listActions=async()=>{const actions=await list();s.time.value=Date.parse(s.task.deadline);return actions;};
 await s.c.drainOne();assert.equal((await s.store.getTask(s.task.taskId))!.phase,'expired');
 assert.equal((await s.store.getAction(s.deliver.operationId))!.errorCode,'collaboration_expired');
});

test('late native Stop is consumed as expiry without a reply or worker failure',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);await s.c.advanceActionOne(s.deliver.operationId);
 s.time.value=Date.parse(s.task.deadline);
 assert.deepEqual(await s.c.consumeTerminalOne(s.stop),{handled:true});
 assert.equal((await s.store.getTask(s.task.taskId))!.phase,'expired');assert.equal(s.sent.size,1);
});

test('accept crash after durable completion is finalized after deadline without accepting any new late action',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);await s.c.advanceActionOne(s.deliver.operationId);await s.c.consumeTerminalOne(s.stop);
 const accept:any={operationId:randomUUID(),taskId:s.task.taskId,actor:s.initiator,kind:'accept',expectedRevision:2,deliveryId:s.deliver.operationId};
 await s.c.submitActionOne(accept);
 const broken=new CollaborationStore(s.root,{afterWrite:async file=>{if(file.includes('tasks')&&(await s.store.getTask(s.task.taskId))!.phase==='completed')throw Error('crash_after_completed_task');}});
 await assert.rejects(new CollaborationController({...s.options,store:broken}).advanceActionOne(accept.operationId),/crash_after_completed_task/);
 assert.equal((await s.store.getTask(s.task.taskId))!.phase,'completed');
 assert.equal((await s.store.getAction(accept.operationId))!.phase,'prepared');
 s.time.value=Date.parse(s.task.deadline)+1;await s.c.drainOne();await s.c.drainOne();
 assert.equal((await s.store.getAction(accept.operationId))!.phase,'committed');
 assert.equal((await s.store.getTask(s.task.taskId))!.revision,3);assert.equal(s.sent.size,2);
 await assert.rejects(s.c.submitActionOne({...accept,operationId:randomUUID()}),/collaboration_expired/);
});

test('expiry handling never hides real storage corruption',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);
 s.store.listActions=async()=>{throw Error('collaboration_storage_requires_check');};
 await assert.rejects(s.c.drainOne(),/collaboration_storage_requires_check/);
 assert.equal((await s.store.getTask(s.task.taskId))!.phase,'working');
});

test('restart after saving expiry completes pending action bookkeeping without sending again',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);s.time.value=Date.parse(s.task.deadline);
 const broken=new CollaborationStore(s.root,{afterWrite:async file=>{if(file.includes('tasks')&&(await s.store.getTask(s.task.taskId))!.phase==='expired')throw Error('crash_after_expired_task');}});
 await assert.rejects(new CollaborationController({...s.options,store:broken}).drainOne(),/crash_after_expired_task/);
 assert.equal((await s.store.getAction(s.deliver.operationId))!.phase,'pending_verification');
 await s.c.drainOne();await s.c.drainOne();
 assert.equal((await s.store.getAction(s.deliver.operationId))!.phase,'committed');
 assert.equal((await s.store.getAction(s.deliver.operationId))!.errorCode,'collaboration_expired');assert.equal(s.sent.size,1);
});

test('deadline crossing during the accept commit finishes bookkeeping but a fresh late accept stays rejected',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);await s.c.advanceActionOne(s.deliver.operationId);await s.c.consumeTerminalOne(s.stop);
 const accept:any={operationId:randomUUID(),taskId:s.task.taskId,actor:s.initiator,kind:'accept',expectedRevision:2,deliveryId:s.deliver.operationId};await s.c.submitActionOne(accept);
 const store=new CollaborationStore(s.root,{afterWrite:async file=>{if(file.includes('tasks')&&(await s.store.getTask(s.task.taskId))!.phase==='completed')s.time.value=Date.parse(s.task.deadline)+1;}});
 await new CollaborationController({...s.options,store}).advanceActionOne(accept.operationId);
 assert.equal((await s.store.getTask(s.task.taskId))!.phase,'completed');assert.equal((await s.store.getAction(accept.operationId))!.phase,'committed');
 const x=await setup(t);await x.c.submitActionOne(x.deliver);await x.c.advanceActionOne(x.deliver.operationId);await x.c.consumeTerminalOne(x.stop);x.time.value=Date.parse(x.task.deadline);
 await assert.rejects(x.c.submitActionOne({...accept,operationId:randomUUID(),taskId:x.task.taskId,actor:x.initiator,deliveryId:x.deliver.operationId}),/collaboration_expired/);
 assert.equal((await x.store.getTask(x.task.taskId))!.phase,'waiting_acceptance');
});

test('completed accept recovery refuses a checkpoint that differs from the durable task',async t=>{
 const s=await setup(t);await s.c.submitActionOne(s.deliver);await s.c.advanceActionOne(s.deliver.operationId);await s.c.consumeTerminalOne(s.stop);
 const accept:any={operationId:randomUUID(),taskId:s.task.taskId,actor:s.initiator,kind:'accept',expectedRevision:2,deliveryId:s.deliver.operationId};await s.c.submitActionOne(accept);
 const broken=new CollaborationStore(s.root,{afterWrite:async file=>{if(file.includes('tasks')&&(await s.store.getTask(s.task.taskId))!.phase==='completed')throw Error('crash');}});
 await assert.rejects(new CollaborationController({...s.options,store:broken}).advanceActionOne(accept.operationId),/crash/);
 const task=(await s.store.getTask(s.task.taskId))!;task.lastError='unexpected_later_edit';await s.store.write('tasks',task.taskId,task);s.time.value=Date.parse(task.deadline)+1;
 await assert.rejects(s.c.drainOne(),/collaboration_revision_conflict/);assert.equal((await s.store.getAction(accept.operationId))!.phase,'prepared');
});
