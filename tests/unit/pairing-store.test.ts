import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile,readdir,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {acquireLock} from '../../src/installation/paths.ts';
import {capturePairIntent,issueCode,claimCode,completeActivation,readPairActivation,withPairState} from '../../src/pairing/store.ts';
import type {PairIntent} from '../../src/pairing/model.ts';

const start=Date.parse('2026-11-17T10:00:00Z');
async function fixture(t:any){
 const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'install'),nodeExe:process.execPath,sourceRoot:root};
 const clock={value:start,now(){return new Date(this.value);}};
 const make=(provider:'codex'|'claude',command:any={kind:'issue'},sessionId=randomUUID()):PairIntent=>{
  const nativeInputId=randomUUID();return {intentId:randomUUID(),source:{provider,sessionId,workspaceRoot:root,availability:'candidate'},nativeInputId,command,capturedAt:new Date(clock.value).toISOString(),expiresAt:new Date(clock.value+120000).toISOString(),proofRef:path.join(c.home,provider==='codex'?'.codex':'.claude',provider==='codex'?'sessions':'projects',sessionId+'.jsonl')+'#'+nativeInputId};
 };
 const deps={now:()=>clock.now()},save=(i:PairIntent)=>capturePairIntent(c,i,deps),file=path.join(c.installRoot,'pairing','state.json');
 const issue=async(provider:'codex'|'claude'='claude',sessionId?:string)=>{const i=make(provider,{kind:'issue'},sessionId);await save(i);return {i,r:await issueCode(c,i.intentId,deps)};};
 const redeem=async(code:string,provider:'codex'|'claude'='codex',target:'codex'|'claude'='claude')=>{const i=make(provider,{kind:'redeem',target,code});await save(i);return i;};
 return {root,c,clock,make,deps,save,file,issue,redeem};
}

test('issue uses 8 Crockford characters and the same intent keeps its code after intent expiry',async t=>{
 const f=await fixture(t),{i,r}=await f.issue();assert.match(r.code,/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);assert.equal(Date.parse(r.expiresAt),start+3600000);assert.deepEqual(r.issuer,i.source);
 f.clock.value+=120000;assert.deepEqual(await issueCode(f.c,i.intentId,f.deps),r);
});

test('claim retry preserves its connection ID after both input and invitation expire',async t=>{
 const f=await fixture(t),{r}=await f.issue(),i=await f.redeem(r.code),a=await claimCode(f.c,i.intentId,f.deps);
 assert.equal(a.phase,'activating');assert.equal(a.codex.sessionId,i.source.sessionId);assert.equal(a.claude.sessionId,r.issuer.sessionId);
 f.clock.value+=3600001;assert.deepEqual(await claimCode(f.c,i.intentId,f.deps),a);await completeActivation(f.c,a.activationId,f.deps);assert.equal((await readPairActivation(f.c,a.activationId,f.deps)).phase,'paired');
});

test('only one concurrent redeemer wins and the loser cannot reuse the occupied code',async t=>{
 const f=await fixture(t),{r}=await f.issue(),a=await f.redeem(r.code),b=await f.redeem(r.code);const rs=await Promise.allSettled([claimCode(f.c,a.intentId,f.deps),claimCode(f.c,b.intentId,f.deps)]);
 assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);const loser=rs[0].status==='rejected'?a:b;await assert.rejects(()=>claimCode(f.c,loser.intentId,f.deps),/^Error: pairing_code_used$/);
 const state=JSON.parse(await readFile(f.file,'utf8'));assert.equal(state.activations.length,1);
});

test('new issue revokes only the same chat previous unclaimed invitation',async t=>{
 const f=await fixture(t),old=await f.issue(),other=await f.issue();const newer=await f.issue('claude',old.i.source.sessionId);assert.notEqual(newer.r.code,old.r.code);
 const i=await f.redeem(old.r.code);await assert.rejects(()=>claimCode(f.c,i.intentId,f.deps),/^Error: pairing_code_used$/);assert.deepEqual(await issueCode(f.c,old.i.intentId,f.deps),old.r);
 const j=await f.redeem(other.r.code);assert.equal((await claimCode(f.c,j.intentId,f.deps)).claude.sessionId,other.i.source.sessionId);
});

