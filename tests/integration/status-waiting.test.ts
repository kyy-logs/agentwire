import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startMain} from '../../src/main.ts';
import {requestBus} from '../../src/ipc.ts';
import {temp,clock} from '../helpers.ts';

async function fixture(t:any,offline=false){
 let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})}),time=clock(),sent:string[]=[];
 const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>{throw Error('status_must_not_probe');},submit:async(_b:any,m:any)=>{sent.push(m.messageId);return offline&&sent.length===1?{status:'rejected' as const,retryable:true,errorCode:'session_offline'}:{status:'accepted' as const};},reconcile:async()=>({status:'unknown' as const})}));
 const reader:any={inspect:async()=>{throw Error('status_must_not_inspect_native');}},client:any={call:async()=>{throw Error('status_must_not_call_native');},close:async()=>{}};
 runtime=await startMain(root,{adapters,clock:time,intervalMs:0,signals:false,quiet:true,codexExe:process.execPath,native:{client,readers:{codex:reader,claude:reader}}});
 // Persist no fixture binding via probe: status itself must need neither probe nor native calls.
 runtime.bus.bindings.set('codex',{agentId:'codex',kind:'codex',sessionId:randomUUID(),workspaceRoot:root});
 runtime.bus.bindings.set('claude',{agentId:'claude',kind:'claude',sessionId:randomUUID(),workspaceRoot:root});
 const ask=()=>runtime.bus.accept({messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'fixture task'});
 const status=(payload:any)=>requestBus(root,{requestId:randomUUID(),op:'status',payload});
 return {runtime,time,sent,ask,status};
}

test('IPC status sees blockers outside requested task and never dispatches or changes records',async t=>{
 const f=await fixture(t),first=await f.ask();await f.runtime.bus.tick();const second=await f.ask();await f.runtime.bus.tick();
 const before=JSON.stringify(await f.runtime.bus.status());
 for(let n=0;n<2;n++){
  const response=await f.status({taskId:second.message.taskId,limit:1});assert.equal(response.ok,true);assert.equal(response.data.total,1);assert.equal(response.data.items[0].display.waiting.reason,'target_task_unresolved');assert.equal(response.data.items[0].display.waiting.blockedBy,first.message.messageId);
 }
 assert.equal(JSON.stringify(await f.runtime.bus.status()),before);assert.deepEqual(f.sent,[first.message.messageId]);
 const invalid=await f.status({taskId:'not-an-id'});assert.equal(invalid.ok,false);
});

test('IPC status uses Bus clock and clears offline wait after an ordinary successful retry',async t=>{
 const f=await fixture(t,true),task=await f.ask();await f.runtime.bus.tick();
 const before=JSON.stringify(await f.runtime.bus.status()),first=await f.status({});assert.equal(first.ok,true);assert.equal(first.data.items[0].display.waiting.reason,'target_offline');assert.equal(f.sent.length,1);assert.equal(JSON.stringify(await f.runtime.bus.status()),before);
 f.time.value+=1001;await f.runtime.bus.tick();const second=await f.status({});assert.equal(second.data.items[0].display.waiting.reason,'awaiting_result');assert.equal(second.data.items[0].receipt.status,'accepted');assert.deepEqual(f.sent,[task.message.messageId,task.message.messageId]);
});

test('a followup becoming uncertain pauses an earlier reply even during its offline retry delay',async t=>{
 const f=await fixture(t);f.sent.length=0;
 for(const adapter of f.runtime.bus.adapters.values())adapter.submit=async(_b:any,m:any)=>{
  f.sent.push(m.messageId);
  return m.kind==='reply'?{status:'rejected',retryable:true,errorCode:'session_offline'}:m.kind==='followup'?{status:'unknown',errorCode:'fixture_uncertain'}:{status:'accepted'};
 };
 const root=await f.ask();await f.runtime.bus.tick();f.time.value++;
 const reply=await f.runtime.bus.accept({messageId:randomUUID(),kind:'reply',from:'claude',replyTo:root.message.messageId,body:'fixture result'});f.time.value++;
 await f.runtime.bus.accept({messageId:randomUUID(),kind:'followup',from:'codex',replyTo:reply.message.messageId,body:'fixture followup'});await f.runtime.bus.tick();
 const response=await f.status({taskId:root.message.taskId}),item=response.data.items.find((r:any)=>r.message.messageId===reply.message.messageId);
 assert.equal(item.state,'pending');assert.ok(Date.parse(item.nextAttemptAt)>+f.time.now());assert.equal(item.display.waiting.reason,'family_paused');
 const sent=f.sent.length;f.time.value+=1001;await f.runtime.bus.tick();assert.equal(f.sent.length,sent);
});
