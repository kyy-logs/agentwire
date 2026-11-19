import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode,recoverPairing} from '../../src/pairing/service.ts';
import {capturePairIntent,issueCode,readPairState} from '../../src/pairing/store.ts';
import {activeConnection,readConnection} from '../../src/installation/connections.ts';
import {requestBus} from '../../src/ipc.ts';
import {optional} from '../../src/installation/paths.ts';
import {FileMessageStore} from '../../src/store.ts';
import {createTask,realClock} from '../../src/model.ts';

async function replacement(t:any,provider:'codex'|'claude'='codex',intervalMs=0){
 const f=await pairingFixture(t,{intervalMs}),old=await redeemCode(f.c,f.redeemer.intentId,f.deps);
 const source=f.peers.find(p=>p.provider===provider)!,peer={...f.peers.find(p=>p.provider!==provider)!,sessionId:randomUUID(),workspaceRoot:path.join(f.root,'new peer')};
 f.peers.push(peer);const issue=f.make(peer,{kind:'issue'});await capturePairIntent(f.c,issue,f.deps);const code=await issueCode(f.c,issue.intentId,f.deps);
 const redeem=f.make(source,{kind:'redeem',target:peer.provider,code:code.code});await capturePairIntent(f.c,redeem,f.deps);
 const oldState=path.join(f.c.installRoot,'connections',old.connectionId,'state');
 const deps={...f.deps,shutdown:async(h:any)=>{const main=f.services.get(h.stateRoot);if(!main)throw Error('fixture_service_missing');await main.close();return {status:'closed'};}};
 return {...f,old,source,peer,code,redeem,oldState,deps};
}

for(const provider of ['codex','claude'] as const)test('fresh code automatically replaces an idle connection from '+provider+' and preserves history',async t=>{
 const f=await replacement(t,provider),store=new FileMessageStore(f.oldState,realClock),r=(await store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.old.claude.sessionId,body:'history'},realClock))).record;
 await store.replace({...r,state:'failed',errorCode:'fixture_history'});const file=path.join(f.oldState,'messages',r.message.messageId+'.json'),before=await readFile(file);
 const next=await redeemCode(f.c,f.redeem.intentId,f.deps);
 assert.notEqual(next.connectionId,f.old.connectionId);assert.equal(next.phase,'paired');assert.equal(next[f.source.provider].sessionId,f.source.sessionId);assert.equal(next[f.peer.provider].sessionId,f.peer.sessionId);
 assert.equal((await readConnection(f.c,f.old.connectionId)).phase,'disconnected');assert.equal((await activeConnection(f.c)).connectionId,next.connectionId);assert.deepEqual(await readFile(file),before);
 assert.equal(await optional(path.join(f.c.installRoot,'connection-transition.json')),undefined);assert.equal(f.sent.length,0);
 assert.equal((await redeemCode(f.c,f.redeem.intentId,f.deps)).connectionId,next.connectionId);
});

for(const mode of ['pending','uncertain','native','artifact','foreign_source','offline_target'] as const)test('replacement refuses '+mode+' before consuming code or changing old routes',async t=>{
 const f=await replacement(t),store=new FileMessageStore(f.oldState,realClock);
 if(['pending','uncertain','native'].includes(mode)){const r=(await store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.old.claude.sessionId,body:'work'},realClock))).record;if(mode!=='pending')await store.replace({...r,state:mode==='uncertain'?'needs_check':'stopped',attempts:1,receipt:{status:'unknown'}});}
 if(mode==='artifact'){const dir=path.join(f.oldState,'lifecycle','inbox');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'unfinished.tmp'),'partial');}
 let intent=f.redeem;if(mode==='foreign_source'){const other={...f.source,sessionId:randomUUID()};f.peers.push(other);intent=f.make(other,{kind:'redeem',target:f.peer.provider,code:f.code.code});await capturePairIntent(f.c,intent,f.deps);}
 const deps=mode==='offline_target'?{...f.deps,discover:async(c:any,p:any,id:any)=>id===f.peer.sessionId?[]:f.deps.discover(c,p,id)}:f.deps;
 const files=['active-connection.json','routes.json',`connections/${f.old.connectionId}/connection.json`],before=await Promise.all(files.map(x=>readFile(path.join(f.c.installRoot,x))));
 await assert.rejects(redeemCode(f.c,intent.intentId,deps),new RegExp(mode==='pending'||mode==='uncertain'?'connection_has_unfinished_tasks':mode==='native'?'connection_native_work_outstanding':mode==='artifact'?'connection_storage_requires_check':mode==='foreign_source'?'source_session_mismatch':'pairing_target_unavailable'));
 for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(path.join(f.c.installRoot,files[i])),before[i]);
 const s=await readPairState(f.c);assert.equal(s.invitations.find(i=>i.invitationId===f.code.invitationId)!.state,'available');assert.equal(s.activations.length,1);assert.equal(await optional(path.join(f.c.installRoot,'connection-transition.json')),undefined);
});

