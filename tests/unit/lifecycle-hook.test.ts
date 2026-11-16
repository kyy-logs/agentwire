import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {temp} from '../helpers.ts';
import {lifecycleFixture} from '../lifecycle-helpers.ts';
test('registered terminal hook captures exact output while Bus is offline and input still in inbox',async t=>{
 const s=await lifecycleFixture(t);const {writeHookEvent}=await import('../../src/lifecycle/hook.ts');await writeHookEvent(s.root,s.begin);
 const hook=fileURLToPath(new URL('../../src/lifecycle/hook.ts',import.meta.url));
 const result=await new Promise<any>((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-strip-types',hook,'--state',s.root,'--provider','claude','--session',s.begin.sessionId],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='',stdout='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));p.stdin.end(JSON.stringify({session_id:s.begin.sessionId,prompt_id:s.begin.nativeExecutionId,hook_event_name:'Stop',last_assistant_message:'offline native 667'}));});
 assert.deepEqual(result,{code:0,stdout:'',stderr:''});await s.processor.recover();assert.equal((await s.replies()).length,1);assert.match((await s.replies())[0].message.body,/offline native 667/);
});
test('terminal hook never persists ordinary output after known or pending same-execution contamination',async t=>{
 for(const consumed of [false,true]){
  const s=await lifecycleFixture(t);await s.processor.process(s.begin);const {normalizeHook}=await import('../../src/lifecycle/normalize.ts');
  await s.lifecycle.enqueue(normalizeHook('claude',{session_id:s.begin.sessionId,prompt_id:s.begin.nativeExecutionId,hook_event_name:'UserPromptSubmit',prompt:'ordinary private input'})!);if(consumed)await s.processor.drain();
  const hook=fileURLToPath(new URL('../../src/lifecycle/hook.ts',import.meta.url));const output='ORDINARY_PRIVATE_REVIEW_SENTINEL';
  const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-strip-types',hook,'--state',s.root,'--provider','claude','--session',s.begin.sessionId],{windowsHide:true,stdio:['pipe','ignore','pipe']});p.on('error',reject);p.on('close',resolve);p.stdin.end(JSON.stringify({session_id:s.begin.sessionId,prompt_id:s.begin.nativeExecutionId,hook_event_name:'Stop',last_assistant_message:output}));});assert.equal(code,0);
  for(const file of await s.lifecycle.readInbox())assert.ok(!(await readFile(file,'utf8')).includes(output));
  await s.processor.drain();assert.ok(!JSON.stringify(await s.lifecycle.events()).includes(output));assert.equal((await s.replies()).length,0);
 }
});
test('hook_writes_without_bus; concurrent_hooks_do_not_overwrite',async t=>{
  const module=await import('../../src/lifecycle/hook.ts');const normalize=await import('../../src/lifecycle/normalize.ts');
  const root=await temp(t),session=randomUUID();
  await Promise.all(Array.from({length:6},()=>module.writeHookEvent(root,normalize.normalizeHook('codex',{session_id:session,turn_id:randomUUID(),hook_event_name:'Stop',last_assistant_message:'结果🙂'})!)));
  const files=await readdir(path.join(root,'lifecycle','inbox'));assert.equal(files.length,6);assert.ok(files.every(x=>x.endsWith('.json')));
  assert.equal(JSON.parse(await readFile(path.join(root,'lifecycle','inbox',files[0]),'utf8')).output,'结果🙂');
});
test('oversize_and_missing_native_id_never_report_success; hook subprocess never needs IPC',async t=>{
  const root=await temp(t),session=randomUUID(),hook=fileURLToPath(new URL('../../src/lifecycle/hook.ts',import.meta.url));
  const run=(input:string)=>new Promise<any>((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-strip-types',hook,'--state',root,'--provider','codex','--session',session],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.stdin.on('error',()=>{});p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));p.stdin.end(input);});
  // Import first gives a deliberate missing-feature assertion in RED.
  await import('../../src/lifecycle/hook.ts');
  for(const input of [JSON.stringify({session_id:session,hook_event_name:'Stop'}),'x'.repeat(1048577)]){const r=await run(input);assert.notEqual(r.code,0);assert.equal(r.stdout,'');assert.match(r.stderr,/lifecycle_hook_error/);}
  const good=await run(JSON.stringify({session_id:session,turn_id:randomUUID(),hook_event_name:'Stop',last_assistant_message:'ok'}));assert.deepEqual(good,{code:0,stdout:'',stderr:''});
  const events=await readdir(path.join(root,'lifecycle','inbox'));for(const file of events){const event=JSON.parse(await readFile(path.join(root,'lifecycle','inbox',file),'utf8'));assert.equal(event.output,undefined,'ordinary/unregistered output must not be retained');}
});
