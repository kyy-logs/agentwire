import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {disconnect,activeConnection} from '../../src/installation/connections.ts';
import {createTask,realClock} from '../../src/model.ts';
import {IdentityStore} from '../../src/native/identity-store.ts';
import {digest,eventKey} from '../../src/lifecycle/model.ts';
import {requestBus} from '../../src/ipc.ts';

async function fixture(t:any){
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps),main=[...f.services.values()][0];
 const routes=path.join(f.c.installRoot,'routes.json');
 return {...f,r,main,routes};
}

test('normal disconnect retains expired reply with uncertain native delivery; explicit archive preserves all records',async t=>{
 const f=await fixture(t),id=randomUUID(),replyId=randomUUID(),attemptId=randomUUID();
 const task:any={...createTask({messageId:id,from:'codex',to:'claude',targetSessionId:f.r.claude.sessionId,body:'old test'},realClock),schemaVersion:2,wireVersion:'clean-v1',sourceSessionId:f.r.codex.sessionId};
 const reply:any={...task,messageId:replyId,kind:'reply',replyTo:id,taskId:id,from:'claude',to:'codex',sourceSessionId:f.r.claude.sessionId,targetSessionId:f.r.codex.sessionId,body:'667'};
 const p=(await f.main.bus.store.putNew(task)).record,q=(await f.main.bus.store.putNew(reply)).record;
 await f.main.bus.store.replace({...p,state:'completed',attempts:1,resultRef:replyId,receipt:{status:'accepted'}});
 await f.main.bus.store.replace({...q,state:'expired',attempts:1,activeAttemptId:attemptId,receipt:{status:'accepted'}});
 const identities=new IdentityStore(f.main.bus.store.root,realClock);
 await identities.prepare({schemaVersion:1,connectionId:f.r.connectionId,provider:'codex',targetSessionId:reply.targetSessionId,sourceSessionId:reply.sourceSessionId,messageId:replyId,attemptId,transportId:randomUUID(),wireVersion:'clean-v1',bodySha256:digest(reply.body),createdAt:reply.createdAt,updatedAt:reply.createdAt,phase:'queued'});
 const before=await readFile(f.routes),messages=await f.main.bus.store.list();let shutdowns=0;
 const deps={shutdown:async()=>{shutdowns++;await f.main.close();return {status:'closed' as const};}};
 const result=await disconnect(f.c,f.r.connectionId,false,deps);
 assert.equal(result.phase,'needs_check');assert.equal(shutdowns,0);assert.deepEqual(await readFile(f.routes),before);
 assert.deepEqual(await f.main.bus.store.list(),messages);
 const archived=await disconnect(f.c,f.r.connectionId,false,{...deps,archive:true});
 assert.equal(archived.phase,'disconnected');assert.equal(shutdowns,1);assert.equal((await identities.get(attemptId))?.phase,'queued');
 assert.deepEqual(await f.main.bus.store.list(),messages);
});

test('unapplied lifecycle event blocks disconnect without removing routes or stopping Bus',async t=>{
 const f=await fixture(t),ref={provider:'codex' as const,sessionId:f.r.codex.sessionId,nativeExecutionId:randomUUID()};
 await f.main.lifecycle.store.putEvent({schemaVersion:1,...ref,phase:'stop',eventKey:eventKey(ref,'stop'),observedAt:new Date().toISOString()});
 const before=await readFile(f.routes);let shutdowns=0;
 await assert.rejects(disconnect(f.c,f.r.connectionId,false,{shutdown:async()=>{shutdowns++;return {status:'closed'};}}),/connection_storage_requires_check/);
 assert.deepEqual(await readFile(f.routes),before);assert.equal(shutdowns,0);assert.equal((await activeConnection(f.c)).phase,'paired');
});

test('unconfirmed Bus shutdown leaves original routes and selected connection intact',async t=>{
 const f=await fixture(t),before=await readFile(f.routes);
 await assert.rejects(disconnect(f.c,f.r.connectionId,false,{shutdown:async()=>({status:'needs_check'})}),/service_shutdown_unconfirmed/);
 assert.deepEqual(await readFile(f.routes),before);assert.equal((await activeConnection(f.c,true)).phase,'paired');
 await assert.rejects(activeConnection(f.c),/connection_switch_requires_check/);
 assert.equal(JSON.parse(await readFile(path.join(f.c.installRoot,'connection-transition.json'),'utf8')).phase,'disconnecting');
});

test('explicitly rejected task has no native work and does not prevent clean disconnect',async t=>{
 const f=await fixture(t),task=createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.r.claude.sessionId,body:'never written'},realClock),p=(await f.main.bus.store.putNew(task)).record;
 await f.main.bus.store.replace({...p,state:'failed',attempts:1,receipt:{status:'rejected',retryable:false}});
 const result=await disconnect(f.c,f.r.connectionId,false,{shutdown:async()=>{await f.main.close();return {status:'closed'};}});
 assert.equal(result.phase,'disconnected');
});

test('new lifecycle evidence during shutdown preserves routes and the durable transition guard',async t=>{
 const f=await fixture(t),before=await readFile(f.routes),ref={provider:'codex' as const,sessionId:f.r.codex.sessionId,nativeExecutionId:randomUUID()};
 await assert.rejects(disconnect(f.c,f.r.connectionId,false,{shutdown:async()=>{
  await f.main.lifecycle.store.enqueue({schemaVersion:1,...ref,phase:'stop',eventKey:eventKey(ref,'stop'),observedAt:new Date().toISOString()});
  await f.main.close();return {status:'closed'};
 }}),/connection_storage_requires_check/);
 assert.deepEqual(await readFile(f.routes),before);
 assert.equal(JSON.parse(await readFile(path.join(f.c.installRoot,'connection-transition.json'),'utf8')).phase,'disconnecting');
});

test('disconnect guard rejects low-level IPC admission while Bus is closing',async t=>{
 const f=await fixture(t),root=f.main.bus.store.root;let admission:any;
 const result=await disconnect(f.c,f.r.connectionId,false,{shutdown:async()=>{
  admission=await requestBus(root,{requestId:randomUUID(),op:'accept',payload:{messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'race'}});
  await f.main.close();return {status:'closed'};
 }});
 assert.equal(result.phase,'disconnected');assert.equal(admission.ok,false);assert.equal(admission.errorCode,'connection_switch_requires_check');
 assert.equal((await f.main.bus.store.list()).length,0);assert.equal(f.sent.length,0);
 await assert.rejects(readFile(path.join(f.c.installRoot,'connection-transition.json')),{code:'ENOENT'});
});

test('missing IPC is not shutdown evidence while a matching managed Bus PID is still alive',async t=>{
 const f=await fixture(t),before=await readFile(f.routes);await f.main.close();
 const install=path.join(f.c.installRoot,'install');await mkdir(install,{recursive:true});
 await writeFile(path.join(install,'runtime-active.json'),JSON.stringify({stateRoot:path.resolve(f.main.bus.store.root),pid:process.pid}));
 await assert.rejects(disconnect(f.c,f.r.connectionId),/service_shutdown_unconfirmed/);
 assert.deepEqual(await readFile(f.routes),before);
 assert.equal(JSON.parse(await readFile(path.join(f.c.installRoot,'connection-transition.json'),'utf8')).phase,'disconnecting');
});
