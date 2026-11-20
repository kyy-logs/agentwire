import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
const api:any=await import('../../src/pairing/jobs.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

test('automation defaults to manual without writing anything',async t=>{const f=await pairingFixture(t);assert.equal(typeof api.readAutomation,'function');assert.equal((await api.readAutomation(f.c)).enabled,false);});
test('only requests registered after opt-in are queued, duplicate is idempotent, disable generations do not revive jobs',async t=>{
 const f=await pairingFixture(t),old=await stageNativeCommand(f,f.peers[1],'生成连接码');assert.equal(typeof api.setAutomation,'function');
 f.clock.value+=10;await api.setAutomation(f.c,true,f.deps);await assert.rejects(api.enqueuePairJob(f.c,old,f.deps),/automation_request_not_eligible/);
 const id=await stageNativeCommand(f,f.peers[1],'生成连接码'),j=await api.enqueuePairJob(f.c,id,f.deps);assert.deepEqual(await api.enqueuePairJob(f.c,id,f.deps),j);assert.equal((await api.listPairJobs(f.c)).length,1);
 await api.setAutomation(f.c,false,f.deps);await api.setAutomation(f.c,true,f.deps);assert.equal(await api.jobAuthorized(f.c,j),false);
});
test('bad IDs and corrupt job state fail closed',async t=>{
 const f=await pairingFixture(t);assert.equal(typeof api.readPairJob,'function');await assert.rejects(api.readPairJob(f.c,'../other'));
 await api.setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await api.enqueuePairJob(f.c,id,f.deps);await writeFile(path.join(f.c.installRoot,'pairing','jobs',id+'.json'),'{}');await assert.rejects(api.readPairJob(f.c,id),/pairing_job_invalid/);
});
test('pending limit is bounded at 32 while terminal history does not consume pending slots',async t=>{
 const f=await pairingFixture(t);assert.equal(typeof api.enqueuePairJob,'function');await api.setAutomation(f.c,true,f.deps);
 for(let i=0;i<32;i++){const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await api.enqueuePairJob(f.c,id,f.deps);}
 const next=await stageNativeCommand(f,f.peers[1],'生成连接码');await assert.rejects(api.enqueuePairJob(f.c,next,f.deps),/pairing_job_limit/);
});
test('24 hour pruning removes settled jobs but preserves uncertain recovery',async t=>{
 const f=await pairingFixture(t);await api.setAutomation(f.c,true,f.deps);const a=await stageNativeCommand(f,f.peers[1],'生成连接码'),b=await stageNativeCommand(f,f.peers[0],'生成连接码');let settled=await api.enqueuePairJob(f.c,a,f.deps),uncertain=await api.enqueuePairJob(f.c,b,f.deps);
 await api.updatePairJob(f.c,{...settled,phase:'failed'});await api.updatePairJob(f.c,{...uncertain,phase:'needs_check'});f.clock.value+=86400001;assert.equal(typeof api.prunePairJobs,'function');await api.prunePairJobs(f.c,f.deps);assert.equal(await api.readPairJob(f.c,a),undefined);assert.equal((await api.readPairJob(f.c,b)).phase,'needs_check');
});


async function expiredNotification(t:any){const f=await pairingFixture(t);await api.setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码'),j=await api.enqueuePairJob(f.c,id,f.deps);f.clock.value=Date.parse(j.expiresAt)+1;await api.updatePairJob(f.c,{...j,phase:'failed',errorCode:'pairing_intent_expired',result:{ok:false,errorCode:'pairing_intent_expired'}});return {...f,id};}
test('expired never-dispatched notification can be suppressed without changing its failed result or pruning evidence',async t=>{
 const f=await expiredNotification(t),before=await api.readPairJob(f.c,f.id);assert.equal(typeof api.suppressExpiredPairNotification,'function');const j=await api.suppressExpiredPairNotification(f.c,f.id,f.deps);assert.equal(j.notification.phase,'suppressed');assert.equal(j.notification.errorCode,'expired_by_user');assert.deepEqual(j.result,before.result);assert.equal(j.phase,'failed');assert.deepEqual(await api.suppressExpiredPairNotification(f.c,f.id,f.deps),j);
 const {notifyPairJob}=await import('../../src/pairing/notifications.ts');const transport={send:async()=>{throw Error('must_not_send');},inspect:async()=>{throw Error('must_not_inspect');}};assert.deepEqual(await notifyPairJob(f.c,f.id,{transport} as any),j);f.clock.value+=86400001;await api.prunePairJobs(f.c,f.deps);assert.deepEqual(await api.readPairJob(f.c,f.id),j);
});
for(const mode of ['not_expired','already_attempted','succeeded','has_identity'])test('expired-notification suppression refuses '+mode,async t=>{
 const f=await expiredNotification(t);let j=await api.readPairJob(f.c,f.id);if(mode==='not_expired')f.clock.value=Date.parse(j.expiresAt)-1;if(mode==='already_attempted')j=await api.updatePairJob(f.c,{...j,notification:{phase:'attempted',transportId:randomUUID()}});if(mode==='succeeded')j=await api.updatePairJob(f.c,{...j,phase:'succeeded',result:{ok:true}});if(mode==='has_identity')j=await api.updatePairJob(f.c,{...j,intentId:randomUUID()});
 const before=await readFile(path.join(f.c.installRoot,'pairing/jobs',f.id+'.json'));assert.equal(typeof api.suppressExpiredPairNotification,'function');await assert.rejects(api.suppressExpiredPairNotification(f.c,f.id,f.deps),/notification_suppression_requires_check/);assert.deepEqual(await readFile(path.join(f.c.installRoot,'pairing/jobs',f.id+'.json')),before);
});