test('unprocessed intent expires at exactly 120000ms and rejects future timestamps',async t=>{
 const f=await fixture(t),a=f.make('claude');await f.save(a);f.clock.value=start+119999;assert.ok(await issueCode(f.c,a.intentId,f.deps));
 f.clock.value=start;const b=f.make('claude');await f.save(b);f.clock.value=start+120000;await assert.rejects(()=>issueCode(f.c,b.intentId,f.deps),/^Error: pairing_intent_expired$/);
 const future=f.make('claude');f.clock.value--;await assert.rejects(()=>f.save(future),/^Error: pairing_identity_unconfirmed$/);
});

test('invitation expiry boundary and wrong provider never mutate an existing connection',async t=>{
 const f=await fixture(t);await mkdir(f.c.installRoot,{recursive:true});const active=path.join(f.c.installRoot,'active-connection.json');await writeFile(active,'unchanged existing connection');const {r}=await f.issue();
 const wrong=await f.redeem(r.code,'claude','codex');await assert.rejects(()=>claimCode(f.c,wrong.intentId,f.deps),/^Error: pairing_provider_mismatch$/);
 f.clock.value=start+3599999;const edge=await f.redeem(r.code);assert.ok(await claimCode(f.c,edge.intentId,f.deps));
 const other=await f.issue();f.clock.value+=3600000;const expired=await f.redeem(other.r.code);await assert.rejects(()=>claimCode(f.c,expired.intentId,f.deps),/^Error: pairing_code_expired$/);assert.equal(await readFile(active,'utf8'),'unchanged existing connection');
});

test('a code remains redeemable after five minutes while stored legacy deadlines are preserved',async t=>{
 const f=await fixture(t),fresh=await f.issue();f.clock.value=start+300000;const current=await f.redeem(fresh.r.code);assert.ok(await claimCode(f.c,current.intentId,f.deps));
 const legacy=await f.issue();await withPairState(f.c,async tx=>{tx.state.invitations.find(i=>i.invitationId===legacy.r.invitationId)!.expiresAt=new Date(f.clock.value+300000).toISOString();await tx.commit();},f.deps);
 f.clock.value+=300000;const late=await f.redeem(legacy.r.code);await assert.rejects(()=>claimCode(f.c,late.intentId,f.deps),/^Error: pairing_code_expired$/);
 assert.equal(Date.parse((await issueCode(f.c,legacy.i.intentId,f.deps)).expiresAt),start+600000);
});

test('duplicate capture is idempotent and never permits changing its immutable source',async t=>{
 const f=await fixture(t),i=f.make('claude');await f.save(i);const before=await readFile(f.file);await f.save(structuredClone(i));assert.deepEqual(await readFile(f.file),before);
 await assert.rejects(()=>f.save({...i,source:{...i.source,sessionId:randomUUID()}}),/^Error: pairing_identity_unconfirmed$/);
 await assert.rejects(()=>issueCode(f.c,randomUUID(),f.deps),/^Error: pairing_identity_unconfirmed$/);
});

test('capture validates caller-independent schema before creating any state',async t=>{
 const f=await fixture(t),i=f.make('claude');for(const change of [{intentId:'bad'},{nativeInputId:'bad'},{proofRef:'bad'},{command:{kind:'redeem',target:'codex',code:'IIII-OOOO'}},{expiresAt:i.capturedAt}])await assert.rejects(()=>f.save({...i,...change} as any),/^Error: pairing_identity_unconfirmed$/);
 assert.deepEqual(await readdir(f.root),[]);
});

test('commits enforce combined 128 record limit and 256KiB byte limit atomically',async t=>{
 const f=await fixture(t),i=f.make('claude');await f.save(i);await withPairState(f.c,async tx=>{tx.state.intents=Array.from({length:128},()=>({...i,intentId:randomUUID(),nativeInputId:randomUUID()}));for(const item of tx.state.intents)item.proofRef=item.proofRef.split('#')[0]+'#'+item.nativeInputId;await tx.commit();},f.deps);
 const before=await readFile(f.file);await assert.rejects(()=>f.save(f.make('codex')),/^Error: pairing_store_limit$/);assert.deepEqual(await readFile(f.file),before);
 await assert.rejects(()=>withPairState(f.c,async tx=>{tx.state.intents[0].source.title='x'.repeat(262144);await tx.commit();},f.deps),/^Error: pairing_store_limit$/);assert.deepEqual(await readFile(f.file),before);
});

