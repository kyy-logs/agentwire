import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode,recoverPairing} from '../../src/pairing/service.ts';
import {selectConnection,disconnect} from '../../src/installation/connections.ts';
import {capturePairIntent,issueCode,claimCode} from '../../src/pairing/store.ts';

const steps=['claimed','connection_written','bound','routes_written','active_written','connection_paired'];
test('all write boundaries recover the same claimed connection after invitation expiry',async t=>{
 for(const step of steps)await t.test(step,async t=>{const f=await pairingFixture(t);await assert.rejects(()=>redeemCode(f.c,f.redeemer.intentId,{...f.deps,afterStep:async(s:string)=>{if(s===step)throw Error('injected_crash');}}),/injected_crash/);
 const state=JSON.parse(await readFile(f.file,'utf8')),a=state.activations[0];assert.equal(a.phase,'activating');assert.equal(state.invitations[0].state,'claimed');f.clock.value+=600000;
 const r=await recoverPairing(f.c,a.activationId,f.deps);assert.equal(r.phase,'paired');assert.equal(r.connectionId,a.connectionId);assert.deepEqual(await recoverPairing(f.c,a.activationId,f.deps),r);assert.equal(JSON.parse(await readFile(f.file,'utf8')).activations.length,1);assert.equal(f.sent.length,0);});
});

test('conflicting routes, active pointer and connection identity are preserved and pause recovery',async t=>{
 for(const kind of ['routes','active','connection'])await t.test(kind,async t=>{const f=await pairingFixture(t);await assert.rejects(()=>redeemCode(f.c,f.redeemer.intentId,{...f.deps,afterStep:async(s:string)=>{if(s==='connection_written')throw Error('injected_crash');}}),/injected_crash/);
 const a=JSON.parse(await readFile(f.file,'utf8')).activations[0];let file:string;
 if(kind==='routes'){file=path.join(f.c.installRoot,'routes.json');await writeFile(file,JSON.stringify({schemaVersion:1,routes:[{provider:'claude',sessionId:randomUUID(),connectionId:randomUUID()}]}));}
 else if(kind==='active'){const r=await selectConnection(f.c,f.peers[0],{...f.peers[1],sessionId:randomUUID()},{self:f.peers[0]});file=path.join(f.c.installRoot,'active-connection.json');assert.notEqual(r.connectionId,a.connectionId);}
 else{file=path.join(f.c.installRoot,'connections',a.connectionId,'connection.json');const r=JSON.parse(await readFile(file,'utf8'));r.claude.sessionId=randomUUID();await writeFile(file,JSON.stringify(r));}
 const before=await readFile(file);await assert.rejects(()=>recoverPairing(f.c,a.activationId,f.deps),/pairing_activation_requires_check/);assert.deepEqual(await readFile(file),before);assert.equal(JSON.parse(await readFile(f.file,'utf8')).activations[0].phase,'needs_check');assert.equal(f.sent.length,0);});
});

test('preexisting service bindings cannot be silently replaced even when no messages exist',async t=>{
 const f=await pairingFixture(t);await assert.rejects(()=>redeemCode(f.c,f.redeemer.intentId,{...f.deps,afterStep:async(s:string)=>{if(s==='bound')throw Error('injected_crash');}}),/injected_crash/);
 const a=JSON.parse(await readFile(f.file,'utf8')).activations[0],main=[...f.services.values()][0],foreign={agentId:'claude',kind:'claude',sessionId:randomUUID(),workspaceRoot:f.root};await main.bus.bind(foreign);
 await assert.rejects(()=>recoverPairing(f.c,a.activationId,f.deps),/pairing_activation_requires_check/);assert.deepEqual(main.bus.bindings.get('claude'),foreign);assert.equal(f.sent.length,0);
});

test('paired ledger retry never trusts a replaced connection activation identity',async t=>{
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps),file=path.join(f.c.installRoot,'connections',r.connectionId,'connection.json'),changed=JSON.parse(await readFile(file,'utf8'));changed.pairing.activationId=randomUUID();await writeFile(file,JSON.stringify(changed));const before=await readFile(file);
 await assert.rejects(()=>redeemCode(f.c,f.redeemer.intentId,f.deps),/pairing_activation_requires_check/);assert.deepEqual(await readFile(file),before);assert.equal(f.sent.length,0);
});

test('unfinished activation blocks another invitation and pending work still blocks disconnect',async t=>{
 const f=await pairingFixture(t);await assert.rejects(()=>redeemCode(f.c,f.redeemer.intentId,{...f.deps,afterStep:async(s:string)=>{if(s==='claimed')throw Error('injected_crash');}}),/injected_crash/);
 const issue=f.make(f.peers[1],{kind:'issue'});await capturePairIntent(f.c,issue,f.deps);const invitation=await issueCode(f.c,issue.intentId,f.deps),intent=f.make(f.peers[0],{kind:'redeem',target:'claude',code:invitation.code});await capturePairIntent(f.c,intent,f.deps);
 await assert.rejects(()=>redeemCode(f.c,intent.intentId,f.deps),/pairing_activation_requires_check/);assert.equal(JSON.parse(await readFile(f.file,'utf8')).activations.length,1);
 const a=JSON.parse(await readFile(f.file,'utf8')).activations[0],r=await recoverPairing(f.c,a.activationId,f.deps),main=[...f.services.values()][0];await main.bus.accept({messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'pending fixture'});await assert.rejects(()=>disconnect(f.c,r.connectionId),/unfinished_tasks/);
});
