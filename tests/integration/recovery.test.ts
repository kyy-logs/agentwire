import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LocalBus} from '../../src/bus.ts';
import {FileMessageStore} from '../../src/store.ts';
import {clock,temp,taskInput} from '../helpers.ts';
test('restart_after_submit_before_receipt_needs_check; reply commit repairs parent; submitted not resent',async t=>{
  const time=clock(),store=new FileMessageStore(await temp(t),time),bindings=[{agentId:'codex',kind:'codex' as const,sessionId:randomUUID(),workspaceRoot:'C:/project'},{agentId:'claude',kind:'claude' as const,sessionId:randomUUID(),workspaceRoot:'C:/project'}];
  let sends=0;const adapter={kind:'claude',probe:async()=>({status:'available' as const,details:[]}),submit:async()=>{sends++;return {status:'accepted' as const};},reconcile:async()=>({status:'not_found' as const})};
  const options={store,bindings,adapters:[adapter],clock:time};let bus=new LocalBus(options);
  const a=await bus.accept(taskInput());await store.replace({...a,state:'submitting',attempts:1});bus=new LocalBus(options);await bus.recover();await bus.tick();assert.equal(sends,0);assert.equal((await bus.status())[0].state,'needs_check');
  const reply=await bus.accept({messageId:randomUUID(),kind:'reply',from:'claude',replyTo:a.message.messageId,body:'done'});
  await store.replace({...a,state:'submitted',attempts:1});bus=new LocalBus(options);const report=await bus.recover();assert.ok(report.repairedTaskIds.includes(a.message.messageId));assert.equal((await store.get(a.message.messageId))?.resultRef,reply.message.messageId);
});
test('restart recovers late reply even if crash preceded writing late flag',async t=>{
  const time=clock(),store=new FileMessageStore(await temp(t),time);const {createTask}=await import('../../src/model.ts');
  const message=createTask({...taskInput(),targetSessionId:randomUUID()},time),task=(await store.putNew(message)).record;await store.replace({...task,state:'submitted',attempts:1});time.value+=1800001;
  await store.putNew({...message,messageId:randomUUID(),kind:'reply',replyTo:message.messageId,from:message.to,to:message.from,createdAt:time.now().toISOString()});
  await store.recover(time.now());const records=await store.list();assert.equal(records.find(r=>r.message.kind==='reply')?.late,true);assert.notEqual(records.find(r=>r.message.kind==='task')?.state,'completed');
});
