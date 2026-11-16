import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {LocalBus} from '../../src/bus.ts';
import {FileMessageStore} from '../../src/store.ts';
import {ClaudeAdapter,resolveClaude,postClaude} from '../../src/adapters/claude.ts';
import {createObserver} from '../../src/observer.ts';
import {temp,clock,taskInput} from '../helpers.ts';
async function peer(home:string,session:string){
  const child=fork(fileURLToPath(new URL('../fixtures/claude-peer.ts',import.meta.url)),[home,session],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('fixture_start_timeout'));},5000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error('fixture_exit_'+code));});});
  return {pid:child.pid!,async stop(){if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await exited;}};
}
test('real child endpoint exits then same-session new PID reconnects without changing binding',async t=>{
  let live:Awaited<ReturnType<typeof peer>>|undefined;
  const home=await temp({after:(fn:any)=>t.after(async()=>{await live?.stop();await fn();})} as any),time=clock(),sessionId=randomUUID();
  live=await peer(home,sessionId);const first=live.pid;assert.equal((await resolveClaude(sessionId,home))?.pid,first);await live.stop();assert.equal(await resolveClaude(sessionId,home),undefined);
  const observer=createObserver({claudeHome:home,codexHome:home});
  const observe=async(b:any,r:any)=>{for(let i=0;i<20;i++){const result=await observer(b,r);if(result.status==='submitted')return result;await new Promise(resolve=>setTimeout(resolve,20));}return {status:'unknown' as const};};
  const adapter=new ClaudeAdapter({resolve:id=>resolveClaude(id,home),post:postClaude,observe});
  const bindings=[{agentId:'codex',kind:'codex' as const,sessionId:randomUUID(),workspaceRoot:home},{agentId:'claude',kind:'claude' as const,sessionId,workspaceRoot:home}];
  const store=new FileMessageStore(path.join(home,'state'),time),bus=new LocalBus({store,adapters:[adapter],bindings,clock:time});
  const task=await bus.accept(taskInput());await bus.tick();assert.equal((await store.get(task.message.messageId))?.state,'pending');
  live=await peer(home,sessionId);assert.notEqual(live.pid,first);assert.equal((await resolveClaude(sessionId,home))?.pid,live.pid);
  time.value+=1000;await bus.tick();const record=(await store.get(task.message.messageId))!;assert.equal(record.state,'submitted');assert.equal(record.attempts,2);assert.equal(record.message.targetSessionId,sessionId);
  await bus.tick();const lines=(await readFile(path.join(home,'projects','fixture',sessionId+'.jsonl'),'utf8')).trim().split('\n');assert.equal(lines.length,1);
});
test('peer restart after unconfirmed acceptance never causes an automatic duplicate',async t=>{
  let live:Awaited<ReturnType<typeof peer>>|undefined;
  const home=await temp({after:(fn:any)=>t.after(async()=>{await live?.stop();await fn();})} as any),time=clock(),sessionId=randomUUID();live=await peer(home,sessionId);
  const observer=createObserver({claudeHome:home,codexHome:home});let allowObservation=false;
  const adapter=new ClaudeAdapter({resolve:id=>resolveClaude(id,home),post:postClaude,observe:async(b,r)=>allowObservation?observer(b,r):{status:'unknown'}});
  const bindings=[{agentId:'codex',kind:'codex' as const,sessionId:randomUUID(),workspaceRoot:home},{agentId:'claude',kind:'claude' as const,sessionId,workspaceRoot:home}];
  const store=new FileMessageStore(path.join(home,'state'),time),bus=new LocalBus({store,adapters:[adapter],bindings,clock:time});const task=await bus.accept(taskInput());await bus.tick();
  assert.equal((await store.get(task.message.messageId))?.state,'needs_check');
  // Wait until the fixture has committed its inbound before crashing that test-owned child.
  for(let i=0;i<30;i++){if((await observer(bindings[1],(await store.get(task.message.messageId))!)).status==='submitted')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal((await observer(bindings[1],(await store.get(task.message.messageId))!)).status,'submitted');
  await live.stop();live=await peer(home,sessionId);time.value+=1000;await bus.tick();assert.equal((await store.get(task.message.messageId))?.attempts,1);
  allowObservation=true;assert.equal((await bus.check(task.message.messageId)).state,'submitted');await bus.tick();assert.equal((await readFile(path.join(home,'projects','fixture',sessionId+'.jsonl'),'utf8')).trim().split('\n').length,1);
});
