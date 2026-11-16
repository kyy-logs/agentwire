import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startMain} from '../../src/main.ts';
import {runCli} from '../../src/cli.ts';
import {temp,clock,taskInput} from '../helpers.ts';
import {envelope} from '../../src/envelope.ts';
import {CodexAdapter} from '../../src/adapters/codex.ts';
import {ClaudeAdapter} from '../../src/adapters/claude.ts';

async function setup(t:any){
  let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})}),time=clock(),sent:any[]=[];
  const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(b:any,m:any,options:any)=>{sent.push({b,m,options});return {status:'accepted' as const};},reconcile:async()=>({status:'unknown' as const})}));
  const start=async()=>runtime=await startMain(root,{adapters,clock:time,intervalMs:0,signals:false,quiet:true});await start();
  for(const agentId of ['codex','claude'])await runtime.bus.bind({agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root});
  const cli=async(args:string[])=>{const out:string[]=[];const code=await runCli(['--state',root,...args],{stdout:{write:s=>out.push(s)},stderr:{write:s=>out.push(s)}});return {code,text:out.join('')};};
  return {get bus(){return runtime.bus;},root,time,sent,cli,restart:async()=>{await runtime.close();await start();}};
}

test('reply-current routes the unique submitted task and stable retry cannot reply to a newer task',async t=>{
  const s=await setup(t),task=await s.bus.accept(taskInput());await s.bus.tick();const id=randomUUID();
  const args=['reply-current','--from','claude','--text','done','--id',id];assert.equal((await s.cli(args)).code,0);
  assert.equal((await s.bus.check(task.message.messageId)).state,'completed');assert.equal((await s.bus.check(id)).message.replyTo,task.message.messageId);
  assert.match((await s.cli(['reply-current','--from','claude','--text','done'])).text,/no_current_task/);
  await s.bus.tick();const next=await s.bus.accept(taskInput());await s.bus.tick();await s.restart();
  assert.equal((await s.cli(args)).code,0);assert.equal((await s.bus.check(next.message.messageId)).state,'submitted');
  assert.equal((await s.bus.status()).filter((r:any)=>r.message.kind==='reply').length,1);
  assert.equal((await s.cli(['reply-current','--from','claude','--text','changed','--id',id])).code,3);
});

test('reply-current refuses absent, pending, unknown, stopped and expired tasks',async t=>{
  const s=await setup(t),args=['reply-current','--from','claude','--text','done'];
  assert.match((await s.cli(args)).text,/no_current_task/);const task=await s.bus.accept(taskInput());
  assert.match((await s.cli(args)).text,/no_current_task/);await s.bus.tick();
  const record=await s.bus.store.get(task.message.messageId);record.state='needs_check';record.receipt={status:'unknown'};await s.bus.store.replace(record);
  assert.match((await s.cli(args)).text,/no_current_task/);record.receipt={status:'accepted'};await s.bus.store.replace(record);
  await s.bus.stop(task.message.taskId);assert.match((await s.cli(args)).text,/no_current_task/);
  const other=await s.bus.accept(taskInput());await s.bus.tick();s.time.value=Date.parse(other.message.expiresAt);
  assert.match((await s.cli(args)).text,/no_current_task/);
});

test('reply-current rejects ambiguous tasks instead of picking the most recent',async t=>{
  const s=await setup(t);const first=await s.bus.accept(taskInput());await s.bus.tick();const second=await s.bus.accept(taskInput());
  // Corrupt/external legacy state must fail closed even though the scheduler normally serializes the target.
  const r=await s.bus.store.get(second.message.messageId);r.state='submitted';r.attempts=1;r.receipt={status:'accepted'};await s.bus.store.replace(r);
  const result=await s.cli(['reply-current','--from','claude','--text','done']);assert.equal(result.code,3);assert.match(result.text,/ambiguous_current_task/);
  assert.equal((await s.bus.check(first.message.messageId)).state,'submitted');
});

test('one reminder after five minutes survives restart and does not extend the deadline',async t=>{
  const s=await setup(t),task=await s.bus.accept(taskInput());await s.bus.tick();const before=await s.bus.check(task.message.messageId);
  s.time.value+=299999;await s.bus.tick();assert.equal(s.sent.length,1);s.time.value+=1;await s.bus.tick();assert.equal(s.sent.length,2);
  const reminder=s.sent[1];assert.equal(reminder.options.reminderFor,task.message.messageId);assert.notEqual(reminder.m.messageId,task.message.messageId);
  const text=envelope(reminder.m,{cliPath:'C:/bus/cli.ts',stateRoot:s.root},reminder.options);
  assert.match(text,/kind=reminder/);assert.match(text,/reply-current/);assert.ok(!text.includes(task.message.body));
  const after=await s.bus.check(task.message.messageId);assert.equal(after.state,'submitted');assert.equal(after.attempts,1);assert.equal(after.resultDeadlineAt,before.resultDeadlineAt);
  await s.restart();await s.bus.tick();assert.equal(s.sent.length,2);s.time.value+=300000;await s.bus.tick();assert.equal(s.sent.length,2);
  assert.equal((await s.bus.check(task.message.messageId)).state,'needs_check');
  assert.equal((await s.cli(['reply-current','--from','claude','--text','late but within root TTL'])).code,0);
});