test('cleanup after 24 hours frees terminal records but retains unfinished activation families',async t=>{
 const f=await fixture(t),old=await f.issue(),ri=await f.redeem(old.r.code),a=await claimCode(f.c,ri.intentId,f.deps);const done=await f.issue(),di=await f.redeem(done.r.code),d=await claimCode(f.c,di.intentId,f.deps);await completeActivation(f.c,d.activationId,f.deps);
 f.clock.value+=86400000+3600001;const fresh=f.make('claude');await f.save(fresh);const state=JSON.parse(await readFile(f.file,'utf8'));assert.equal(state.activations.length,1);assert.equal(state.activations[0].activationId,a.activationId);assert.equal(state.invitations.length,1);assert.equal(state.invitations[0].invitationId,old.r.invitationId);assert.ok(state.intents.some((x:any)=>x.intentId===old.i.intentId));
});

test('invalid JSON, impossible reference and oversized stored files are preserved and rejected',async t=>{
 const f=await fixture(t);await mkdir(path.dirname(f.file),{recursive:true});for(const text of ['{broken',JSON.stringify({schemaVersion:1,intents:[],invitations:[],activations:[{}]}),'x'.repeat(262145)]){await writeFile(f.file,text);await assert.rejects(()=>issueCode(f.c,randomUUID(),f.deps),/^Error: pairing_store_(invalid|limit)$/);assert.equal(await readFile(f.file,'utf8'),text);}
});

test('live locks fail closed and malformed locks are preserved',async t=>{
 const f=await fixture(t),i=f.make('claude'),lock=path.join(f.c.installRoot,'connection.lock');const release=await acquireLock(lock);try{await assert.rejects(()=>f.save(i),/^Error: installation_busy$/);}finally{await release();}
 await writeFile(lock,'broken');await assert.rejects(()=>f.save(i),/^Error: lock_requires_check$/);assert.equal(await readFile(lock,'utf8'),'broken');
});

test('dead owner lock recovers and path junctions never redirect pairing writes',async t=>{
 const f=await fixture(t),i=f.make('claude'),lock=path.join(f.c.installRoot,'connection.lock');await mkdir(f.c.installRoot,{recursive:true});await writeFile(lock,JSON.stringify({ownerPid:2147483647,lockId:randomUUID()}));await f.save(i);assert.ok(await issueCode(f.c,i.intentId,f.deps));
 const g=await fixture(t),outside=path.join(g.root,'outside');await mkdir(outside);await mkdir(g.c.installRoot);await symlink(outside,path.join(g.c.installRoot,'pairing'),process.platform==='win32'?'junction':'dir');await assert.rejects(()=>g.save(g.make('claude')),/symlink_not_allowed/);assert.deepEqual(await readdir(outside),[]);
});

test('malformed invitation entries and impossible terminal phases fail with stable errors',async t=>{
 const f=await fixture(t),{r}=await f.issue(),i=await f.redeem(r.code),a=await claimCode(f.c,i.intentId,f.deps),original=JSON.parse(await readFile(f.file,'utf8'));
 const variants=[];const nil=structuredClone(original);nil.invitations=[null];variants.push(nil);
 const early=structuredClone(original);early.activations[0].terminalAt=new Date(start).toISOString();early.invitations[0].terminalAt=new Date(start).toISOString();variants.push(early);
 const mismatch=structuredClone(original);mismatch.activations[0].phase='paired';mismatch.activations[0].terminalAt=new Date(start).toISOString();variants.push(mismatch);
 for(const state of variants){const bytes=JSON.stringify(state);await writeFile(f.file,bytes);await assert.rejects(()=>readPairActivation(f.c,a.activationId,f.deps),/^Error: pairing_store_invalid$/);assert.equal(await readFile(f.file,'utf8'),bytes);}
});

test('reverse provider issue and needs_check remain exact and never recover as success automatically',async t=>{
 const f=await fixture(t),{r}=await f.issue('codex'),i=await f.redeem(r.code,'claude','codex'),a=await claimCode(f.c,i.intentId,f.deps);
 assert.deepEqual(a.codex,r.issuer);assert.deepEqual(a.claude,i.source);
 await withPairState(f.c,async tx=>{const item=tx.state.activations[0];item.phase='needs_check';item.errorCode='pairing_activation_requires_check';await tx.commit();},f.deps);
 f.clock.value+=172800000;await f.save(f.make('claude'));assert.equal((await readPairActivation(f.c,a.activationId,f.deps)).phase,'needs_check');await assert.rejects(()=>completeActivation(f.c,a.activationId,f.deps),/^Error: pairing_activation_requires_check$/);
 assert.equal((await claimCode(f.c,i.intentId,f.deps)).connectionId,a.connectionId);
});
