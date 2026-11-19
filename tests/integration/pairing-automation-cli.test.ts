import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';import {readAutomation,enqueuePairJob,readPairJob} from '../../src/pairing/jobs.ts';import {runPairWorker} from '../../src/pairing/worker.ts';import {runLabus} from '../../src/labus.ts';
async function cmd(f:any,args:string[]){let output='';const exit=await runLabus(['pair',...args],{stdout:{write:s=>output+=s},stderr:{write(){}}},{context:f.c,env:{},connectionDeps:f.deps});return {exit,data:JSON.parse(output)};}
test('mode is explicit preview/apply and result is read-only with exact ID',async t=>{
 const f=await pairingFixture(t);assert.equal((await cmd(f,['mode','--mode','auto'])).data.phase,'preview');assert.equal((await readAutomation(f.c)).enabled,false);assert.equal((await cmd(f,['mode','--mode','auto','--apply'])).exit,0);
 const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);const before=await readFile(f.file),r=await cmd(f,['result','--request',id]);assert.equal(r.exit,0);assert.equal(r.data.data.job.phase,'succeeded');assert.deepEqual(await readFile(f.file),before);
 for(const args of [['result'],['result','--intent',id],['issue','--request',id],['status','--apply'],['mode','--mode','bad','--apply']])assert.notEqual((await cmd(f,args)).exit,0);
});
test('manual and automatic callers share a single managed result and invitation',async t=>{
 const f=await pairingFixture(t);await cmd(f,['mode','--mode','auto','--apply']);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);
 const manual=await cmd(f,['issue','--intent',id]);assert.equal(manual.exit,0);await runPairWorker(f.c,f.deps);assert.equal((await readPairJob(f.c,id))!.result.data.code,manual.data.data.code);assert.equal(JSON.parse(await readFile(f.file,'utf8')).invitations.length,2);
});
test('explicit recovery also reconciles exact result notification without executing again',async t=>{
 const f=await pairingFixture(t);await cmd(f,['mode','--mode','auto','--apply']);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);let sends=0;
 f.deps.notificationTransport={send:async()=>{sends++;return {status:'unknown'};},inspect:async()=>({status:'delivered',evidenceRef:'fixture:delivery'})};const result=await cmd(f,['recover','--request',id]);assert.equal(result.exit,0);assert.equal(result.data.data.job.notification.phase,'delivered');await cmd(f,['recover','--request',id]);assert.equal(sends,1);assert.equal(JSON.parse(await readFile(f.file,'utf8')).invitations.length,2);
});
