import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LocalBus} from '../../src/bus.ts';
import {FileMessageStore} from '../../src/store.ts';
import {temp,clock,taskInput} from '../helpers.ts';
import type {SubmitResult,MessageInput} from '../../src/model.ts';
async function setup(t:any,result:SubmitResult={status:'accepted'}){
  const time=clock(),store=new FileMessageStore(await temp(t),time),sent:any[]=[];
  const bindings=[{agentId:'codex',kind:'codex' as const,sessionId:randomUUID(),workspaceRoot:'C:/project'},{agentId:'claude',kind:'claude' as const,sessionId:randomUUID(),workspaceRoot:'C:/project'}];
  const adapter=(kind:string)=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(b:any,m:any)=>{sent.push({b,m,time:time.value});return {...result};},reconcile:async()=>({status:'not_found' as const})});
  const bus=new LocalBus({store,bindings,adapters:[adapter('codex'),adapter('claude')],clock:time});return {bus,store,time,sent,bindings};
}
const response=(parent:any,kind:'reply'|'followup'='reply',body='result'):MessageInput=>({messageId:randomUUID(),kind,from:parent.message.to,replyTo:parent.message.messageId,body});
test('unknown reply is automatically reconciled from delayed positive evidence without resend; followup stays paused until proof',async t=>{
 const {bus,sent,store}=await setup(t);let visible=false;const adapter=bus.adapters.get('codex')!,submit=adapter.submit.bind(adapter);
 adapter.submit=async(b,m,o)=>{const result=await submit(b,m,o);return m.kind==='reply'?{status:'unknown',retryable:false,errorCode:'write_without_delivery_evidence'}:result;};
 adapter.reconcile=async()=>visible?{status:'submitted',evidenceRef:'native#exact-message'}:{status:'not_found'};
 const task=await bus.accept(taskInput());await bus.tick();const reply=await bus.accept(response(task));await bus.tick();assert.equal((await store.get(reply.message.messageId))?.state,'needs_check');
 await bus.tick();await assert.rejects(bus.accept(response(reply,'followup')),/task_paused/);assert.equal(sent.length,2);
 visible=true;await bus.tick();const delivered=await store.get(reply.message.messageId);assert.equal(delivered?.state,'delivered');assert.equal(delivered.receipt?.status,'accepted');assert.equal(delivered.lastError,undefined);assert.equal(delivered.attempts,1);assert.equal(sent.length,2);
 const next=await bus.accept(response(reply,'followup'));assert.equal(next.message.executionIndex,2);await bus.tick();assert.equal(sent.length,3);
});
test('automatic reply reconciliation never clears an unknown delegation or revives a stopped family',async t=>{
 const s=await setup(t,{status:'unknown'});let checks=0;for(const a of s.bus.adapters.values())a.reconcile=async()=>{checks++;return {status:'submitted',evidenceRef:'native'};};
 const task=await s.bus.accept(taskInput());await s.bus.tick();await s.bus.tick();assert.equal(checks,0);assert.equal((await s.store.get(task.message.messageId))?.state,'needs_check');
 const reply=await s.bus.accept(response(task));await s.bus.tick();await s.bus.stop(task.message.taskId);await s.bus.tick();assert.equal((await s.store.get(reply.message.messageId))?.state,'stopped');assert.equal(checks,0);
});
test('routes_to_bound_session; one_execution_slot_per_target; duplicate intent stable',async t=>{
  const {bus,time,sent,bindings}=await setup(t),input=taskInput();const first=await bus.accept(input);time.value+=500;
  assert.deepEqual(await bus.accept(input),first);await assert.rejects(bus.accept({...input,body:'changed'}),/conflict/);
  await bus.accept(taskInput());await bus.tick();assert.equal(sent.length,1);assert.equal(sent[0].m.targetSessionId,bindings[1].sessionId);
});
test('reply_bypasses_execution_slot; reply_does_not_create_auto_reply; duplicate reply forwards once',async t=>{
  const {bus,sent}=await setup(t);const a=await bus.accept(taskInput()),b=await bus.accept(taskInput({from:'claude',to:'codex'}));await bus.tick();assert.equal(sent.length,2);
  const input=response(a),reply=await bus.accept(input);assert.equal((await bus.status(a.message.taskId)).find(r=>r.message.messageId===a.message.messageId)?.state,'completed');
  await bus.tick();assert.equal(sent.length,3);assert.equal(sent[2].m.kind,'reply');await bus.accept(input);await bus.tick();assert.equal(sent.length,3);
  await assert.rejects(bus.accept({...response(a),body:'other'}),/already_replied/);
  await assert.rejects(bus.accept(response(reply)),/reply_to_reply/);assert.equal((await bus.status()).length,3);
});
test('followup_stops_at_six; duplicate_followup_does_not_increment_budget; root deadline fixed',async t=>{
  const {bus,time}=await setup(t);let task=await bus.accept(taskInput());const expiry=task.message.expiresAt;
  for(let index=1;index<=6;index++){
    await bus.tick();const reply=await bus.accept(response(task));await bus.tick();
    const input=response(reply,'followup','next');time.value+=100;
    if(index===6){await assert.rejects(bus.accept(input),/budget/);break;}
    task=await bus.accept(input);assert.equal(task.message.executionIndex,index+1);assert.equal(task.message.expiresAt,expiry);assert.deepEqual(await bus.accept(input),task);
  }
  assert.equal(Date.parse(expiry),Date.parse('2026-11-15T14:30:00Z'));
});
test('retry_only_definite_rejection_at_zero_one_six_seconds',async t=>{
  const {bus,time,sent}=await setup(t,{status:'rejected',retryable:true,errorCode:'offline'});const task=await bus.accept(taskInput());const start=time.value;
  for(const delta of [0,999,1000,5999,6000,9999]){time.value=start+delta;await bus.tick();}
  assert.deepEqual(sent.map(x=>x.time-start),[0,1000,6000]);assert.equal((await bus.status())[0].state,'failed');
});
test('unknown_never_retries; paused root cannot advance; check not_found does not resend',async t=>{
  const {bus,time,sent}=await setup(t,{status:'unknown'});const task=await bus.accept(taskInput());await bus.tick();time.value+=10000;await bus.tick();await bus.check(task.message.messageId);await bus.tick();assert.equal(sent.length,1);assert.equal((await bus.status())[0].state,'needs_check');
});
test('status_polling_does_not_extend_deadline; result timeout does not cancel agent',async t=>{
  const {bus,time,sent}=await setup(t);const task=await bus.accept(taskInput());await bus.tick();const deadline=(await bus.status())[0].resultDeadlineAt;
  time.value+=599999;await bus.check(task.message.messageId);await bus.tick();assert.equal((await bus.status())[0].resultDeadlineAt,deadline);
  time.value+=1;await bus.tick();assert.equal((await bus.status())[0].state,'needs_check');assert.equal(sent.filter(x=>x.m.messageId===task.message.messageId).length,1);assert.equal(sent.length,2); // original + one reminder, no task replay
});
test('stop_does_not_claim_agent_cancelled; late_reply_retained_without_auto_forward',async t=>{
  const {bus,sent}=await setup(t);const task=await bus.accept(taskInput());await bus.tick();await bus.stop(task.message.taskId);
  const reply=await bus.accept(response(task));assert.equal(reply.late,true);assert.equal(reply.state,'stopped');await bus.tick();assert.equal(sent.length,1);
});
test('malformed_reply_does_not_complete_task; unknown target visible; TTL expiry',async t=>{
  const {bus,time}=await setup(t);const task=await bus.accept(taskInput());await assert.rejects(bus.accept({...response(task),from:'codex'}),/direction/);assert.equal((await bus.status())[0].state,'pending');
  await assert.rejects(bus.accept(taskInput({to:'unknown'})),/unknown_agent/);time.value+=1800000;await bus.tick();assert.equal((await bus.status())[0].state,'expired');
});
test('binding cannot move historical messages to another session',async t=>{
  const {bus,bindings}=await setup(t);await bus.accept(taskInput());await assert.rejects(bus.bind({...bindings[0],sessionId:randomUUID()}),/binding_in_use/);
});
test('stop after fully completed round still prevents a future followup',async t=>{
  const {bus,store}=await setup(t);const task=await bus.accept(taskInput());await bus.tick();const reply=await bus.accept(response(task));await bus.tick();await store.replace({...((await store.get(reply.message.messageId))!),state:'delivered'});await bus.stop(task.message.taskId);
  await assert.rejects(bus.accept(response(reply,'followup')),/paused/);
});
test('reply commit followed by parent write failure repairs on same ID retry',async t=>{
  const {bus,store}=await setup(t);const task=await bus.accept(taskInput());await bus.tick();const input=response(task),replace=store.replace.bind(store);let fail=true;
  store.replace=async r=>{if(fail&&r.message.messageId===task.message.messageId&&r.state==='completed'){fail=false;throw Error('injected disk failure');}await replace(r);};
  await assert.rejects(bus.accept(input),/disk failure/);await bus.accept(input);assert.equal((await store.get(task.message.messageId))?.state,'completed');
});
test('each side effect rechecks expiry after earlier adapter waits across the deadline',async t=>{
  const {bus,time,store,sent}=await setup(t);const a=await bus.accept(taskInput()),b=await bus.accept(taskInput({from:'claude',to:'codex'}));
  const expires=Date.parse(a.message.expiresAt);time.value=expires-1000;
  for(const adapter of bus.adapters.values()){const submit=adapter.submit.bind(adapter);adapter.submit=async(binding,m)=>{const result=await submit(binding,m);time.value+=2000;return result;};}
  await bus.tick();assert.equal(sent.length,1);const pending=await store.get(sent[0].m.messageId===a.message.messageId?b.message.messageId:a.message.messageId);assert.equal(pending?.state,'expired');assert.equal(pending?.attempts,0);
});
test('expiry during submitting record commit does not start an adapter or consume an attempt',async t=>{
  const {bus,time,store,sent}=await setup(t);const task=await bus.accept(taskInput());time.value=Date.parse(task.message.expiresAt)-1;let first=true;
  store.hooks.beforeRename=async()=>{if(first){first=false;time.value+=2;}};await bus.tick();const r=await store.get(task.message.messageId);assert.equal(sent.length,0);assert.equal(r?.state,'expired');assert.equal(r?.attempts,0);
});
test('shutdown during submitting record commit preserves pending without sending',async t=>{
  const {bus,store,sent}=await setup(t);const task=await bus.accept(taskInput());store.hooks.beforeRename=async()=>bus.requestShutdown();await bus.tick();const r=await store.get(task.message.messageId);assert.equal(sent.length,0);assert.equal(r?.state,'pending');assert.equal(r?.attempts,0);
});
