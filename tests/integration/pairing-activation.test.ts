import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {discoverCandidates} from '../../src/installation/discovery.ts';
import {randomUUID} from 'node:crypto';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {activeConnection,selectConnection,beginProbes} from '../../src/installation/connections.ts';
import {claimCode,capturePairIntent,issueCode} from '../../src/pairing/store.ts';

test('paired activation binds exact chats and writes routes without any agent messages',async t=>{
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps);assert.equal(r.schemaVersion,2);assert.equal(r.phase,'paired');assert.deepEqual(r.codex,f.peers[0]);assert.deepEqual(r.claude,f.peers[1]);assert.equal('probeIds'in r,false);
 const routes=JSON.parse(await readFile(path.join(f.c.installRoot,'routes.json'),'utf8')).routes;assert.equal(routes.length,2);assert.ok(routes.every((x:any)=>x.connectionId===r.connectionId&&x.sessionId===r[x.provider].sessionId));
 assert.equal((await activeConnection(f.c)).connectionId,r.connectionId);assert.equal((await beginProbes(f.c,r.connectionId,f.deps)).phase,'paired');assert.equal(f.sent.length,0);
 for(const main of f.services.values()){await main.bus.tick();assert.equal((await main.bus.store.list()).length,0);assert.equal(main.bus.bindings.size,2);}assert.deepEqual(await redeemCode(f.c,f.redeemer.intentId,f.deps),r);
});

test('existing different pair is untouched and its rejection never consumes the invitation',async t=>{
 const f=await pairingFixture(t),other={...f.peers[1],sessionId:randomUUID()},old=await selectConnection(f.c,f.peers[0],other,{self:f.peers[0]});const files=['active-connection.json','routes.json',path.join('connections',old.connectionId,'connection.json')],before=await Promise.all(files.map(file=>readFile(path.join(f.c.installRoot,file))));
 await assert.rejects(()=>redeemCode(f.c,f.redeemer.intentId,f.deps),/^Error: active_connection_exists$/);for(let n=0;n<files.length;n++)assert.deepEqual(await readFile(path.join(f.c.installRoot,files[n])),before[n]);
 assert.equal(JSON.parse(await readFile(f.file,'utf8')).activations.length,0);assert.equal(f.services.size,0);assert.ok(await claimCode(f.c,f.redeemer.intentId,f.deps));
});

test('same legacy pair reuses its connection and never relaxes legacy probing admission',async t=>{
 const f=await pairingFixture(t),old=await selectConnection(f.c,f.peers[0],f.peers[1],{self:f.peers[0]}),before=await readFile(path.join(f.c.installRoot,'connections',old.connectionId,'connection.json'));
 const r=await redeemCode(f.c,f.redeemer.intentId,f.deps);assert.equal(r.schemaVersion,1);assert.equal(r.connectionId,old.connectionId);assert.deepEqual(await readFile(path.join(f.c.installRoot,'connections',old.connectionId,'connection.json')),before);assert.equal(f.services.size,0);assert.equal(f.sent.length,0);
 const state=JSON.parse(await readFile(f.file,'utf8'));assert.equal(state.activations[0].connectionId,old.connectionId);assert.equal(state.activations[0].phase,'paired');
});

test('missing or ambiguous exact target fails before consuming a code or starting service',async t=>{
 for(const mode of ['offline','ambiguous']){const f=await pairingFixture(t),discover=async(_c:any,provider:string)=>provider==='claude'?(mode==='offline'?[]:[f.peers[1],f.peers[1]]):[f.peers[0]];
 await assert.rejects(()=>redeemCode(f.c,f.redeemer.intentId,{...f.deps,discover}),/^Error: pairing_target_unavailable$/);assert.equal(JSON.parse(await readFile(f.file,'utf8')).activations.length,0);assert.equal(f.services.size,0);assert.ok(!(await readdir(f.c.installRoot)).includes('active-connection.json'));}
});

test('another code for the already paired chats reuses the original activation record unchanged',async t=>{
 const f=await pairingFixture(t),old=await redeemCode(f.c,f.redeemer.intentId,f.deps),file=path.join(f.c.installRoot,'connections',old.connectionId,'connection.json'),before=await readFile(file);
 const issuer=f.make(f.peers[1],{kind:'issue'});await capturePairIntent(f.c,issuer,f.deps);const code=await issueCode(f.c,issuer.intentId,f.deps),intent=f.make(f.peers[0],{kind:'redeem',target:'claude',code:code.code});await capturePairIntent(f.c,intent,f.deps);
 const r=await redeemCode(f.c,intent.intentId,f.deps);assert.deepEqual(r,old);assert.deepEqual(await readFile(file),before);assert.equal(f.services.size,1);assert.equal(f.sent.length,0);
});

test('exact native identity outside the twenty displayed Codex candidates can pair',async t=>{
 const f=await pairingFixture(t);await mkdir(path.join(f.c.home,'.codex'),{recursive:true});const rows=[{id:f.peers[0].sessionId,cwd:f.peers[0].workspaceRoot,updated_at:'2026-01-01'},...Array.from({length:20},()=>({id:randomUUID(),cwd:f.root,updated_at:'2026-11-17'}))];await writeFile(path.join(f.c.home,'.codex','session_index.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 assert.equal((await discoverCandidates(f.c,'codex')).some(x=>x.sessionId===f.peers[0].sessionId),false);const deps={...f.deps,discover:async(c:any,p:any,id?:string)=>p==='codex'?discoverCandidates(c,p,id):f.peers.filter(x=>x.provider==='claude')};
 assert.equal((await redeemCode(f.c,f.redeemer.intentId,deps)).phase,'paired');assert.equal(f.sent.length,0);
});
