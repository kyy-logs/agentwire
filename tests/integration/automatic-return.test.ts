import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lifecycleFixture} from '../lifecycle-helpers.ts';
import {LifecycleProcessor} from '../../src/lifecycle/processor.ts';
import {startMain} from '../../src/main.ts';
import {runCli} from '../../src/cli.ts';
import {normalizeHook} from '../../src/lifecycle/normalize.ts';
import {envelope} from '../../src/envelope.ts';
import {temp,clock} from '../helpers.ts';
for(const point of ['after_result','after_reply','after_parent'])test('automatic result recovery '+point+' preserves exactly one reply without business retry',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);
 if(point==='after_result') {const original=s.bus.applyCapturedResultOne?.bind(s.bus);(s.bus as any).applyCapturedResultOne=async()=>{throw new Error('crash_after_result');};await assert.rejects(s.processor.process(s.terminal()),/crash_after_result/);(s.bus as any).applyCapturedResultOne=original;}
 if(point==='after_reply') {const original=s.store.replace.bind(s.store);let failed=false;s.store.replace=async r=>{if(!failed&&r.message.messageId===s.task.message.messageId&&r.state==='completed'){failed=true;throw new Error('crash_after_reply');}return original(r);};await assert.rejects(s.processor.process(s.terminal()),/crash_after_reply/);s.store.replace=original;}
 if(point==='after_parent') {const original=s.lifecycle.markApplied.bind(s.lifecycle);s.lifecycle.markApplied=async key=>{if(key===s.terminal().eventKey)throw new Error('crash_after_parent');return original(key);};await assert.rejects(s.processor.process(s.terminal()),/crash_after_parent/);s.lifecycle.markApplied=original;}
 await s.bus.recover();await new LifecycleProcessor(s.bus,s.lifecycle).recover();assert.equal((await s.replies()).length,1);assert.equal((await s.store.get(s.task.message.messageId))?.state,'completed');assert.equal(s.sent.filter(x=>x.m.kind==='task').length,1);
});
test('real IPC CLI auto task, offline spool restart, followup inheritance, information reply does not echo',async t=>{
 let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})}),time=clock(),sent:any[]=[];
 const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(b:any,m:any,o:any)=>{sent.push({b,m,o});return {status:'accepted' as const};},reconcile:async()=>({status:'submitted' as const})}));
 const start=async()=>runtime=await startMain(root,{adapters,clock:time,intervalMs:0,quiet:true,signals:false});await start();
 for(const id of ['codex','claude'])await runtime.bus.bind({agentId:id,kind:id,sessionId:randomUUID(),workspaceRoot:root});
 const output:string[]=[];assert.equal(await runCli(['--state',root,'send','--from','codex','--to','claude','--text','calculate','--return-mode','auto'],{stdout:{write:s=>output.push(s)},stderr:{write:s=>output.push(s)}}),0);await runtime.bus.tick();
 const x=sent[0],native=randomUUID();await runtime.close();
 const {writeHookEvent}=await import('../../src/lifecycle/hook.ts');
 const begin=normalizeHook('claude',{session_id:x.m.targetSessionId,prompt_id:native,hook_event_name:'UserPromptSubmit',prompt:envelope(x.m,undefined,x.o)})!;
 const stop=normalizeHook('claude',{session_id:x.m.targetSessionId,prompt_id:native,hook_event_name:'Stop',last_assistant_message:'667'})!;
 await writeHookEvent(root,stop);await writeHookEvent(root,begin);await start();await runtime.lifecycle.drain();
 let rows=await runtime.bus.status();const reply=rows.find((r:any)=>r.message.kind==='reply');assert.ok(reply);assert.equal(rows.find((r:any)=>r.message.kind==='task').state,'completed');
 const follow=await runtime.bus.accept({messageId:randomUUID(),kind:'followup',from:'codex',replyTo:reply.message.messageId,body:'plus 1'});assert.equal(follow.returnMode,'auto');
 await runtime.bus.tick();assert.equal(sent.filter(x=>x.m.kind==='followup').length,1);
 const replyInput=normalizeHook('codex',{session_id:reply.message.targetSessionId,turn_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt:envelope(reply.message)})!;
 await runtime.lifecycle.process(replyInput);await runtime.lifecycle.process(normalizeHook('codex',{session_id:replyInput.sessionId,turn_id:replyInput.nativeExecutionId,hook_event_name:'Stop',last_assistant_message:'received'})!);
 assert.equal((await runtime.bus.status()).filter((r:any)=>r.message.kind==='reply').length,1);
});
