import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {lifecycleFixture} from '../lifecycle-helpers.ts';
import {LifecycleProcessor} from '../../src/lifecycle/processor.ts';
import {statusPage} from '../../src/status.ts';
test('status lifecycle metadata is bounded and excludes artifact body',async t=>{
 const s=await lifecycleFixture(t);const r={...s.task,completion:{nativeOutcome:'response_ended' as const,businessVerdict:'unverified' as const,eventKey:'x'.repeat(50000),artifactRef:'x'.repeat(50000),sha256:'x'.repeat(50000),truncated:true}};
 const text=JSON.stringify(statusPage([r]));assert.ok(Buffer.byteLength(text)<6000);assert.ok(!text.includes('computed 667'));
});
test('multiple terminal kinds present together pause before any automatic reply',async t=>{
 const s=await lifecycleFixture(t);await s.lifecycle.enqueue(s.begin);await s.lifecycle.enqueue(s.terminal());await s.lifecycle.enqueue(s.terminal({hook_event_name:'StopFailure'}));await s.processor.drain();assert.equal((await s.replies()).length,0);assert.equal((await s.store.get(s.task.message.messageId))?.state,'needs_check');
});
test('wrong provider and reused nonce in another native execution never overwrite original binding',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);
 const {normalizeHook}=await import('../../src/lifecycle/normalize.ts');
 const wrong=normalizeHook('codex',{session_id:s.begin.sessionId,turn_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt:`LOCAL_AGENT_BUS messageId=${s.begin.messageId} taskId=${s.begin.messageId} kind=task from=codex to=claude returnMode=auto dispatchNonce=${s.begin.dispatchNonce}`})!;
 assert.equal((await s.processor.process(wrong)).status,'ignored');
 const other={...s.begin,nativeExecutionId:randomUUID()};const {eventKey}=await import('../../src/lifecycle/model.ts');other.eventKey=eventKey(other,'input');assert.equal((await s.processor.process(other)).status,'needs_check');
 assert.equal((await s.lifecycle.getExecution(s.begin))?.phase,'needs_check');await s.processor.process(s.terminal());assert.equal((await s.replies()).length,0);
});
test('all already-spooled evidence is checked before projecting a terminal even beyond 200 files',async t=>{
 const s=await lifecycleFixture(t),dir=path.join(s.root,'lifecycle','inbox');await mkdir(dir,{recursive:true});
 const {normalizeHook}=await import('../../src/lifecycle/normalize.ts');
 const put=(i:number,e:any)=>writeFile(path.join(dir,'00000000-0000-0000-0000-'+String(i).padStart(12,'0')+'.json'),JSON.stringify(e));
 await put(1,s.begin);await put(2,s.terminal());for(let i=3;i<=200;i++)await put(i,normalizeHook('claude',{session_id:s.begin.sessionId,prompt_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt:'ordinary'}));
 const conflict=normalizeHook('claude',{session_id:s.begin.sessionId,prompt_id:s.begin.nativeExecutionId,hook_event_name:'UserPromptSubmit',prompt:'ordinary private input'})!;
 await writeFile(path.join(dir,'ffffffff-ffff-ffff-ffff-ffffffffffff.json'),JSON.stringify(conflict));
 await s.processor.drain();assert.equal((await s.replies()).length,0);await s.bus.tick();assert.equal(s.sent.length,1);
});
test('multiple non-auto inputs in one native execution do not pause the Bus',async t=>{
 const s=await lifecycleFixture(t),{normalizeHook}=await import('../../src/lifecycle/normalize.ts'),native=randomUUID();
 for(const kind of ['reply','reminder']){const e=normalizeHook('claude',{session_id:s.begin.sessionId,prompt_id:native,hook_event_name:'UserPromptSubmit',prompt:`LOCAL_AGENT_BUS messageId=${randomUUID()} taskId=${s.task.message.taskId} kind=${kind} from=codex to=claude`})!;assert.equal((await s.processor.process(e)).status,'ignored');}
 assert.equal(s.processor.lastError,undefined);assert.equal((await s.lifecycle.executions()).length,0);
});
test('shutdown during result commit defers projection for restart instead of discarding reply',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);const save=s.lifecycle.saveResult.bind(s.lifecycle);
 s.lifecycle.saveResult=async r=>{const saved=await save(r);s.bus.requestShutdown();return saved;};
 assert.equal((await s.processor.process(s.terminal())).status,'deferred');assert.equal((await s.replies()).length,0);assert.equal(await s.lifecycle.isApplied(s.terminal().eventKey),false);
 s.lifecycle.saveResult=save;s.bus.dispatchStopped=false;await new LifecycleProcessor(s.bus,s.lifecycle).recover();assert.equal((await s.replies()).length,1);
});
test('short output is not falsely labeled truncated',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);await s.processor.process(s.terminal({last_assistant_message:'x'.repeat(1800)}));
 assert.equal((await s.lifecycle.getResult(s.task.message.messageId))?.truncated,false);assert.ok(!(await s.replies())[0].message.body.includes('截断'));
});
test('matched_stop_returns_once; duplicate_stop_never_creates_second_reply; no reply-to-reply echo',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);const end=s.terminal();assert.equal((await s.processor.process(end)).status,'applied');
 await s.processor.process({...end,observedAt:new Date(0).toISOString()});await s.processor.drain();assert.equal((await s.replies()).length,1);
 const parent=await s.store.get(s.task.message.messageId);assert.equal(parent?.state,'completed');assert.equal(parent?.completion?.businessVerdict,'unverified');
 const reply=(await s.replies())[0];assert.equal(reply.message.to,'codex');assert.equal(reply.message.returnMode,undefined);assert.match(reply.message.body,/computed 667/);
 await s.bus.tick();assert.equal(s.sent.length,2);
});
test('manual_and_auto_first_reply_wins in both orders',async t=>{
 for(const manualFirst of [true,false]){
  const s=await lifecycleFixture(t);await s.processor.process(s.begin);const manual={messageId:randomUUID(),kind:'reply' as const,from:'claude',replyTo:s.task.message.messageId,body:'manual'};
  if(manualFirst)await s.bus.accept(manual);
  await s.processor.process(s.terminal());
  if(!manualFirst)await assert.rejects(s.bus.accept(manual),/already_replied/);
  assert.equal((await s.replies()).length,1);assert.equal((await s.replies())[0].message.body==='manual',manualFirst);assert.ok(await s.lifecycle.getResult(s.task.message.messageId));
 }
});
test('failure_is_not_business_success; interrupt is explicit native outcome',async t=>{
 for(const [event,outcome] of [['StopFailure','error'],['Interrupt','interrupted']]){
  const s=await lifecycleFixture(t);await s.processor.process(s.begin);await s.processor.process(s.terminal({hook_event_name:event,last_assistant_message:undefined}));
  assert.equal((await s.lifecycle.getResult(s.task.message.messageId))?.nativeOutcome,outcome);assert.equal((await s.store.get(s.task.message.messageId))?.completion?.businessVerdict,'unverified');assert.equal((await s.replies()).length,1);
 }
});
test('stopped_or_expired_result_saved_without_forward',async t=>{
 for(const stopped of [true,false]){const s=await lifecycleFixture(t);await s.processor.process(s.begin);if(stopped)await s.bus.stop(s.task.message.taskId);else s.time.value+=1800001;
  await s.processor.process(s.terminal());assert.ok(await s.lifecycle.getResult(s.task.message.messageId));assert.equal((await s.replies()).length,0);
 }
});
for(const [name,fields] of [['background_pending_does_not_complete',{background_tasks:[{}]}],['other_stop_hook_continuation_requires_final_signal',{stop_hook_active:true}],['empty_output_is_not_invented',{last_assistant_message:''}],['oversized_output_is_incomplete',{last_assistant_message:'中'.repeat(180000)}]] as const){
 test(name,async t=>{const s=await lifecycleFixture(t);await s.processor.process(s.begin);assert.equal((await s.processor.process(s.terminal(fields))).status,'needs_check');assert.equal((await s.replies()).length,0);assert.equal((await s.store.get(s.task.message.messageId))?.state,'needs_check');});
}
test('UTF8 summary stays within 2KiB and retained artifact within 512KiB',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);await s.processor.process(s.terminal({last_assistant_message:'中🙂'.repeat(20000)}));
 const reply=(await s.replies())[0];assert.ok(Buffer.byteLength(reply.message.body)<=2048);assert.ok(!reply.message.body.includes('\ufffd'));assert.match(reply.message.body,/截断/);
 const result=await s.lifecycle.getResult(s.task.message.messageId);assert.ok(result);assert.equal(result.truncated,true);assert.ok(Buffer.byteLength(result.body)<=524288);assert.match(result.sha256!,/^[a-f0-9]{64}$/);
});
test('terminal_before_begin_recovered; unknown native execution never selects latest task',async t=>{
 const s=await lifecycleFixture(t);assert.equal((await s.processor.process(s.terminal())).status,'deferred');assert.equal((await s.replies()).length,0);
 await s.processor.process(s.begin);await s.processor.recover();assert.equal((await s.replies()).length,1);
 const unknown=s.terminal({prompt_id:randomUUID()});assert.equal((await s.processor.process(unknown)).status,'deferred');assert.equal((await s.replies()).length,1);
});
test('conflicting native output pauses without changing the original result',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);await s.processor.process(s.terminal());
 assert.equal((await s.processor.process(s.terminal({last_assistant_message:'different'}))).status,'needs_check');assert.equal((await s.replies()).length,1);assert.equal((await s.lifecycle.getResult(s.task.message.messageId))?.body,'computed 667');
});
test('artifact commit failure never forwards; bad JSON inbox is quarantined visibly',async t=>{
 const s=await lifecycleFixture(t);await s.processor.process(s.begin);const original=s.lifecycle.saveResult.bind(s.lifecycle);s.lifecycle.saveResult=async()=>{throw new Error('injected_artifact_failure');};
 await assert.rejects(s.processor.process(s.terminal()),/injected_artifact_failure/);assert.equal((await s.replies()).length,0);s.lifecycle.saveResult=original;
 await s.lifecycle.enqueue(s.terminal());await writeFile(path.join(s.root,'lifecycle','inbox',randomUUID()+'.json'),'{bad');
 await assert.rejects(s.processor.drain(),/lifecycle_inbox_invalid/);assert.equal((await s.lifecycle.recover()).quarantined,1);
});
