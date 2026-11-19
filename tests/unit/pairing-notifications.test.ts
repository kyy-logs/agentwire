import test from 'node:test';import assert from 'node:assert/strict';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
import {setAutomation,enqueuePairJob,readPairJob,prunePairJobs} from '../../src/pairing/jobs.ts';
import {readPairState} from '../../src/pairing/store.ts';
import {runPairWorker} from '../../src/pairing/worker.ts';
const api:any=await import('../../src/pairing/notifications.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('notification checkpoints before write, pins exact source, and unknown is never resent',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[0],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);let sends=0,mapped=false,captured:any;
 const transport={checkpoint:async()=>({empty:true}),send:async(i:any,body:string)=>{sends++;captured={i,body,job:await readPairJob(f.c,id)};return {status:'unknown',errorCode:'write_without_delivery_evidence'};},inspect:async()=>mapped?{status:'delivered',evidenceRef:'fixture:exact'}:{status:'missing'}};
 assert.equal(typeof api.notifyPairJob,'function');await api.notifyPairJob(f.c,id,{...f.deps,transport});await api.notifyPairJob(f.c,id,{...f.deps,transport});assert.equal(sends,1);assert.equal(captured.job.notification.phase,'attempted');assert.equal(captured.job.notification.transportId,captured.i.transportId);assert.equal(captured.i.targetSessionId,f.peers[0].sessionId);assert.equal(captured.body,captured.job.notification.body);assert.ok(captured.body.includes(captured.job.result.data.code));assert.ok(!captured.body.includes(id));assert.equal((await readPairJob(f.c,id))!.phase,'succeeded');assert.equal((await readPairJob(f.c,id))!.notification.phase,'needs_check');mapped=true;await api.reconcilePairNotification(f.c,id,{...f.deps,transport});assert.equal((await readPairJob(f.c,id))!.notification.phase,'delivered');assert.equal((await readPairJob(f.c,id))!.notification.errorCode,undefined);assert.equal((await readPairJob(f.c,id))!.notification.intent.phase,'delivered');
});
test('expired code notification omits the code and unproved input is never notified',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);f.clock.value+=3600001;let sends=0,body='';
 const transport={send:async(_i:any,text:string)=>{sends++;body=text;return {status:'unknown'};},inspect:async()=>({status:'missing'})};
 assert.equal(typeof api.notifyPairJob,'function');await api.notifyPairJob(f.c,id,{...f.deps,transport});assert.equal(sends,1);assert.ok(body.includes('已过期'));assert.ok(!body.includes((await readPairJob(f.c,id))!.result.data.code));
 const other=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,other,f.deps);await api.notifyPairJob(f.c,other,{...f.deps,transport});assert.equal(sends,1);
});
test('an invitation revoked by another input is never announced as a usable code',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const a=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,a,f.deps);await runPairWorker(f.c,f.deps);const b=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,b,f.deps);await runPairWorker(f.c,f.deps);
 const code=(await readPairJob(f.c,a))!.result.data.code;let body='';await api.notifyPairJob(f.c,a,{...f.deps,transport:{send:async(_i:any,text:string)=>{body=text;return {status:'unknown'};},inspect:async()=>({status:'missing'})}});assert.ok(!body.includes(code));assert.ok(body.includes('已失效'));
});
test('late native notification evidence remains reconcilable after core retention pruning',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);let delivered=false,sends=0;const transport={send:async()=>{sends++;return {status:'unknown'};},inspect:async()=>delivered?{status:'delivered',evidenceRef:'fixture:late'}:{status:'missing'}};
 await api.notifyPairJob(f.c,id,{...f.deps,transport});const intentId=(await readPairJob(f.c,id))!.intentId;f.clock.value+=26*3600000;await stageNativeCommand(f,f.peers[0],'生成连接码');await prunePairJobs(f.c,f.deps);assert.ok(!(await readPairState(f.c)).intents.some(i=>i.intentId===intentId));delivered=true;
 await api.reconcilePairNotification(f.c,id,{...f.deps,transport});assert.equal((await readPairJob(f.c,id))!.notification.phase,'delivered');assert.equal(sends,1);
});

test('result normalizes legacy delivered receipt without writing or trusting a bare delivered flag',async t=>{
 const {readFile}=await import('node:fs/promises');const path=await import('node:path');const {updatePairJob}=await import('../../src/pairing/jobs.ts');const {runPairCommand}=await import('../../src/pairing/cli.ts');
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);
 const transport={send:async()=>({status:'unknown',errorCode:'write_without_delivery_evidence'}),inspect:async()=>({status:'missing'})};await api.notifyPairJob(f.c,id,{...f.deps,transport});
 for(const proof of [false,true]){const j=(await readPairJob(f.c,id))!;await updatePairJob(f.c,{...j,notification:{...j.notification,phase:'delivered',evidenceRef:proof?'fixture:delivered':undefined}});const file=path.join(f.c.installRoot,'pairing/jobs',id+'.json'),before=await readFile(file);let out='';assert.equal(await runPairCommand(f.c,['result','--request',id],{stdout:{write:s=>out+=s}},f.deps),0);const view=JSON.parse(out).data.job.notification;
 if(proof){assert.equal(view.errorCode,undefined);assert.equal(view.intent.phase,'delivered');assert.equal(view.intent.evidenceRef,'fixture:delivered');}else{assert.equal(view.errorCode,'write_without_delivery_evidence');assert.equal(view.intent.phase,'write_started');}
 assert.deepEqual(await readFile(file),before);
 }
});