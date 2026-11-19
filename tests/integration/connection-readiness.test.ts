import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {startMain} from '../../src/main.ts';
import {FileLifecycleStore} from '../../src/lifecycle/store.ts';
import {eventKey,executionKey} from '../../src/lifecycle/model.ts';
import {selectConnection,beginProbes,inspectConnection,askPeer} from '../../src/installation/connections.ts';

async function connected(t:any,mode:'legacy'|'clean-v1'='clean-v1',answer='23 × 29 = 667\n另有旧聊天说明。'){
 const root=await temp(t),c={home:root,installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath};
 const candidates=['codex','claude'].map(provider=>({provider,sessionId:randomUUID(),workspaceRoot:root,availability:'candidate'})) as any;
 const source={provider:'codex',sessionId:candidates[0].sessionId} as const;
 const connection=await selectConnection(c,source,candidates[1],{self:candidates[0],probeWireVersion:mode});
 const state=path.join(c.installRoot,'connections',connection.connectionId,'state'),life=new FileLifecycleStore(state),native=new Map(),sent:any[]=[];
 const reader:any={inspect:async(i:any)=>native.get(i.transportId)||{status:'missing'}};
 const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available',details:[]}),reconcile:async()=>({status:'submitted',evidenceRef:'isolated-native-receipt'}),submit:async(b:any,m:any,o:any)=>{
  sent.push(m);const ref={provider:kind,sessionId:b.sessionId,nativeExecutionId:randomUUID()};
  const output=m.to==='claude'?answer:mode==='legacy'?'LOCALBUS-CONNECT '+m.messageId+' 667':'667';
  if(o?.transportId)native.set(o.transportId,{status:'mapped',identity:{...ref,transportId:o.transportId,evidenceRef:'isolated-native-input'},...(m.kind!=='reply'?{terminal:{ref,nativeOutcome:'response_ended',body:output,evidenceRef:'isolated-native-final',backgroundPending:false,continuation:false,incomplete:false}}:{})});
  if(m.kind!=='reply'){
   if(mode==='clean-v1')await life.enqueueCleanHint({schemaVersion:1,...ref,phase:'stop',observedAt:new Date().toISOString(),backgroundPending:false,continuation:false,incomplete:false} as any);
   else for(const phase of ['input','stop'] as const)await life.enqueue({schemaVersion:1,...ref,phase,eventKey:eventKey(ref as any,phase),observedAt:new Date().toISOString(),...(phase==='input'?{messageId:m.messageId,dispatchNonce:o.dispatchNonce,inputKind:'task'}:{output})} as any);
  }
  return {status:'accepted'};
 }}));
 const main=await startMain(state,{quiet:true,signals:false,intervalMs:0,adapters:adapters as any,connectionId:connection.connectionId,newAutoWireVersion:mode,native:{client:{call:async()=>{throw Error('unexpected_native_call');},close:async()=>{}},readers:{codex:reader,claude:reader}}});t.after(()=>main.close());
 const deps={ensure:async()=>({}),now:()=>new Date(Date.now()+180000)};
 await beginProbes(c,connection.connectionId,deps as any);await main.bus.tick();await main.lifecycle.drain();await main.clean.drain();await main.bus.tick();await main.bus.tick();
 const task=(await main.bus.store.get(connection.probeIds.forward))!,reply=(await main.bus.store.get(task.resultRef!))!,result=(await life.getResult(task.message.messageId))!,execution=(await life.getExecution(result.ref))!;
 assert.equal(task.state,'completed');assert.equal(reply.state,'delivered');assert.equal(execution.phase,'applied');
 const files={task:path.join(state,'messages',task.message.messageId+'.json'),reply:path.join(state,'messages',reply.message.messageId+'.json'),result:path.join(state,'lifecycle/results',task.message.messageId+'.json'),execution:path.join(state,'lifecycle/executions',executionKey(result.ref)+'.json'),attempt:path.join(state,'native/attempts',task.activeAttemptId+'.json')};
 const mutate=async(which:keyof typeof files,change:(r:any)=>void)=>{const value=JSON.parse(await readFile(files[which],'utf8'));change(value);await writeFile(files[which],JSON.stringify(value));};
 return {c,connection,main,life,state,source,deps,task,reply,result,execution,files,mutate,sent};
}

