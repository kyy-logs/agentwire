import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LocalBus} from '../../src/bus.ts';
import {FileMessageStore} from '../../src/store.ts';
import {FileLifecycleStore} from '../../src/lifecycle/store.ts';
import {normalizeHook} from '../../src/lifecycle/normalize.ts';
import {envelope} from '../../src/envelope.ts';
import {temp,clock,taskInput} from '../helpers.ts';
async function setup(t:any){
 const root=await temp(t),time=clock(),store=new FileMessageStore(root,time),lifecycle=new FileLifecycleStore(root),sent:any[]=[];
 const bindings=['codex','claude'].map(agentId=>({agentId,kind:agentId as 'codex'|'claude',sessionId:randomUUID(),workspaceRoot:root}));
 const adapters=bindings.map(b=>({kind:b.kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(_b:any,m:any,options:any)=>{sent.push({m,options,atTransport:await store.get(m.messageId)});return {status:'accepted' as const};},reconcile:async()=>({status:'unknown' as const})}));
 return {bus:new LocalBus({store,bindings,adapters,clock:time}),store,lifecycle,bindings,time,sent};
}
test('nonce_saved_before_transport; auto envelope has no reply command; same_id_different_mode_conflicts',async t=>{
 const s=await setup(t),input=taskInput({returnMode:'auto'});const r=await s.bus.accept(input as any);await s.bus.tick();
 const send=s.sent[0];assert.equal(send.atTransport.returnMode,'auto');assert.match(send.atTransport.dispatchNonce,/^[a-f0-9-]{36}$/);assert.equal(send.options.dispatchNonce,send.atTransport.dispatchNonce);
 const text=envelope(send.m,{cliPath:'C:/cli.ts',stateRoot:'C:/state'},send.options);assert.match(text,/returnMode=auto dispatchNonce=/);assert.ok(!text.includes('reply-current'));assert.ok(!text.includes('--reply-to'));
 await assert.rejects(s.bus.accept({...input,returnMode:'manual'} as any),/conflict/);
 const legacy=await s.bus.accept(taskInput());assert.equal(legacy.returnMode??'manual','manual');assert.equal(legacy.dispatchNonce,undefined);
 assert.equal((await s.store.get(r.message.messageId))?.dispatchNonce,send.atTransport.dispatchNonce);
});
test('only_matching_session_nonce_and_message_bind; no_recent_task_fallback; terminal first defers',async t=>{
 const {LifecycleProcessor}=await import('../../src/lifecycle/processor.ts');const s=await setup(t),p=new LifecycleProcessor(s.bus,s.lifecycle);
 await s.bus.accept(taskInput({returnMode:'auto'}) as any);await s.bus.tick();const x=s.sent[0],native=randomUUID();
 const begin=normalizeHook('claude',{session_id:s.bindings[1].sessionId,prompt_id:native,hook_event_name:'UserPromptSubmit',prompt:envelope(x.m,undefined,x.options)})!;
 const stop=normalizeHook('claude',{session_id:s.bindings[1].sessionId,prompt_id:native,hook_event_name:'Stop',last_assistant_message:'answer'})!;
 assert.equal((await p.process(stop)).status,'deferred');assert.equal(await s.lifecycle.getExecution(stop),undefined);
 const wrong=normalizeHook('claude',{session_id:randomUUID(),prompt_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt:envelope(x.m,undefined,x.options)})!;assert.equal((await p.process(wrong)).status,'ignored');
 const wrongNonce=normalizeHook('claude',{session_id:s.bindings[1].sessionId,prompt_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt:envelope(x.m,undefined,{...x.options,dispatchNonce:randomUUID()})})!;assert.equal((await p.process(wrongNonce)).status,'ignored');
 assert.equal((await p.process(begin)).status,'applied');assert.equal((await s.lifecycle.getExecution(begin))?.messageId,x.m.messageId);
});
test('ordinary_reply_reminder_and_subagent_ignored; two_inputs_same_execution_pauses',async t=>{
 const {LifecycleProcessor}=await import('../../src/lifecycle/processor.ts');const s=await setup(t),p=new LifecycleProcessor(s.bus,s.lifecycle);
 await s.bus.accept(taskInput({returnMode:'auto'}) as any);await s.bus.tick();const x=s.sent[0],session=s.bindings[1].sessionId;
 for(const prompt of ['ordinary',`LOCAL_AGENT_BUS messageId=${randomUUID()} taskId=${x.m.taskId} kind=reply from=codex to=claude`,`LOCAL_AGENT_BUS messageId=${randomUUID()} taskId=${x.m.taskId} kind=reminder from=codex to=claude reminderFor=${x.m.messageId}`]){
   const event=normalizeHook('claude',{session_id:session,prompt_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt})!;assert.equal((await p.process(event)).status,'ignored');assert.equal(await s.lifecycle.getExecution(event),undefined);
 }
 assert.equal(normalizeHook('claude',{session_id:session,prompt_id:randomUUID(),hook_event_name:'UserPromptSubmit',agent_id:'sub',prompt:envelope(x.m,undefined,x.options)}),undefined);
 const id=randomUUID(),begin=normalizeHook('claude',{session_id:session,prompt_id:id,hook_event_name:'UserPromptSubmit',prompt:envelope(x.m,undefined,x.options)})!;await p.process(begin);
 const ordinary=normalizeHook('claude',{session_id:session,prompt_id:id,hook_event_name:'UserPromptSubmit',prompt:'interleaved ordinary input'})!;
 assert.equal((await p.process(ordinary)).status,'needs_check');assert.equal((await s.lifecycle.getExecution(begin))?.phase,'needs_check');assert.equal((await s.store.get(x.m.messageId))?.state,'needs_check');
});
