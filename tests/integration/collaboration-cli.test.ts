import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {runLabus} from '../../src/labus.ts';import {temp} from '../helpers.ts';import {runCollaborationCommand} from '../../src/collaboration/cli.ts';
test('structured action command refuses forged execution parameters and never accepts report text on deliver',async t=>{const root=await temp(t),out:string[]=[],io={stdout:{write:(s:string)=>out.push(s)},stderr:{write:()=>{}}};const code=await runLabus(['deliver','--execution',randomUUID()],io,{context:{home:root,installRoot:root,sourceRoot:root,nodeExe:process.execPath}});assert.notEqual(code,0);assert.match(out[0],/unexpected_option/);await assert.rejects(runCollaborationCommand({} as any,{operation:'deliver',task:randomUUID(),operationId:randomUUID(),revision:'0',text:'fake report'},{provider:'claude',sessionId:randomUUID()} as any),/unexpected_option/);});

import {startMain} from '../../src/main.ts';import {requestBus} from '../../src/ipc.ts';import {atomicJson} from '../../src/store.ts';import path from 'node:path';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {readFile,readdir} from 'node:fs/promises';

test('structured CLI carries a chosen hour through IPC and transport, pins retries and rejects timeout on ordinary commands',async t=>{
 const f=await pairingFixture(t),fake:any={async call(){return {data:[]};},async close(){}},reader:any={async inspect(){return {status:'missing'};}};
 f.deps.ensure=async(_c:any,state:string)=>{
  if(!f.services.has(state)){await atomicJson(path.join(state,'bindings.json'),{schemaVersion:1,bindings:f.peers.map(p=>({agentId:p.provider,kind:p.provider,sessionId:p.sessionId,workspaceRoot:p.workspaceRoot}))});const adapters:any=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available',details:[]}),submit:async()=>({status:'accepted'}),reconcile:async()=>({status:'unknown'})}));const main=await startMain(state,{connectionId:path.basename(path.dirname(state)),native:{client:fake,readers:{codex:reader,claude:reader}},adapters,quiet:true,signals:false,intervalMs:0});f.services.set(state,main);t.after(()=>main.close());}
  return {instanceId:'fixture',pid:process.pid,stateRoot:state};
 };
 const connection=await redeemCode(f.c,f.redeemer.intentId,f.deps),id=randomUUID();
 const command=async(args:string[])=>{let out='';const code=await runLabus(args,{stdout:{write:s=>out+=s},stderr:{write(){}}},{context:f.c,env:{CODEX_THREAD_ID:f.peers[0].sessionId},connectionDeps:f.deps});return {code,result:JSON.parse(out)};};
 const args=['ask','--provider','codex','--mode','structured','--text','Read-only review','--id',id,'--timeout-minutes','60'];
 const first=await command(args);assert.equal(first.code,0,JSON.stringify(first.result));
 const state=path.join(f.c.installRoot,'connections',connection.connectionId,'state'),main=f.services.get(state);
 const task=(await main.bus.collaboration.store.getTask(id))!,message=await main.bus.store.get(id);
 assert.equal(task.timeoutMinutes,60);assert.equal(first.result.data.deadline,task.deadline);assert.equal(message.message.expiresAt,task.deadline);
 assert.ok(Date.parse(task.deadline)-Date.parse(message.message.createdAt)>3590000);
 assert.equal((await command(args)).code,0);assert.equal((await main.bus.collaboration.store.getTask(id))!.deadline,task.deadline);
 const changed=await command([...args.slice(0,-1),'30']);assert.equal(changed.result.errorCode,'conflict');
 const before=await readdir(path.join(f.c.installRoot,'outbox'));
 for(const extra of [[],['--mode','structured']])for(const value of ['0','59','61','NaN']){
  const result=await command(['ask','--provider','codex','--text','bad',...extra,'--timeout-minutes',value]);assert.equal(result.result.errorCode,'invalid_collaboration_timeout');
 }
 assert.equal((await command(['ask','--provider','codex','--text','bad','--timeout-minutes','60'])).result.errorCode,'invalid_collaboration_timeout');
 assert.equal((await command(['followup','--provider','codex','--text','bad','--timeout-minutes','60'])).result.errorCode,'unexpected_option');
 assert.deepEqual(await readdir(path.join(f.c.installRoot,'outbox')),before);
 assert.equal(JSON.parse(await readFile(path.join(f.c.installRoot,'outbox',id+'.json'),'utf8')).timeoutMinutes,60);
});
test('service exposes structured capability and registers an action without waiting for its own tool result',async t=>{const root=await temp(t),sessionId=randomUUID(),other=randomUUID(),connectionId=randomUUID();await atomicJson(path.join(root,'bindings.json'),{schemaVersion:1,bindings:[{agentId:'codex',kind:'codex',sessionId,workspaceRoot:root},{agentId:'claude',kind:'claude',sessionId:other,workspaceRoot:root}]});const fake:any={async call(){return {data:[]};},async close(){}};const readers:any={codex:{async inspect(){return {status:'missing'};}},claude:{async inspect(){return {status:'missing'};}}};const main=await startMain(root,{connectionId,quiet:true,signals:false,intervalMs:0,native:{client:fake,readers},adapters:[]});t.after(()=>main.close());const call=(op:string,payload?:any)=>requestBus(root,{requestId:randomUUID(),op,payload});assert.equal((await call('health')).data?.capabilities?.structuredCollaboration,1);const taskId=randomUUID();assert.equal((await call('collaboration-open',{input:{messageId:taskId,kind:'task',from:'codex',to:'claude',returnMode:'auto',body:'Do work'},actor:{provider:'codex',sessionId}})).ok,true);const action:any={operationId:randomUUID(),taskId,actor:{provider:'claude',sessionId:other},kind:'deliver',expectedRevision:0};const receipt=await call('collaboration-action',action);assert.equal(receipt.data?.phase,'pending_verification');assert.equal((await call('collaboration-status')).data?.items?.length,1);});
