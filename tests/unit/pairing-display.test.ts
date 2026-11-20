import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
import {setAutomation,enqueuePairJob,readPairJob,updatePairJob} from '../../src/pairing/jobs.ts';
import {runPairWorker} from '../../src/pairing/worker.ts';
import {runPairCommand} from '../../src/pairing/cli.ts';
import {notifyPairJob} from '../../src/pairing/notifications.ts';

async function submit(f:any,prompt:string){const id=await stageNativeCommand(f,f.peers[0],prompt);await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);return id;}
async function query(f:any,id:string){let out='';assert.equal(await runPairCommand(f.c,['result','--request',id],{stdout:{write:s=>out+=s}},f.deps),0);return JSON.parse(out);}
const uncertain={send:async()=>({status:'unknown',errorCode:'write_without_delivery_evidence'}),inspect:async()=>({status:'missing' as const})};

test('successful pairing with uncertain notification stays successful and discourages redemption replay',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await submit(f,`连接 Claude，连接码 ${f.invitation.code}`);await notifyPairJob(f.c,id,{...f.deps,transport:uncertain});
 const file=path.join(f.c.installRoot,'pairing/jobs',id+'.json'),before=await readFile(file),r=await query(f,id);
 assert.equal(r.phase,'succeeded');assert.equal(r.data.job.notification.phase,'needs_check');assert.equal(r.display.operation.status,'succeeded');assert.match(r.display.operation.summary,/配对已保存/);assert.match(r.display.operation.nextStep,/无需.*配对/);assert.match(r.display.notification.summary,/通知.*待核对/);assert.deepEqual(await readFile(file),before);assert.equal(f.sent.length,0);
});

test('used code only reports original pairing intact when exact active pair is still saved',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const prompt=`连接 Claude，连接码 ${f.invitation.code}`;await submit(f,prompt);const id=await submit(f,prompt);let body='';await notifyPairJob(f.c,id,{...f.deps,transport:{...uncertain,send:async(_i:any,text:string)=>{body=text;return {status:'unknown'};}}});
 const r=await query(f,id);assert.equal(r.data.job.result.errorCode,'pairing_code_used');assert.equal(r.display.operation.status,'rejected');assert.match(r.display.operation.summary,/原配对仍有效/);assert.match(body,/原配对仍有效/);assert.match(body,/pairing_code_used/);assert.equal(f.sent.length,0);
 const {unlink}=await import('node:fs/promises');await unlink(path.join(f.c.installRoot,'active-connection.json'));
 const missing=await query(f,id);assert.doesNotMatch(missing.display.operation.summary,/原配对仍有效/);assert.match(missing.display.operation.nextStep,/查询.*配对/);
});

test('delivery alone does not turn a failed operation into successful pairing',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await submit(f,'生成连接码'),j=(await readPairJob(f.c,id))!;
 await updatePairJob(f.c,{...j,phase:'needs_check',errorCode:'connection_storage_requires_check',result:{ok:false,errorCode:'connection_storage_requires_check'},notification:{phase:'delivered',evidenceRef:'fixture:exact'}});
 const r=await query(f,id);assert.equal(r.display.operation.status,'needs_check');assert.match(r.display.operation.summary,/待核对/);assert.match(r.display.operation.nextStep,/保留.*不.*重试/);assert.equal(r.display.notification.status,'delivered');assert.doesNotMatch(r.display.operation.summary,/配对已保存/);
});

test('a bare delivered flag is not displayed as proven notification delivery',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await submit(f,'生成连接码'),j=(await readPairJob(f.c,id))!;await updatePairJob(f.c,{...j,notification:{phase:'delivered'}});
 assert.equal((await query(f,id)).display.notification.status,'needs_check');
});

test('expired issued code gives renewal guidance without rewriting the successful issue result',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await submit(f,'生成连接码');f.clock.value+=3600001;
 const r=await query(f,id);assert.equal(r.phase,'succeeded');assert.match(r.display.operation.summary,/已过期/);assert.match(r.display.operation.nextStep,/重新生成连接码/);assert.equal((await readPairJob(f.c,id))!.phase,'succeeded');
});

test('using someone elses claimed code never reports their active pairing as this callers intact pairing',async t=>{
 const {randomUUID}=await import('node:crypto');const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const prompt=`连接 Claude，连接码 ${f.invitation.code}`;await submit(f,prompt);f.peers[0]={...f.peers[0],sessionId:randomUUID()};const id=await submit(f,prompt),r=await query(f,id);
 assert.equal(r.data.job.result.errorCode,'pairing_code_used');assert.doesNotMatch(r.display.operation.summary,/原配对仍有效/);
});

test('disabled automatic request is displayed as disabled without suggesting redemption retry',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[0],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await setAutomation(f.c,false,f.deps);await runPairWorker(f.c,f.deps);
 const r=await query(f,id);assert.equal(r.phase,'disabled');assert.equal(r.display.operation.status,'disabled');assert.match(r.display.operation.summary,/已停用/);assert.equal(f.sent.length,0);
});

test('a superseded issue result does not advertise its revoked code as usable',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await submit(f,'生成连接码');await submit(f,'生成连接码');const r=await query(f,id);
 assert.equal(r.phase,'succeeded');assert.match(r.display.operation.summary,/失效/);assert.match(r.display.operation.nextStep,/不要使用旧码/);
});
