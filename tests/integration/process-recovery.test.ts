import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {requestBus} from '../../src/ipc.ts';
import {temp} from '../helpers.ts';
async function run(root:string,mode:string){
  const child=fork(fileURLToPath(new URL('../fixtures/crashing-bus.ts',import.meta.url)),[root,mode],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));let entered:(id:string)=>void;
  const submitting=new Promise<string>(resolve=>entered=resolve);child.on('message',(m:any)=>{if(m.submitting)entered(m.submitting);});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('fixture_start_timeout'));},5000);child.on('message',(m:any)=>{if(m.ready){clearTimeout(timer);resolve();}});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',c=>{clearTimeout(timer);reject(Error('fixture_exit_'+c));});});
  return {submitting,async stop(){if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await exited;}};
}
test('actual Bus process crash after submit-start restarts as needs_check without replay',async t=>{
  let child:Awaited<ReturnType<typeof run>>|undefined;const root=await temp({after:(fn:any)=>t.after(async()=>{await child?.stop();await fn();})} as any);
  child=await run(root,'hold');const call=(op:string,payload?:any)=>requestBus(root,{requestId:randomUUID(),op,payload});
  for(const agentId of ['codex','claude'])assert.equal((await call('bind',{agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root})).ok,true);
  const id=randomUUID();assert.equal((await call('accept',{messageId:id,kind:'task',from:'codex',to:'claude',body:'crash test'})).ok,true);
  assert.equal(await Promise.race([child.submitting,new Promise((_,reject)=>setTimeout(()=>reject(Error('submit_not_started')),3000))]),id);
  await child.stop();const saved=JSON.parse(await readFile(path.join(root,'messages',id+'.json'),'utf8'));assert.equal(saved.state,'submitting');assert.equal(saved.attempts,1);
  child=await run(root,'accept');const response=await call('status',{});assert.equal(response.ok,true);assert.equal(response.data.items[0].state,'needs_check');assert.equal(response.data.items[0].attempts,1);
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await readFile(path.join(root,'fixture-submit-count.txt'),'utf8')).trim().split('\n').length,1);
});
