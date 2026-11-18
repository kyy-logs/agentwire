import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {temp,clock} from '../helpers.ts';
import {LocalBus} from '../../src/bus.ts';
import {FileMessageStore} from '../../src/store.ts';
import {IdentityStore} from '../../src/native/identity-store.ts';
import {NativeDispatcher} from '../../src/native/dispatcher.ts';

async function fixture(t:any,submitReply=true){
 const root=await temp(t),time=clock(),store=new FileMessageStore(root,time),ids=new IdentityStore(root,time);
 const bindings=['codex','claude'].map(kind=>({agentId:kind,kind,sessionId:randomUUID(),workspaceRoot:root})) as any;
 let visible=false,inspect=0,sends=0,replyId='';const turn=randomUUID();
 const reader:any={inspect:async(i:any)=>{inspect++;return visible&&i.messageId===replyId?{status:'mapped',identity:{provider:i.provider,sessionId:i.targetSessionId,transportId:i.transportId,nativeExecutionId:turn,evidenceRef:'exact-delayed-input'}}:{status:'missing'};}};
 const adapters=bindings.map((b:any)=>({kind:b.kind,probe:async()=>({status:'available',details:[]}),submit:async()=>{sends++;return {status:'accepted'};},reconcile:async()=>({status:'unknown'})}));
 const bus=new LocalBus({store,bindings,adapters,clock:time,newAutoWireVersion:'clean-v1',nativeDispatcher:new NativeDispatcher(ids,{codex:reader,claude:reader}),connectionId:randomUUID()} as any);
 const parent=await bus.accept({messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'compute',returnMode:'auto'});await bus.tick();
 const reply=await bus.accept({messageId:randomUUID(),kind:'reply',from:'claude',replyTo:parent.message.messageId,body:'667'});replyId=reply.message.messageId;if(submitReply)await bus.tick();
 time.value=Date.parse(parent.message.expiresAt);await bus.tick();inspect=0;
 return {bus,store,ids,time,parent,reply,showEvidence:()=>visible=true,sends:()=>sends,inspections:()=>inspect};
}

test('explicit check reconciles exact late delivery of an expired reply without dispatching or reviving its task',async t=>{
 const f=await fixture(t),before=(await f.store.get(f.reply.message.messageId))!;
 assert.equal(before.state,'expired');f.showEvidence();const checked=await f.bus.check(before.message.messageId);
 assert.equal(checked.state,'delivered');assert.equal(checked.late,true);assert.equal(checked.receipt?.evidenceRef,'exact-delayed-input');
 assert.equal(checked.attempts,1);assert.equal(checked.message.expiresAt,before.message.expiresAt);assert.equal(f.sends(),2);
 assert.equal((await f.store.get(f.parent.message.messageId))?.state,'completed');
 await assert.rejects(f.bus.accept({messageId:randomUUID(),kind:'followup',from:'codex',replyTo:checked.message.messageId,body:'do more'}),/task_paused/);
});

test('expired reply with no exact evidence is inspected once and retained byte-equivalent without resend',async t=>{
 const f=await fixture(t),before=await f.store.get(f.reply.message.messageId);
 await f.bus.check(f.reply.message.messageId);assert.equal(f.inspections(),1);
 assert.deepEqual(await f.store.get(f.reply.message.messageId),before);assert.equal(f.sends(),2);
});

test('explicit check never revives expired tasks, stopped replies or replies never submitted',async t=>{
 for(const mode of ['task','stopped','unsubmitted']){
  const f=await fixture(t,mode!=='unsubmitted');let target=f.reply.message.messageId;
  if(mode==='task'){target=f.parent.message.messageId;const p=(await f.store.get(target))!;await f.store.replace({...p,state:'expired'});}
  if(mode==='stopped'){const r=(await f.store.get(target))!;await f.store.replace({...r,state:'stopped'});}
  const before=await f.store.get(target);f.showEvidence();await f.bus.check(target);
  assert.deepEqual(await f.store.get(target),before,mode);assert.equal(f.inspections(),0,mode);
 }
});