for(const mode of ['legacy','clean-v1'] as const)test(mode+' exact roundtrip permits annotated answers and records answer mismatch without replay',async t=>{
 const f=await connected(t,mode),before=(await f.main.bus.store.list()).length;
 const r:any=await inspectConnection(f.c,f.connection.connectionId,f.deps as any);
 assert.equal(r.phase,'ready');assert.equal(r.probeChecks.forward.transport,'observed');assert.equal(r.probeChecks.forward.answer,'different');assert.equal(r.probeChecks.reverse.answer,'expected');
 assert.equal((await f.main.bus.store.list()).length,before);assert.equal(f.task.attempts,1);
 const asked=await askPeer(f.c,f.source,'claude','new explicitly authorized task',randomUUID(),f.deps as any);assert.equal(asked.state,'pending');
});
test('transport readiness does not claim an incorrect arithmetic answer is correct',async t=>{
 const f=await connected(t,'clean-v1','999');const r:any=await inspectConnection(f.c,f.connection.connectionId,f.deps as any);
 assert.equal(r.phase,'ready');assert.equal(r.probeChecks.forward.answer,'different');assert.equal(f.result.businessVerdict,'unverified');
});
test('losing confirmed evidence after readiness immediately blocks new asks before the deadline',async t=>{
 const f=await connected(t,'clean-v1','667'),deps={...f.deps,now:()=>new Date(f.connection.createdAt)};
 assert.equal((await inspectConnection(f.c,f.connection.connectionId,deps as any)).phase,'ready');
 await f.life.markConflict(f.result.ref,'test_late_conflict');
 const checked:any=await inspectConnection(f.c,f.connection.connectionId,deps as any);
 assert.equal(checked.phase,'needs_check');assert.equal(checked.probeChecks.forward.transport,'unconfirmed');
 await assert.rejects(askPeer(f.c,f.source,'claude','must not be accepted',randomUUID(),deps as any),/connection_not_ready/);
 assert.equal((await f.main.bus.store.list()).length,4);
});

const damage:[string,(f:any)=>Promise<unknown>][]=[
 ['missing capture',f=>unlink(f.files.result)],
 ['uncertain reply',f=>f.mutate('reply',(r:any)=>{r.state='needs_check';r.receipt={status:'unknown'};})],
 ['missing receipt evidence',f=>f.mutate('reply',(r:any)=>{r.receipt={status:'accepted'};})],
 ['reply to another task',f=>f.mutate('reply',(r:any)=>{r.message.replyTo=randomUUID();})],
 ['reply from another chat',f=>f.mutate('reply',(r:any)=>{r.message.sourceSessionId=randomUUID();})],
 ['reply to another chat',f=>f.mutate('reply',(r:any)=>{r.message.targetSessionId=randomUUID();})],
 ['reply from wrong provider',f=>f.mutate('reply',(r:any)=>{r.message.from='codex';r.message.to='claude';})],
 ['capture terminal mismatch',f=>f.mutate('task',(r:any)=>{r.completion.eventKey='a'.repeat(64);})],
 ['unfinished execution projection',f=>f.mutate('execution',(r:any)=>{r.phase='waiting';})],
 ['execution nonce mismatch',f=>f.mutate('execution',(r:any)=>{r.dispatchNonce=randomUUID();})],
 ['execution conflict',f=>f.life.markConflict(f.result.ref,'test_conflict')],
 ['native attempt from another connection',f=>f.mutate('attempt',(r:any)=>{r.connectionId=randomUUID();})],
 ['native attempt from another turn',f=>f.mutate('attempt',(r:any)=>{r.nativeExecutionId=randomUUID();})],
 ['native attempt not confirmed',f=>f.mutate('attempt',(r:any)=>{r.phase='needs_check';})],
];
for(const [label,change] of damage)test('answer-independent readiness still rejects '+label,async t=>{
 const f=await connected(t,'clean-v1','667');await change(f);
 const r=await inspectConnection(f.c,f.connection.connectionId,f.deps as any);assert.equal(r.phase,'needs_check');
});
for(const field of ['body','messageId'] as const)test('corrupt capture '+field+' preserves the storage rejection',async t=>{
 const f=await connected(t,'clean-v1','667');await f.mutate('result',r=>{r[field]=field==='body'?r.body+' altered':randomUUID();});
 await assert.rejects(inspectConnection(f.c,f.connection.connectionId,f.deps as any),/invalid_result_artifact/);
});