for(const step of ['claimed','replacement_guarded','replacement_stopped','replacement_routes_cleared','replacement_record_disconnected','replacement_detached','connection_written','bound','routes_written','active_written','connection_paired'])test('replacement recovers the same activation after crash at '+step,async t=>{
 const f=await replacement(t);await assert.rejects(redeemCode(f.c,f.redeem.intentId,{...f.deps,afterStep:async(s:any)=>{if(s===step)throw Error('injected_crash');}}),/injected_crash/);
 const a=(await readPairState(f.c)).activations.find(x=>x.redeemIntentId===f.redeem.intentId)!;assert.ok(a);f.clock.value+=7200000;
 const next=await recoverPairing(f.c,a.activationId,f.deps);assert.equal(next.phase,'paired');assert.equal(next.connectionId,a.connectionId);assert.equal((await readConnection(f.c,f.old.connectionId)).phase,'disconnected');assert.equal((await readPairState(f.c)).activations.length,2);assert.equal(await optional(path.join(f.c.installRoot,'connection-transition.json')),undefined);assert.equal(f.sent.length,0);
});

test('replacement guard rejects direct submissions and rechecks idle after service stops',async t=>{
 const f=await replacement(t);let guarded=false;
 await assert.rejects(redeemCode(f.c,f.redeem.intentId,{...f.deps,afterStep:async(s:any)=>{
  if(s==='replacement_guarded'){const response=await requestBus(f.oldState,{requestId:randomUUID(),op:'accept',payload:{messageId:randomUUID(),kind:'task',from:'codex',to:'claude',targetSessionId:f.old.claude.sessionId,body:'race'}});assert.equal(response.ok,false);assert.equal(response.errorCode,'connection_switch_requires_check');guarded=true;}
  if(s==='replacement_stopped')await new FileMessageStore(f.oldState,realClock).putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.old.claude.sessionId,body:'inflight write'},realClock));
 }}),/connection_has_unfinished_tasks/);
 assert.equal(guarded,true);assert.equal((await activeConnection(f.c,true)).connectionId,f.old.connectionId);assert.equal((await readConnection(f.c,f.old.connectionId)).phase,'paired');assert.ok(await optional(path.join(f.c.installRoot,'connection-transition.json')));
});

test('unconfirmed shutdown preserves old routes and durable replacement guard',async t=>{
 const f=await replacement(t),routes=await readFile(path.join(f.c.installRoot,'routes.json'));
 await assert.rejects(redeemCode(f.c,f.redeem.intentId,{...f.deps,shutdown:async()=>({status:'needs_check'})}),/service_shutdown_unconfirmed/);
 assert.deepEqual(await readFile(path.join(f.c.installRoot,'routes.json')),routes);assert.equal((await readConnection(f.c,f.old.connectionId)).phase,'paired');assert.ok(await optional(path.join(f.c.installRoot,'connection-transition.json')));
});

test('live polling treats the replacement guard as a pause and can recover after guarded interruption',async t=>{
 const f=await replacement(t,'codex',10);
 try{
 await assert.rejects(redeemCode(f.c,f.redeem.intentId,{...f.deps,afterStep:async(s:any)=>{if(s==='replacement_guarded'){await new Promise(r=>setTimeout(r,80));throw Error('injected_crash');}}}),/injected_crash/);
 const a=(await readPairState(f.c)).activations.find(x=>x.redeemIntentId===f.redeem.intentId)!;
 const result=await recoverPairing(f.c,a.activationId,f.deps);assert.equal(result.phase,'paired');assert.equal(await optional(path.join(f.c.installRoot,'connection-transition.json')),undefined);
 }finally{for(const main of f.services.values())await main.close();}
});
