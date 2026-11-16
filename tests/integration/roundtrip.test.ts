import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startMain} from '../../src/main.ts';
import {requestBus} from '../../src/ipc.ts';
import {runCli} from '../../src/cli.ts';
import {temp,clock} from '../helpers.ts';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
test('both_directions_two_rounds through authenticated IPC; duplicate reply only forwards once; restart keeps results',async t=>{
  let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})} as any),time=clock(),sent:any[]=[];
  const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(b:any,m:any)=>{sent.push(m);return {status:'accepted' as const};},reconcile:async()=>({status:'submitted' as const,evidenceRef:'fake-inbound'})}));
  runtime=await startMain(root,{adapters,clock:time,intervalMs:0,signals:false,quiet:true});
  const call=async(op:string,payload:any)=>{const r=await requestBus(root,{requestId:randomUUID(),op,payload});assert.equal(r.ok,true,JSON.stringify(r));return r.data;};
  for(const agentId of ['codex','claude'])await call('bind',{agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root});
  for(const [from,to] of [['codex','claude'],['claude','codex']]){
    const task=await call('accept',{messageId:randomUUID(),kind:'task',from,to,body:'23*29'});await runtime.bus.tick();
    const input={messageId:randomUUID(),kind:'reply',from:to,replyTo:task.message.messageId,body:'667'};const reply=await call('accept',input);await call('accept',input);await runtime.bus.tick();await runtime.bus.tick();
    const follow=await call('accept',{messageId:randomUUID(),kind:'followup',from,replyTo:reply.message.messageId,body:'add 1'});await runtime.bus.tick();await call('accept',{messageId:randomUUID(),kind:'reply',from:to,replyTo:follow.message.messageId,body:'668'});await runtime.bus.tick();await runtime.bus.tick();
  }
  assert.equal(sent.length,8);assert.equal((await call('status',{})).items.filter((r:any)=>r.state==='completed').length,4);
  await runtime.close();runtime=await startMain(root,{adapters,clock:time,intervalMs:0,signals:false,quiet:true});await runtime.bus.tick();assert.equal(sent.length,8);
});
test('bus_offline_reports_unconfirmed',async t=>{
  const root=await temp(t),output:string[]=[];const io={stdout:{write:(s:string)=>output.push(s)},stderr:{write:(s:string)=>output.push(s)}};
  assert.equal(await runCli(['--state',root,'send','--from','codex','--to','claude','--text','hello','--id',randomUUID()],io),4);assert.match(output.join(''),/unconfirmed/);
});
test('quarantine pauses auto dispatch across another restart',async t=>{
  let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})} as any);
  await mkdir(path.join(root,'messages'));await writeFile(path.join(root,'messages',randomUUID()+'.json'),'{corrupt');
  for(let i=0;i<2;i++){
    runtime=await startMain(root,{adapters:[],intervalMs:0,signals:false,quiet:true});
    const response=await requestBus(root,{requestId:randomUUID(),op:'health'});assert.equal(response.data.status,'storage_requires_check');await runtime.close();
  }
});
test('committed message still acknowledged when diagnostic log cannot be written',async t=>{
  let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})} as any);
  const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async()=>({status:'accepted' as const}),reconcile:async()=>({status:'unknown' as const})}));
  runtime=await startMain(root,{adapters,intervalMs:0,signals:false,quiet:true});
  const call=(op:string,payload?:any)=>requestBus(root,{requestId:randomUUID(),op,payload});
  for(const agentId of ['codex','claude'])assert.equal((await call('bind',{agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root})).ok,true);
  // Fault only this test-owned log path; message storage remains writable.
  await unlink(path.join(root,'bus.log'));await mkdir(path.join(root,'bus.log'));
  const response=await call('accept',{messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'hello'});
  assert.equal(response.ok,true);assert.equal(response.data.state,'pending');assert.equal((await call('health')).data.status,'storage_requires_check');
});
test('shutdown waits for in-flight receipt but never starts the next pending submission',async t=>{
  let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})} as any);let release:()=>void,entered:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),sent:string[]=[];
  const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(_b:any,m:any)=>{sent.push(m.messageId);if(sent.length===1){entered();await gate;}return {status:'accepted' as const};},reconcile:async()=>({status:'unknown' as const})}));
  runtime=await startMain(root,{adapters,intervalMs:0,signals:false,quiet:true});
  for(const agentId of ['codex','claude'])await runtime.bus.bind({agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root});
  const first=await runtime.bus.accept({messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'first'});const second=await runtime.bus.accept({messageId:randomUUID(),kind:'task',from:'claude',to:'codex',body:'second'});
  const tick=runtime.bus.tick();await started;const closing=runtime.close();release();await tick;await closing;
  assert.equal(sent.length,1);const records=await runtime.bus.status();assert.equal(records.find((r:any)=>r.message.messageId===sent[0])?.state,'submitted');assert.equal(records.find((r:any)=>r.message.messageId!==sent[0])?.state,'pending');
});
for(const status of ['rejected','unknown'] as const)test(`shutdown preserves in-flight ${status} without submitting the next message`,async t=>{
  let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})} as any);let release:()=>void,entered:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),sent:string[]=[];
  const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(_b:any,m:any)=>{sent.push(m.messageId);if(sent.length===1){entered();await gate;}return {status,retryable:status==='rejected',errorCode:'test_in_flight_result'};},reconcile:async()=>({status:'unknown' as const})}));
  runtime=await startMain(root,{adapters,intervalMs:0,signals:false,quiet:true});
  for(const agentId of ['codex','claude'])await runtime.bus.bind({agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root});
  await runtime.bus.accept({messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'first'});await runtime.bus.accept({messageId:randomUUID(),kind:'task',from:'claude',to:'codex',body:'second'});
  const tick=runtime.bus.tick();await started;const closing=runtime.close();release();await tick;await closing;
  assert.equal(sent.length,1);const records=await runtime.bus.status(),first=records.find((r:any)=>r.message.messageId===sent[0]),second=records.find((r:any)=>r.message.messageId!==sent[0]);
  assert.equal(first.state,status==='rejected'?'pending':'needs_check');assert.equal(first.attempts,1);assert.equal(first.receipt.status,status);
  if(status==='rejected')assert.ok(Date.parse(first.nextAttemptAt)>Date.parse(first.updatedAt));else assert.equal(first.nextAttemptAt,undefined);
  assert.equal(second.state,'pending');assert.equal(second.attempts,0);
});
test('status history beyond one MiB remains readable through bounded summaries and pagination',async t=>{
  let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})} as any);
  const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async()=>({status:'accepted' as const}),reconcile:async()=>({status:'unknown' as const})}));
  runtime=await startMain(root,{adapters,intervalMs:0,signals:false,quiet:true});for(const agentId of ['codex','claude'])await runtime.bus.bind({agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root});
  const ids:string[]=[];for(let i=0;i<20;i++){const id=randomUUID();ids.push(id);await runtime.bus.accept({messageId:id,kind:'task',from:'codex',to:'claude',body:'x'.repeat(65536)});}
  const seen:string[]=[];let after:string|undefined;
  do{const response=await requestBus(root,{requestId:randomUUID(),op:'status',payload:{after,limit:7}});assert.equal(response.ok,true);const page=response.data;
    assert.equal(page.total,20);assert.ok(page.items.length<=7);assert.ok(page.items.every((r:any)=>r.message.body===undefined));seen.push(...page.items.map((r:any)=>r.message.messageId));after=page.nextCursor||undefined;
  }while(after);
  assert.equal(seen.length,20);assert.deepEqual(new Set(seen),new Set(ids));
  const bad=await requestBus(root,{requestId:randomUUID(),op:'status',payload:{after:randomUUID()}});assert.equal(bad.errorCode,'invalid_status_cursor');
});
