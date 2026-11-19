import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
import {setAutomation,enqueuePairJob,readPairJob} from '../../src/pairing/jobs.ts';
import {routeHook} from '../../src/installation/hook-router.ts';
import path from 'node:path';import {pathToFileURL} from 'node:url';import {runChild} from '../../src/adapters/codex.ts';
const api:any=await import('../../src/pairing/worker.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('worker waits for the exact native input without any model tools then exits',async t=>{
 const f=await pairingFixture(t);assert.equal(typeof api.runPairWorker,'function');await setAutomation(f.c,true,f.deps);
 const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);const state=JSON.parse(await readFile(f.file,'utf8')),r=state.requests.find((r:any)=>r.requestId===id),file=r.event.transcript_path,bytes=await readFile(file);await writeFile(file,'');let waits=0;
 await api.runPairWorker(f.c,{...f.deps,sleep:async()=>{waits++;await writeFile(file,bytes);}});
 const j=await readPairJob(f.c,id);assert.equal(waits,1);assert.equal(j!.phase,'succeeded');assert.equal(j!.result.phase,'code_issued');assert.equal(f.sent.length,0);
});
test('worker rejects expired requests and never resumes jobs from a previous enable generation',async t=>{
 const f=await pairingFixture(t);assert.equal(typeof api.runPairWorker,'function');await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);f.clock.value+=120001;
 await api.runPairWorker(f.c,f.deps);assert.equal((await readPairJob(f.c,id))!.phase,'failed');
 const next=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,next,f.deps);await setAutomation(f.c,false,f.deps);await setAutomation(f.c,true,f.deps);await api.runPairWorker(f.c,f.deps);assert.equal((await readPairJob(f.c,next))!.phase,'disabled');
});
test('auto Hook schedules exact request and does not give model a tool-execution ticket',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码'),s=JSON.parse(await readFile(f.file,'utf8')),r=s.requests.find((r:any)=>r.requestId===id);let called=0,output='';
 await routeHook(f.c,'claude',[Buffer.from(JSON.stringify(r.event))],{...f.deps,stdout:{write:(text:string)=>output+=text},scheduleWorker:async()=>{called++;}} as any);
 assert.equal(called,1);assert.ok(await readPairJob(f.c,id));assert.ok(!output.includes('AGENTWIRE_PAIR_REQUEST='));assert.ok(output.includes('程序处理'));assert.ok(!output.includes('pair issue --intent'));
});
test('claimed activation survives crash before job result and recovers after request expiry',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[0],'连接 Claude，连接码 '+f.invitation.code);await enqueuePairJob(f.c,id,f.deps);
 await api.runPairWorker(f.c,{...f.deps,afterStep:async(s:string)=>{if(s==='claimed')throw Error('fixture_crash');}});
 const j=await readPairJob(f.c,id);assert.ok(j!.intentId,'intent proof must be committed before side effects');assert.equal(j!.phase,'needs_check');
 f.clock.value+=180000;
 await api.recoverPairJob(f.c,id,f.deps);assert.equal((await readPairJob(f.c,id))!.phase,'succeeded');
});
test('scheduler starts one fixed worker and propagates launch failure',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);let launches=0;
 // Use the platform path builder: no user text is passed to the process.
 const path=await import('node:path');const fixed=async(args:string[])=>{launches++;assert.deepEqual(args,['--experimental-strip-types',path.join(f.c.installRoot,'runtime','src','pairing','worker.ts'),'--root',f.c.installRoot]);return {pid:process.pid};};
 await api.schedulePairWorker(f.c,{launch:fixed});await api.schedulePairWorker(f.c,{launch:fixed});assert.equal(launches,1);
 const other=await pairingFixture(t);await setAutomation(other.c,true,other.deps);await assert.rejects(api.schedulePairWorker(other.c,{launch:async()=>{throw Error('spawn_failed');}}),/spawn_failed/);assert.equal((await api.inspectPairWorker(other.c)).active,false);
});
test('scheduler cannot start after uninstall has stopped automatic admission',async t=>{
 const f=await pairingFixture(t);let starts=0;await assert.rejects(api.schedulePairWorker(f.c,{launch:async()=>{starts++;return {pid:process.pid};}}),/pairing_automation_disabled/);assert.equal(starts,0);
});
test('worker exit handshake includes a request queued at idle',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);let once=false,id:string;
 await api.runPairWorker(f.c,{...f.deps,afterIdle:async()=>{if(!once){once=true;id=await stageNativeCommand(f,f.peers[0],'生成连接码');await enqueuePairJob(f.c,id,f.deps);}}});
 assert.equal((await readPairJob(f.c,id!))!.phase,'succeeded');assert.equal((await api.inspectPairWorker(f.c)).active,false);
});
test('peer input cannot issue a code while waiting for proof',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);
 const state=JSON.parse(await readFile(f.file,'utf8')),file=state.requests.find((r:any)=>r.requestId===id).event.transcript_path,rows=(await readFile(file,'utf8')).replace('"kind":"human"','"kind":"peer"');await writeFile(file,rows);
 await api.runPairWorker(f.c,{...f.deps,sleep:async()=>{f.clock.value+=120001;}});assert.equal((await readPairJob(f.c,id))!.phase,'failed');assert.equal(JSON.parse(await readFile(f.file,'utf8')).invitations.length,1);
});
test('a killed process leaves an applying checkpoint recoverable with the same activation',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[0],'连接 Claude，连接码 '+f.invitation.code);await enqueuePairJob(f.c,id,f.deps);
 const script=path.join(f.root,'crash.ts');await writeFile(script,`import {runPairWorker} from ${JSON.stringify(pathToFileURL(path.resolve('src/pairing/worker.ts')).href)};await runPairWorker(${JSON.stringify(f.c)},{now:()=>new Date(${f.clock.value}),discover:async(_c,p)=>${JSON.stringify(f.peers)}.filter(x=>x.provider===p),afterStep:async s=>{if(s==='claimed')process.exit(75);}});`);
 const child=await runChild(process.execPath,['--experimental-strip-types',script],{timeoutMs:10000});assert.equal(child.exitCode,75,child.stderr);const saved=(await readPairJob(f.c,id))!;assert.equal(saved.phase,'applying');assert.ok(saved.intentId);const first=JSON.parse(await readFile(f.file,'utf8')).activations[0].activationId;
 f.clock.value+=180000;await api.runPairWorker(f.c,f.deps);assert.equal((await readPairJob(f.c,id))!.phase,'succeeded');const state=JSON.parse(await readFile(f.file,'utf8'));assert.equal(state.activations.length,1);assert.equal(state.activations[0].activationId,first);
});

test('scheduler guards the exact worker PID when native launch outcome is uncertain',async t=>{
 const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);
 await assert.rejects(api.schedulePairWorker(f.c,{launch:async()=>{throw Object.assign(Error('pair_worker_launch_unconfirmed'),{startedPid:process.pid});}}),/pair_worker_launch_unconfirmed/);
 const marker=await api.inspectPairWorker(f.c);assert.equal(marker.pid,process.pid);assert.equal(marker.phase,'starting');assert.equal(marker.active,true);
});
