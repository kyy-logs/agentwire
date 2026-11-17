import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
import {runPairCommand} from '../../src/pairing/cli.ts';
import {runLabus} from '../../src/labus.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {inspectPairHealth} from '../../src/pairing/health.ts';
import {askPeer} from '../../src/installation/connections.ts';
import {parsePairCommand} from '../../src/pairing/capture.ts';

async function command(f:any,args:string[],outer=false){let text='';const io={stdout:{write(s:string){text+=s;}},stderr:{write(){}}};const code=outer?await runLabus(['pair',...args],io,{context:f.c,env:{},connectionDeps:f.deps}):await runPairCommand(f.c,args,io,f.deps);return {code,data:JSON.parse(text)};}
test('pair CLI refuses arbitrary identities and only consumes an exact staged native request',async t=>{
 const f=await pairingFixture(t),before=await readFile(f.file);for(const args of [['issue','--source-session',f.peers[1].sessionId],['redeem','--code',f.invitation.code],['issue','--intent',randomUUID()],['issue']]){const r=await command(f,args);assert.notEqual(r.code,0);assert.equal(r.data.ok,false);}assert.deepEqual(await readFile(f.file),before);
 const ticket=await stageNativeCommand(f,f.peers[1],'生成连接码');assert.ok(ticket);const r=await command(f,['issue','--intent',ticket],true);assert.equal(r.code,0);assert.match(r.data.data.code,/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);assert.equal(r.data.phase,'code_issued');assert.equal(f.sent.length,0);
});

test('issued code includes the exact redeem prompt targeting its issuer in the other chat',async t=>{
 for(const issuerIndex of [0,1]){const f=await pairingFixture(t),issuer=f.peers[issuerIndex],ticket=await stageNativeCommand(f,issuer,'生成连接码'),r=await command(f,['issue','--intent',ticket!]);assert.equal(r.code,0);assert.equal(r.data.data.redeemIn,issuer.provider==='codex'?'claude':'codex');assert.deepEqual(parsePairCommand(r.data.data.redeemPrompt),{kind:'redeem',target:issuer.provider,code:r.data.data.code});assert.equal(f.sent.length,0);}
});

test('issue and redeem CLI work in both directions without a supplied source session',async t=>{
 for(const reverse of [false,true]){const f=await pairingFixture(t),issuer=f.peers[reverse?0:1],redeemer=f.peers[reverse?1:0],ticket=await stageNativeCommand(f,issuer,'生成连接码'),issue=await command(f,['issue','--intent',ticket!]);assert.equal(issue.code,0);
 const redeem=await stageNativeCommand(f,redeemer,`连接 ${issuer.provider==='claude'?'Claude':'Codex'}，连接码 ${issue.data.data.code}`),result=await command(f,['redeem','--intent',redeem!],true);assert.equal(result.code,0);assert.equal(result.data.phase,'paired');assert.equal(result.data.data.health.identity,'confirmed');assert.equal(result.data.data.health.roundtrip.codex_to_claude.status,'untested');assert.equal(f.sent.length,0);
 const status=await command(f,['status']);assert.equal(status.code,0);assert.equal(JSON.stringify(status.data).includes(issue.data.data.code),false);assert.equal(status.data.data.health.endpoint.codex,'unknown');assert.equal(status.data.data.health.endpoint.claude,'detected');}
});

test('paired state admits the first explicit task but unfinished or uncertain activation does not',async t=>{
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps),task=await askPeer(f.c,f.peers[0],'claude','first explicit task',randomUUID(),f.deps);assert.equal(task.message.targetSessionId,f.peers[1].sessionId);
 const file=path.join(f.c.installRoot,'connections',r.connectionId,'connection.json'),changed=JSON.parse(await readFile(file,'utf8'));changed.phase='pairing';await writeFile(file,JSON.stringify(changed));await assert.rejects(()=>askPeer(f.c,f.peers[0],'claude','must not send',randomUUID(),f.deps),/connection_not_ready/);
 changed.phase='needs_check';await writeFile(file,JSON.stringify(changed));await assert.rejects(()=>askPeer(f.c,f.peers[0],'claude','must not send',randomUUID(),f.deps),/connection_not_ready/);
});

test('endpoint-only health never implies a round trip and status has no message side effects',async t=>{
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps),health=await inspectPairHealth(f.c,r as any,f.deps);assert.equal(health.identity,'confirmed');assert.equal(health.roundtrip.codex_to_claude.status,'untested');assert.equal(health.roundtrip.claude_to_codex.status,'untested');
 const status=await command(f,['status'],true);assert.equal(status.data.data.health.roundtrip.codex_to_claude.status,'untested');assert.equal(f.sent.length,0);for(const main of f.services.values())assert.equal((await main.bus.store.list()).length,0);
});

test('generic status and doctor expose paired facts even when no native roundtrip exists',async t=>{
 const f=await pairingFixture(t);await redeemCode(f.c,f.redeemer.intentId,f.deps);for(const operation of ['status','doctor']){let output='';await runLabus([operation],{stdout:{write(s:string){output+=s;}},stderr:{write(){}}},{context:f.c,env:{},connectionDeps:f.deps});const data=JSON.parse(output);assert.equal(data.data.pairHealth.identity,'confirmed');assert.equal(data.data.pairHealth.roundtrip.codex_to_claude.status,'untested');if(operation==='doctor'){assert.equal(data.data.installation.codex.hookFile,'missing');assert.equal(data.data.installation.claude.currentChatObservation,'unverified');}}assert.equal(f.sent.length,0);
});
