import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {getAgent} from '../../src/agents/registry.ts';
import {collaborationPage} from '../../src/status.ts';

async function fixture(t:any){
 const home=await temp(t),dir=path.join(home,'.claude','sessions');await mkdir(dir,{recursive:true});
 const sessionId=randomUUID(),now=new Date(),record={sessionId,pid:process.pid,cwd:home,status:'waiting',waitingFor:'permission prompt',updatedAt:+now,statusUpdatedAt:+now};
 const c={home,installRoot:home,sourceRoot:home,nodeExe:process.execPath};
 const save=async(r:any,name=process.pid+'.json')=>writeFile(path.join(dir,name),JSON.stringify(r));
 const read=()=>getAgent('claude').readSessionStatus?.(c,sessionId,now);
 return {c,home,dir,sessionId,now,record,save,read};
}

test('native approval is a bounded fresh exact-session observation with no report or authentication data',async t=>{
 const f=await fixture(t);await f.save({...f.record,peerToken:'secret',message:'secret'});
 const observed=await f.read();assert.equal(observed?.status,'waiting_approval');assert.equal(observed?.sessionId,f.sessionId);
 assert.equal(observed?.scope,'session');assert.equal(observed?.taskAssociation,'unconfirmed');
 assert.ok(observed?.evidenceRef.endsWith(process.pid+'.json'));assert.ok(!JSON.stringify(observed).includes('secret'));
 assert.equal(await getAgent('codex').readSessionStatus?.(f.c as any,f.sessionId,f.now),undefined);
});

test('missing, stale, future, dead, mismatched, duplicate or generic waiting cannot claim approval',async t=>{
 const f=await fixture(t);assert.equal(await f.read(),undefined);
 for(const patch of [{status:'idle'},{waitingFor:'working'},{updatedAt:+f.now-30001},{updatedAt:+f.now+1},{pid:0},{sessionId:randomUUID()},{cwd:'relative'},{updatedAt:'invalid'},{statusUpdatedAt:+f.now+1}]){
  await f.save({...f.record,...patch});assert.equal(await f.read(),undefined,JSON.stringify(patch));
 }
 await f.save(f.record);await f.save({...f.record,pid:2147483647},'2147483647.json');assert.equal((await f.read())?.status,'waiting_approval');
 await f.save(f.record,'123.json');assert.equal((await f.read())?.status,'waiting_approval');
 // A second live record for this session is ambiguous even if its own status is stale.
 await f.save({...f.record,pid:process.ppid,status:'idle',updatedAt:0},process.ppid+'.json');assert.equal(await f.read(),undefined);
});

test('approval display retains business phase and states that native evidence is session scoped',async()=>{
 const now=new Date(),executor={provider:'claude',sessionId:randomUUID()},initiator={provider:'codex',sessionId:randomUUID()};
 const task:any={taskId:randomUUID(),connectionId:randomUUID(),initiator,executor,phase:'working',revision:0,deadline:new Date(+now+60000).toISOString(),executions:1,questions:0,currentMessageId:randomUUID(),businessVerdict:'unverified'};
 const native:any={...executor,status:'waiting_approval',scope:'session',taskAssociation:'unconfirmed',observedAt:now.toISOString(),updatedAt:now.toISOString(),evidenceRef:'fixture:exact'};
 const row=collaborationPage([task],{},[],[native],now).items[0];
 assert.equal(row.phase,'working');assert.equal(row.display.waitingFor,'executor');assert.match(row.display.summary,/等待审批.*关联未确认/);assert.equal(row.nativeSession?.scope,'session');
 for(const other of [{...native,sessionId:randomUUID()},{...native,updatedAt:new Date(+now-30001).toISOString()},{...native,observedAt:new Date(+now+1).toISOString()}])assert.equal(collaborationPage([task],{},[],[other],now).items[0].nativeSession,undefined);
 for(const phase of ['completed','expired','stopped','needs_check'])assert.equal(collaborationPage([{...task,phase}],{},[],[native],now).items[0].nativeSession,undefined);
});