test('unknown reminder outcome is not replayed and shutdown during reminder commit never sends',async t=>{
  const s=await setup(t),task=await s.bus.accept(taskInput());await s.bus.tick();
  const adapter=s.bus.adapters.get('claude'),submit=adapter.submit;adapter.submit=async(...args:any[])=>{await submit(...args);return {status:'unknown'};};
  s.time.value+=300000;await s.bus.tick();assert.equal(s.sent.length,2);await s.restart();await s.bus.tick();assert.equal(s.sent.length,2);
  assert.equal((await s.bus.check(task.message.messageId)).reminder.receipt.status,'unknown');
  await s.bus.stop(task.message.taskId);const next=await s.bus.accept(taskInput({from:'claude',to:'codex'}));await s.bus.tick();s.time.value+=300000;
  s.bus.store.hooks.beforeRename=async()=>s.bus.requestShutdown();await s.bus.tick();
  assert.equal(s.sent.length,3);assert.equal((await s.bus.store.get(next.message.messageId)).state,'submitted');
});

for(const action of ['complete','stop','expire','timeout'] as const)test(`no reminder after ${action}`,async t=>{
  const s=await setup(t),task=await s.bus.accept(taskInput());await s.bus.tick();
  if(action==='complete')assert.equal((await s.cli(['reply-current','--from','claude','--text','done'])).code,0);
  if(action==='stop')await s.bus.stop(task.message.taskId);
  s.time.value+=action==='expire'?1800000:action==='timeout'?600000:300000;await s.bus.tick();
  assert.equal(s.sent.filter(x=>x.options?.reminderFor).length,0);
});

test('native adapters send reminder identity and do not embed the original work again',async t=>{
  const s=await setup(t),task=await s.bus.accept(taskInput()),m=task.message,command={cliPath:'C:/bus/cli.ts',stateRoot:s.root};
  const codexBinding={...s.bus.binding('codex')},claudeBinding=s.bus.binding('claude');let wire='';
  const codex=new CodexAdapter(async(_exe,args)=>{wire=args[args.indexOf('--message')+1];return {exitCode:0,stdout:`Queued message ${randomUUID()} for thread ${codexBinding.sessionId}.`,stderr:'',timedOut:false};},{exe:'codex',command});
  await codex.submit(codexBinding,{...m,targetSessionId:codexBinding.sessionId},{reminderFor:m.messageId});
  assert.match(wire,/kind=reminder/);assert.ok(!wire.includes(m.body));
  const reminderId=randomUUID();let observedId='';const claude=new ClaudeAdapter({resolve:async()=>({pid:1,sessionId:claudeBinding.sessionId,socketPath:'fake',token:'test'}),post:async(_endpoint,text)=>{wire=text;return {status:'unknown'};},command,observe:async(_b,r)=>{observedId=r.message.messageId;return {status:'submitted',evidenceRef:'current-reminder-inbound'};}});
  assert.equal((await claude.submit(claudeBinding,{...m,messageId:reminderId},{reminderFor:m.messageId})).status,'accepted');
  assert.equal(observedId,reminderId);assert.match(wire,/kind=reminder/);assert.ok(!wire.includes(m.body));
});

test('crash after reminder transport but before receipt commit never repeats the notice',async t=>{
  const s=await setup(t),task=await s.bus.accept(taskInput());await s.bus.tick();s.time.value+=300000;
  const replace=s.bus.store.replace.bind(s.bus.store);let writes=0;s.bus.store.replace=async(r:any)=>{if(r.reminder&&++writes===2)throw Error('simulated_receipt_commit_crash');await replace(r);};
  await assert.rejects(s.bus.tick(),/simulated_receipt_commit_crash/);assert.equal(s.sent.length,2);
  await s.restart();await s.bus.tick();assert.equal(s.sent.length,2);const record=await s.bus.check(task.message.messageId);
  assert.equal(record.reminder.receipt.status,'unknown');assert.equal(record.attempts,1);
});
