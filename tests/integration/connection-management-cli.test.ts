import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {runLabus} from '../../src/labus.ts';

async function fixture(t:any){
 const f=await pairingFixture(t),first=await redeemCode(f.c,f.redeemer.intentId,f.deps),peer={...f.peers[1],sessionId:randomUUID(),title:'Saved target'};f.peers.push(peer);
 const second={...first,connectionId:randomUUID(),phase:'disconnected',claude:peer,pairing:{activationId:randomUUID(),identity:'confirmed'}};const dir=path.join(f.c.installRoot,'connections',second.connectionId);await mkdir(path.join(dir,'state'),{recursive:true});await writeFile(path.join(dir,'connection.json'),JSON.stringify(second));await writeFile(path.join(dir,'state','bindings.json'),JSON.stringify({schemaVersion:1,bindings:['codex','claude'].map(p=>({agentId:p,kind:p,sessionId:(second as any)[p].sessionId,workspaceRoot:(second as any)[p].workspaceRoot}))}));
 const deps={context:f.c,env:{CODEX_THREAD_ID:f.peers[0].sessionId},connectionDeps:{...f.deps,shutdown:async(h:any)=>{await f.services.get(h.stateRoot)?.close();return {status:'closed'};}}};return {...f,first,second,cliDeps:deps};
}
async function command(f:any,args:string[],deps=f.cliDeps){let text='';const code=await runLabus(args,{stdout:{write(s:string){text+=s;}},stderr:{write(){}}},deps);return {code,result:JSON.parse(text)};}

test('CLI lists saved pairs for exact native caller and never substitutes discover candidates',async t=>{
 const f=await fixture(t),r=await command(f,['connect','list','--provider','codex']);assert.equal(r.code,0);assert.equal(r.result.data.connections.length,2);assert.equal(r.result.data.current.connectionId,f.first.connectionId);
 const missing=await command(f,['connect','list','--provider','codex'],{...f.cliDeps,env:{}});assert.equal(missing.result.errorCode,'source_session_missing');assert.notEqual(missing.code,0);
 const claude=await command(f,['connect','list','--provider','claude','--source-session',f.peers[1].sessionId],{...f.cliDeps,env:{}});assert.equal(claude.result.data.connections.length,1);
});

test('CLI requires reviewed operation before apply and preserves original identities on success',async t=>{
 const f=await fixture(t),args=['connect','switch','--provider','codex','--connection',f.second.connectionId];
 const missing=await command(f,[...args,'--apply']);assert.equal(missing.result.errorCode,'reviewed_operation_ids_required');
 const preview=await command(f,args);assert.equal(preview.code,0);assert.equal(preview.result.phase,'preview');assert.equal(preview.result.data.canApply,true);
 assert.equal(JSON.parse(await readFile(path.join(f.c.installRoot,'active-connection.json'),'utf8')).connectionId,f.first.connectionId);
 const done=await command(f,[...args,'--apply','--operation',preview.result.data.operationId]);assert.equal(done.code,0);assert.equal(done.result.phase,'paired');assert.equal(done.result.data.connectionId,f.second.connectionId);assert.equal(f.sent.length,0);
});

test('CLI reports stale switch with actionable explanation and never silently overwrites changes',async t=>{
 const f=await fixture(t),args=['connect','switch','--provider','codex','--connection',f.second.connectionId],p=await command(f,args);assert.equal(p.code,0);
 await writeFile(path.join(f.c.installRoot,'routes.json'),'{}');const r=await command(f,[...args,'--apply','--operation',p.result.data.operationId]);assert.notEqual(r.code,0);assert.equal(r.result.errorCode,'switch_preview_changed');assert.ok(r.result.summary);assert.match(r.result.nextAction,/new_switch_preview/);assert.equal(await readFile(path.join(f.c.installRoot,'routes.json'),'utf8'),'{}');
});

test('doctor CLI exposes independent checks and check-write leaves no probe artifacts',async t=>{
 const f=await fixture(t),r=await command(f,['doctor']);assert.equal(r.code,0);assert.ok(r.result.data.checks.length);assert.equal(r.result.data.paths.installRoot,f.c.installRoot);
 const before=await readdir(f.c.installRoot),write=await command(f,['doctor','--check-write']);assert.equal(write.code,0);assert.equal(write.result.data.checks.find((x:any)=>x.id==='write_access').status,'ok');assert.deepEqual(await readdir(f.c.installRoot),before);
});

test('new flags cannot leak into discovery, status, pairing or ordinary task commands',async t=>{
 const f=await fixture(t);for(const args of [['connect','list','--provider','codex','--apply'],['connect','discover','--provider','codex','--operation',randomUUID()],['status','--check-write'],['pair','status','--check-write'],['doctor','--provider','codex']]){const r=await command(f,args);assert.equal(r.code,2);assert.equal(r.result.errorCode,'unexpected_option');}
 const identity=await command(f,['pair','issue']);assert.equal(identity.result.errorCode,'pairing_identity_unconfirmed');assert.ok(identity.result.summary);
});
