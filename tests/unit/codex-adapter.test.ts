import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CodexAdapter} from '../../src/adapters/codex.ts';
import {createTask} from '../../src/model.ts';
import {clock,taskInput} from '../helpers.ts';
const binding={agentId:'codex',kind:'codex' as const,sessionId:randomUUID(),workspaceRoot:'C:/project'};
const message=()=>createTask({...taskInput(),from:'claude',to:'codex',targetSessionId:binding.sessionId},clock());
test('accepted_preserves_native_id; shell text is one argument; no automatic retry',async()=>{
  const nativeId=randomUUID();let calls=0,args:readonly string[]=[];
  const a=new CodexAdapter(async(exe,a)=>{calls++;args=a;return {exitCode:0,stdout:`Queued message ${nativeId} for thread ${binding.sessionId}.`,stderr:'',timedOut:false};},{exe:'C:/Codex.exe'});
  const m=message(),r=await a.submit(binding,m);assert.equal(r.status,'accepted');assert.equal(r.nativeId,nativeId);assert.equal(calls,1);
  assert.ok(args[args.indexOf('--message')+1].includes(m.body));assert.ok(!args.includes('--resume'));
});
test('queue_success_resume_warning_is_not_wake_success',async()=>{
  const a=new CodexAdapter(async()=>({exitCode:0,stdout:`Queued message ${randomUUID()} for thread ${binding.sessionId}.`,stderr:'Warning: failed to resume thread',timedOut:false}),{exe:'codex'});
  const r=await a.submit(binding,message());assert.equal(r.status,'accepted');assert.equal(r.errorCode,'native_warning');
});
test('timeout_after_possible_accept_is_unknown; unknown_thread_is_rejected',async()=>{
  for(const [result,expected] of [[{exitCode:null,stdout:'',stderr:'',timedOut:true},'unknown'],[{exitCode:1,stdout:'',stderr:'thread not found',timedOut:false},'rejected']] as const){
    const a=new CodexAdapter(async()=>result,{exe:'codex'});const r=await a.submit(binding,message());assert.equal(r.status,expected);assert.equal(r.retryable,false);
  }
});
test('Windows oversized argv is definitively rejected before launching a process',{skip:process.platform!=='win32'},async()=>{
  for(const body of ['a'.repeat(40000),'\\"'.repeat(11000)]){
    let calls=0;const a=new CodexAdapter(async()=>{calls++;return {exitCode:0,stdout:`Queued message ${randomUUID()} for thread ${binding.sessionId}.`,stderr:'',timedOut:false};},{exe:'C:/Program Files/Codex/codex.exe'});
    const r=await a.submit(binding,{...message(),body});assert.equal(r.status,'rejected');assert.equal(r.errorCode,'command_line_too_long');assert.equal(r.retryable,false);assert.equal(calls,0);
  }
});

test('native schema2 Codex adapter preserves structured task question and report instructions',async()=>{const sent:string[]=[];const app:any={async call(_method:string,p:any){sent.push(p.input[0].text);return {queuedSubmission:{id:randomUUID(),clientUserMessageId:p.clientUserMessageId}};}};const adapter=new CodexAdapter(async()=>{throw Error('unexpected child');},{exe:'codex',appServer:app});for(const phase of ['working','waiting_answer','waiting_acceptance']){const m:any={...message(),schemaVersion:2,wireVersion:'clean-v1',sourceSessionId:randomUUID()};await adapter.submit(binding,m,{transportId:randomUUID(),collaboration:{taskId:m.taskId,revision:0,phase}});}assert.match(sent[0],/deliver/);assert.match(sent[1],/answer/);assert.doesNotMatch(sent[1],/无需确认或回信/);assert.match(sent[2],/accept/);});
