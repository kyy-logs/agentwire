import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {normalizeHook} from '../../src/lifecycle/normalize.ts';
import {inspectConnectionWork} from '../../src/installation/connection-management.ts';

test('activation-turn Stop is retained and ignored only through the exact verified pair-control intent',async t=>{
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps),main=[...f.services.values()][0];
 const stop=normalizeHook('codex',{session_id:f.redeemer.source.sessionId,turn_id:f.redeemer.nativeInputId,hook_event_name:'Stop'})!;
 assert.deepEqual(await main.lifecycle.process(stop),{status:'ignored',reason:'verified_control_execution'});
 assert.deepEqual(await main.lifecycle.store.getEvent(stop.eventKey),stop);assert.equal(await main.lifecycle.store.isApplied(stop.eventKey),true);assert.equal((await inspectConnectionWork(f.c,r.connectionId)).artifactsPending,0);assert.equal(f.sent.length,0);
 const before=await readFile(f.file);await main.lifecycle.recover();assert.deepEqual(await readFile(f.file),before,'control recognition does not mutate/prune pairing ledger');
});

test('unknown, wrong-session, output-bearing or flagged Stop still defers instead of fabricating input',async t=>{
 for(const mode of ['unknown','wrong_session','output','background']){const f=await pairingFixture(t);await redeemCode(f.c,f.redeemer.intentId,f.deps);const main=[...f.services.values()][0];const stop=normalizeHook('codex',{session_id:mode==='wrong_session'?randomUUID():f.redeemer.source.sessionId,turn_id:mode==='unknown'?randomUUID():f.redeemer.nativeInputId,hook_event_name:'Stop',...(mode==='output'?{last_assistant_message:'must not be ignored'}:{}),...(mode==='background'?{background_tasks:[{}]}:{})})!;
 assert.equal((await main.lifecycle.process(stop)).status,'deferred',mode);assert.equal(await main.lifecycle.store.isApplied(stop.eventKey),false);assert.equal(await main.lifecycle.store.getExecution(stop),undefined);}
});

test('claimed but incomplete activation never certifies a control Stop',async t=>{
 const f=await pairingFixture(t);await assert.rejects(redeemCode(f.c,f.redeemer.intentId,{...f.deps,afterStep:async(step:any)=>{if(step==='bound')throw Error('fixture_interrupt');}}),/fixture_interrupt/);const main=[...f.services.values()][0];const stop=normalizeHook('codex',{session_id:f.redeemer.source.sessionId,turn_id:f.redeemer.nativeInputId,hook_event_name:'Stop'})!;assert.equal((await main.lifecycle.process(stop)).status,'deferred');assert.equal(await main.lifecycle.store.isApplied(stop.eventKey),false);
});

test('pair-control proof never swallows failure, interruption or an error-bearing Stop',async t=>{
 const f=await pairingFixture(t);await redeemCode(f.c,f.redeemer.intentId,f.deps);const main=[...f.services.values()][0];
 for(const hook_event_name of ['StopFailure','Interrupt','Stop']){
  const event={...normalizeHook('codex',{session_id:f.redeemer.source.sessionId,turn_id:f.redeemer.nativeInputId,hook_event_name})!,...(hook_event_name==='Stop'?{errorCode:'unexpected_error'}:{})};
  assert.equal((await main.lifecycle.process(event)).status,'deferred',hook_event_name);
  assert.equal(await main.lifecycle.store.isApplied(event.eventKey),false);
 }
});
