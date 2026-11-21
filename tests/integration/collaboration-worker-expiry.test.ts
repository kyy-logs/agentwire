import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {startMain} from '../../src/main.ts';
import {requestBus} from '../../src/ipc.ts';
import {atomicJson} from '../../src/store.ts';
import {temp,clock} from '../helpers.ts';
import {LocalBus} from '../../src/bus.ts';
import {FileMessageStore} from '../../src/store.ts';
import {CollaborationStore} from '../../src/collaboration/store.ts';
import {actionDigest} from '../../src/collaboration/model.ts';

test('an expected action expiry never poisons the service; genuine corrupt storage still pauses admission',async t=>{
 const root=await temp(t),time=clock(),sessionId=randomUUID(),other=randomUUID();
 await atomicJson(path.join(root,'bindings.json'),{schemaVersion:1,bindings:[{agentId:'codex',kind:'codex',sessionId,workspaceRoot:root},{agentId:'claude',kind:'claude',sessionId:other,workspaceRoot:root}]});
 const fake:any={async call(){return {data:[]};},async close(){}},reader:any={async inspect(){return {status:'missing'};}};
 const main=await startMain(root,{connectionId:randomUUID(),clock:time,intervalMs:10,quiet:true,signals:false,adapters:[],native:{client:fake,readers:{codex:reader,claude:reader}}});t.after(()=>main.close());
 const call=(op:string,payload?:any)=>requestBus(root,{requestId:randomUUID(),op,payload});
 const id=randomUUID(),open=(messageId:string)=>call('collaboration-open',{input:{messageId,kind:'task',from:'codex',to:'claude',body:'Fixture',returnMode:'auto'},actor:{provider:'codex',sessionId}});
 assert.equal((await open(id)).ok,true);
 main.bus.collaboration.o.proof={async proveAction(){time.value+=1800000;return {status:'pending'};}};
 assert.equal((await call('collaboration-action',{operationId:randomUUID(),taskId:id,kind:'deliver',expectedRevision:0,actor:{provider:'claude',sessionId:other}})).ok,true);
 const until=async(predicate:()=>Promise<boolean>)=>{const end=Date.now()+4000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,20));}assert.fail('bounded worker observation did not reach expected state');};
 await until(async()=>((await main.bus.collaboration.store.getTask(id))?.phase==='expired'));
 assert.equal((await call('health')).data.status,'running');
 const next=randomUUID();assert.equal((await open(next)).ok,true);
 await writeFile(path.join(root,'collaboration','tasks',next+'.json'),'not json');await call('wake');
 await until(async()=>(await call('health')).data.status==='storage_requires_check');
 assert.equal((await open(randomUUID())).errorCode,'storage_requires_check');
});

test('expiry during actual transport admission settles the task instead of escaping as task_paused',async t=>{
 const root=await temp(t),time=clock(),initiator:any={provider:'codex',sessionId:randomUUID()},executor:any={provider:'claude',sessionId:randomUUID()},turn=randomUUID();
 const bus=new LocalBus({store:new FileMessageStore(root,time),clock:time,connectionId:randomUUID(),adapters:[],bindings:[initiator,executor].map(a=>({agentId:a.provider,kind:a.provider,sessionId:a.sessionId,workspaceRoot:root}))});
 const c=bus.enableCollaboration({store:new CollaborationStore(root),proof:{async proveAction(r){return {status:'verified',human:true,ref:{...r.actor,nativeExecutionId:turn},evidenceRef:'fixture',requestSha256:actionDigest(r)};}}});
 const input:any={messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'Fixture',returnMode:'auto'},task=await c.openOne(input,initiator);
 c.o.inputs=async()=>[{phase:'mapped',provider:'claude',targetSessionId:executor.sessionId,nativeExecutionId:turn,messageId:task.taskId} as any];
 const record=(await bus.store.get(task.taskId))!;record.attempts=1;record.state='submitted';await bus.update(record);
 const delivery:any={operationId:randomUUID(),taskId:task.taskId,kind:'deliver',expectedRevision:0,actor:executor};await c.submitActionOne(delivery);await c.advanceActionOne(delivery.operationId);
 await c.consumeTerminalOne({messageId:task.taskId,ref:{...executor,nativeExecutionId:turn},terminalEventKey:'c'.repeat(64),nativeOutcome:'response_ended',businessVerdict:'unverified',body:'Report',truncated:false});
 const revise:any={operationId:randomUUID(),taskId:task.taskId,kind:'revise',expectedRevision:2,actor:initiator,deliveryId:delivery.operationId,body:'Adjust report'};await c.submitActionOne(revise);
 const commit=c.o.commitTransport;c.o.commitTransport=async message=>{if(message.kind==='followup'){const list=bus.store.list.bind(bus.store);bus.store.list=async()=>{bus.store.list=list;const rows=await list();time.value=Date.parse(task.deadline);return rows;};}return commit(message);};
 await c.drainOne();
 assert.equal((await c.store.getTask(task.taskId))!.phase,'expired');assert.equal((await c.store.getAction(revise.operationId))!.errorCode,'collaboration_expired');
 assert.equal((await bus.store.list()).length,2);assert.equal((await c.openOne({...input,messageId:randomUUID()},initiator)).phase,'working');
});
