import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {FileMessageStore} from '../../src/store.ts';
import {createTask,realClock} from '../../src/model.ts';
import {activeConnection,askPeer,selectConnection} from '../../src/installation/connections.ts';
import {startMain} from '../../src/main.ts';
import {serviceHealth} from '../../src/installation/service.ts';
import {acquireLock} from '../../src/installation/paths.ts';
import {requestBus} from '../../src/ipc.ts';
import {eventKey,executionKey} from '../../src/lifecycle/model.ts';
import {disconnect} from '../../src/installation/connections.ts';
import type {Candidate,PairedConnectionRecord} from '../../src/installation/model.ts';

const api:any=await import('../../src/installation/connection-management.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
export async function savedPairs(t:any){
 const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath};
 const self:Candidate={provider:'codex',sessionId:randomUUID(),title:'Current Codex',workspaceRoot:path.join(root,'code'),availability:'candidate'};
 const candidates:Candidate[]=[self,...[1,2].map(n=>({provider:'claude' as const,sessionId:randomUUID(),title:'Claude '+n,workspaceRoot:path.join(root,'project '+n),availability:'live_endpoint' as const}))];
 const pairs:PairedConnectionRecord[]=candidates.slice(1).map((claude,i)=>({schemaVersion:2,admissionMode:'identity-pair-v1',connectionId:randomUUID(),phase:i?'disconnected':'paired',codex:self,claude,createdAt:new Date().toISOString(),pairing:{activationId:randomUUID(),identity:'confirmed'}}));
 const state=(r:any)=>path.join(c.installRoot,'connections',r.connectionId,'state');
 const save=async(r:any)=>{const dir=path.dirname(state(r));await mkdir(state(r),{recursive:true});await writeFile(path.join(dir,'connection.json'),JSON.stringify(r));await writeFile(path.join(state(r),'bindings.json'),JSON.stringify({schemaVersion:1,bindings:['codex','claude'].map(p=>({agentId:p,kind:p,sessionId:r[p].sessionId,workspaceRoot:r[p].workspaceRoot}))}));};
 for(const r of pairs)await save(r);
 const routes=(r:any)=>({schemaVersion:1,routes:['codex','claude'].map(provider=>({provider,sessionId:r[provider].sessionId,connectionId:r.connectionId}))});
 await writeFile(path.join(c.installRoot,'active-connection.json'),JSON.stringify({connectionId:pairs[0].connectionId}));await writeFile(path.join(c.installRoot,'routes.json'),JSON.stringify(routes(pairs[0])));
 const deps:any={discover:async(_c:any,p:string,id?:string)=>candidates.filter(x=>x.provider===p&&(!id||x.sessionId===id)),now:()=>new Date()};
 const source={provider:'codex' as const,sessionId:self.sessionId};
 return {root,c,self,candidates,pairs,state,save,routes,deps,source};
}

test('saved list is read-only and separates identity, endpoint observation and active selection',async t=>{
 assert.equal(typeof api.listConnections,'function','saved connection inspection is implemented');const f=await savedPairs(t),before=await readdir(f.state(f.pairs[0]));
 const r=await api.listConnections(f.c,f.source,f.deps);assert.equal(r.current.connectionId,f.pairs[0].connectionId);assert.equal(r.connections.length,2);
 const second=r.connections.find((x:any)=>x.connectionId===f.pairs[1].connectionId);assert.equal(second.active,false);assert.equal(second.claude.title,'Claude 2');assert.equal(second.endpoint.claude,'detected');assert.equal(second.endpoint.codex,'unknown');assert.equal(second.work.unfinished,0);
 assert.deepEqual(await readdir(f.state(f.pairs[0])),before);assert.equal(r.connections[0].roundtrip,undefined);
 const other=await api.listConnections(f.c,{provider:'codex',sessionId:randomUUID()},f.deps);assert.equal(other.connections.length,0);assert.equal(other.current.connectionId,f.pairs[0].connectionId);
});

test('saved work identifies pending, uncertain and stopped native work instead of assuming terminal means idle',async t=>{
 assert.equal(typeof api.inspectConnectionWork,'function');const f=await savedPairs(t),store=new FileMessageStore(f.state(f.pairs[0]),realClock);
 const task=await store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.candidates[1].sessionId,body:'work'},realClock));
 assert.equal((await api.inspectConnectionWork(f.c,f.pairs[0].connectionId)).unfinished,1);
 await store.replace({...task.record,state:'needs_check',attempts:1,receipt:{status:'unknown'}});assert.equal((await api.inspectConnectionWork(f.c,f.pairs[0].connectionId)).uncertain,1);
 await store.replace({...task.record,state:'stopped',attempts:1,receipt:{status:'accepted'}});const work=await api.inspectConnectionWork(f.c,f.pairs[0].connectionId);assert.equal(work.unfinished,0);assert.equal(work.nativeOutstanding,1);
});

test('corrupt history and saved records are reported and never become an empty safe queue',async t=>{
 assert.equal(typeof api.listConnections,'function');const f=await savedPairs(t);await mkdir(path.join(f.state(f.pairs[1]),'messages'));await writeFile(path.join(f.state(f.pairs[1]),'messages',randomUUID()+'.json'),'{bad');
 const r=await api.listConnections(f.c,f.source,f.deps);assert.equal(r.connections.find((x:any)=>x.connectionId===f.pairs[1].connectionId).errorCode,'connection_storage_requires_check');
 await writeFile(path.join(f.c.installRoot,'connections',f.pairs[1].connectionId,'connection.json'),'{}');const bad=await api.listConnections(f.c,f.source,f.deps);assert.equal(bad.errors.length,1);assert.equal(bad.errors[0].code,'invalid_connection');
});

test('reviewed idle switch restores either native source direction without messages or a new identity',async t=>{
 assert.equal(typeof api.previewConnectionSwitch,'function');
 for(const provider of ['codex','claude']){
  const f=await savedPairs(t);let source:any=f.source;
  if(provider==='claude'){const other={...f.self,sessionId:randomUUID(),title:'Second Codex'};f.candidates.push(other);f.pairs[1].codex=other;f.pairs[1].claude=f.pairs[0].claude;await f.save(f.pairs[1]);source={provider,sessionId:f.pairs[0].claude.sessionId};}
  const main=await startMain(f.state(f.pairs[0]),{adapters:[],quiet:true,intervalMs:0});t.after(()=>main.close());
  const deps={...f.deps,shutdown:async()=>{await main.close();return {status:'closed'};}};
  const preview=await api.previewConnectionSwitch(f.c,source,f.pairs[1].connectionId,deps);assert.equal(preview.canApply,true);assert.equal(preview.from.claude.title,'Claude 1');
  const result=await api.applyConnectionSwitch(f.c,source,f.pairs[1].connectionId,preview.operationId,deps);
  assert.equal(result.phase,'paired');assert.equal(result.pairing.activationId,f.pairs[1].pairing.activationId);assert.equal((await activeConnection(f.c)).connectionId,f.pairs[1].connectionId);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.c.installRoot,'routes.json'),'utf8')),f.routes(f.pairs[1]));
  assert.equal(JSON.parse(await readFile(path.join(f.c.installRoot,'connections',f.pairs[0].connectionId,'connection.json'),'utf8')).phase,'disconnected');
  assert.equal((await new FileMessageStore(f.state(f.pairs[1]),realClock).list()).length,0);await assert.rejects(serviceHealth(f.state(f.pairs[0])));
  assert.equal((await api.applyConnectionSwitch(f.c,source,f.pairs[1].connectionId,preview.operationId,deps)).connectionId,result.connectionId);
 }
});

test('pending and uncertain work on either pair and stopped native work prevent preview',async t=>{
 assert.equal(typeof api.previewConnectionSwitch,'function');
 for(const side of [0,1])for(const state of ['pending','needs_check','stopped']){
  const f=await savedPairs(t),store=new FileMessageStore(f.state(f.pairs[side]),realClock),r=(await store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.pairs[side].claude.sessionId,body:'work'},realClock))).record;
  await store.replace({...r,state:state as any,attempts:state==='pending'?0:1,receipt:{status:'unknown'}});
  await assert.rejects(api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps),/connection_(has_unfinished_tasks|native_work_outstanding)/);
  assert.equal((await activeConnection(f.c)).connectionId,f.pairs[0].connectionId);
 }
});

test('stale, expired, foreign and changed binding previews cannot replace routes',async t=>{
 assert.equal(typeof api.previewConnectionSwitch,'function');
 for(const mutation of ['new_task','expired','binding','routes','foreign']){
  const f=await savedPairs(t),p=await api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps),before=await readFile(path.join(f.c.installRoot,'routes.json'));
  if(mutation==='new_task')await new FileMessageStore(f.state(f.pairs[0]),realClock).putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.pairs[0].claude.sessionId,body:'arrived later'},realClock));
  if(mutation==='binding')await writeFile(path.join(f.state(f.pairs[1]),'bindings.json'),'{}');
  if(mutation==='routes')await writeFile(path.join(f.c.installRoot,'routes.json'),JSON.stringify({schemaVersion:1,routes:[]}));
  const deps=mutation==='expired'?{...f.deps,now:()=>new Date(Date.parse(p.expiresAt))}:f.deps;
  const source=mutation==='foreign'?{...f.source,sessionId:randomUUID()}:f.source;
  await assert.rejects(api.applyConnectionSwitch(f.c,source,f.pairs[1].connectionId,p.operationId,deps),/switch_preview_(expired|changed)|source_session_mismatch|connection_has_unfinished_tasks|connection_bindings_require_check|connection_routes_require_check/);
  if(mutation!=='routes')assert.deepEqual(await readFile(path.join(f.c.installRoot,'routes.json')),before);
 }
});

test('legacy targets, foreign source and offline target are not silently re-paired',async t=>{
 assert.equal(typeof api.previewConnectionSwitch,'function');const f=await savedPairs(t);
 await assert.rejects(api.previewConnectionSwitch(f.c,{...f.source,sessionId:randomUUID()},f.pairs[1].connectionId,f.deps),/source_session_mismatch/);
 await assert.rejects(api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,{...f.deps,discover:async()=>[]}),/pairing_target_unavailable/);
 const legacy={...f.pairs[1],schemaVersion:1,phase:'disconnected',probeIds:{forward:randomUUID(),reverse:randomUUID()},probeDeadlineAt:new Date().toISOString()};await f.save(legacy);
 await assert.rejects(api.previewConnectionSwitch(f.c,f.source,legacy.connectionId,f.deps),/legacy_connection_requires_reconnect/);
});

test('uncertain shutdown and interruption retain transition guard and block further admission',async t=>{
 assert.equal(typeof api.previewConnectionSwitch,'function');
 for(const mode of ['shutdown','interrupted','late_task']){
  const f=await savedPairs(t),p=await api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps);
  const main=await startMain(f.state(f.pairs[0]),{adapters:[],quiet:true,intervalMs:0});t.after(()=>main.close());
  const deps={...f.deps,shutdown:async()=>{if(mode==='shutdown')return {status:'needs_check'};await main.close();if(mode==='late_task')await main.bus.store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.pairs[0].claude.sessionId,body:'late'},realClock));return {status:'closed'};},afterSwitchStep:async(step:string)=>{if(mode==='interrupted'&&step==='routes_written')throw Error('fixture_interrupted');}};
  await assert.rejects(api.applyConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,p.operationId,deps),/service_shutdown_unconfirmed|fixture_interrupted|connection_has_unfinished_tasks|switch_preview_changed/);
  await assert.rejects(askPeer(f.c,f.source,'claude','never sent',randomUUID(),f.deps),/connection_switch_requires_check/);
  await assert.rejects(selectConnection(f.c,f.source,f.candidates[1],{self:f.self}),/connection_switch_requires_check/);
  await assert.rejects(api.applyConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,p.operationId,deps),/connection_switch_requires_check/);
 }
});

test('connection lock excludes concurrent switch previews',async t=>{
 assert.equal(typeof api.previewConnectionSwitch,'function');const f=await savedPairs(t),release=await acquireLock(path.join(f.c.installRoot,'connection.lock'));try{await assert.rejects(api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps),/installation_busy/);}finally{await release();}
});

test('legacy admission holds the switch lock until IPC acceptance is resolved',async t=>{
 const f=await savedPairs(t),legacy:any={...f.pairs[0],schemaVersion:1,phase:'ready',probeIds:{forward:randomUUID(),reverse:randomUUID()},probeDeadlineAt:new Date().toISOString()};await f.save(legacy);
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);
 const sending=askPeer(f.c,f.source,'claude','blocked at ensure',randomUUID(),{ensure:async()=>{entered();await waiting;throw Error('fixture_end');}} as any).catch(e=>e.message);
 await inside;try{await assert.rejects(api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps),/installation_busy/);}finally{release();}assert.equal(await sending,'fixture_end');
});

test('malformed connection timestamps cannot break the entire saved list',async t=>{
 const f=await savedPairs(t);const malformed={...f.pairs[1],createdAt:null};await f.save(malformed);
 const result=await api.listConnections(f.c,f.source,f.deps);assert.equal(result.connections.length,1);assert.equal(result.errors[0].connectionId,f.pairs[1].connectionId);assert.equal(result.errors[0].code,'invalid_connection');
});

test('a task accepted then stopped after preview still invalidates that preview',async t=>{
 const f=await savedPairs(t),p=await api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps),store=new FileMessageStore(f.state(f.pairs[0]),realClock),r=(await store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.pairs[0].claude.sessionId,body:'new but already stopped'},realClock))).record;
 await store.replace({...r,state:'stopped'});await assert.rejects(api.applyConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,p.operationId,f.deps),/switch_preview_changed/);
});

test('installed Bus rejects low-level accept, reply-current and bind while a switch guard survives',async t=>{
 const f=await savedPairs(t),state=f.state(f.pairs[0]),main=await startMain(state,{connectionId:f.pairs[0].connectionId,adapters:[],quiet:true,intervalMs:0});t.after(()=>main.close());
 await writeFile(path.join(f.c.installRoot,'connection-transition.json'),'{}');for(const [op,payload] of [['accept',{messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'must not enter'}],['reply-current',{messageId:randomUUID(),from:'claude',body:'must not enter'}],['bind',{agentId:'codex',kind:'codex',sessionId:f.self.sessionId,workspaceRoot:f.self.workspaceRoot}]] as const){const r=await requestBus(state,{requestId:randomUUID(),op,payload});assert.equal(r.ok,false);assert.equal(r.errorCode,'connection_switch_requires_check');}
 assert.equal((await main.bus.store.list()).length,0);
 await assert.rejects(startMain(state,{adapters:[],quiet:true,intervalMs:0}),/connection_switch_requires_check/);
});

test('offline lifecycle evidence corruption and execution filename mismatch block switching',async t=>{
 for(const kind of ['events','clean-hints','executions']){const f=await savedPairs(t),dir=path.join(f.state(f.pairs[1]),'lifecycle',kind);await mkdir(dir,{recursive:true});const ref={provider:'claude' as const,sessionId:f.pairs[1].claude.sessionId,nativeExecutionId:randomUUID()},value=kind==='executions'?{...ref,messageId:randomUUID(),dispatchNonce:randomUUID(),phase:'applied'}:{};await writeFile(path.join(dir,'a'.repeat(64)+'.json'),JSON.stringify(value));await assert.rejects(api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps),/connection_storage_requires_check/);}
});

test('completed parent cannot hide a missing or incorrectly linked reply',async t=>{
 for(const broken of ['missing','wrong_parent']){const f=await savedPairs(t),store=new FileMessageStore(f.state(f.pairs[0]),realClock),r=(await store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.pairs[0].claude.sessionId,body:'work'},realClock))).record,replyId=randomUUID();
  if(broken==='wrong_parent')await store.putNew({...r.message,messageId:replyId,kind:'reply',replyTo:randomUUID(),from:'claude',to:'codex',targetSessionId:f.self.sessionId});
  await store.replace({...r,state:'completed',attempts:1,resultRef:replyId});await assert.rejects(api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,f.deps),/connection_storage_requires_check/);
 }
});

test('normal disconnected history is never labeled as an active connection',async t=>{
 const f=await savedPairs(t);await disconnect(f.c,f.pairs[0].connectionId);const r=await api.listConnections(f.c,f.source,f.deps);assert.equal(r.connections.find((x:any)=>x.connectionId===f.pairs[0].connectionId).active,false);assert.equal(r.current,undefined);assert.equal(r.lastSelected.connectionId,f.pairs[0].connectionId);
});

test('paused Bus health blocks switching before shutdown even with empty task storage',async t=>{
 const f=await savedPairs(t),main=await startMain(f.state(f.pairs[0]),{adapters:[],quiet:true,intervalMs:0});t.after(()=>main.close());main.lifecycle.lastError='fixture_storage_pause';let stopped=false;
 await assert.rejects(api.previewConnectionSwitch(f.c,f.source,f.pairs[1].connectionId,{...f.deps,shutdown:async()=>{stopped=true;return {status:'closed'};}}),/service_storage_requires_check/);assert.equal(stopped,false);assert.equal((await activeConnection(f.c)).connectionId,f.pairs[0].connectionId);
});

test('expired clean task with exact native terminal evidence is ended without becoming completed',async t=>{
 const {IdentityStore}=await import('../../src/native/identity-store.ts');const {FileLifecycleStore}=await import('../../src/lifecycle/store.ts');
 for(const mode of ['exact','wrong_turn','background','conflict','unmapped','event_incomplete','competing_event']){
  const f=await savedPairs(t),root=f.state(f.pairs[0]),store=new FileMessageStore(root,realClock),life=new FileLifecycleStore(root),identities=new IdentityStore(root,realClock);
  const id=randomUUID(),attemptId=randomUUID(),turn=randomUUID(),now=new Date().toISOString();
  const message:any={...createTask({messageId:id,from:'codex',to:'claude',targetSessionId:f.pairs[0].claude.sessionId,body:'expired arithmetic'},realClock),schemaVersion:2,wireVersion:'clean-v1',sourceSessionId:f.self.sessionId,returnMode:'auto'};
  const original=(await store.putNew(message)).record;await store.replace({...original,state:'expired',returnMode:'auto',attempts:1,activeAttemptId:attemptId,receipt:{status:'accepted',evidenceRef:'fixture:exact-turn'}});
  await identities.prepare({schemaVersion:1,connectionId:f.pairs[0].connectionId,provider:'claude',targetSessionId:message.targetSessionId,sourceSessionId:f.self.sessionId,messageId:id,attemptId,transportId:randomUUID(),wireVersion:'clean-v1',bodySha256:'a'.repeat(64),createdAt:now,updatedAt:now,phase:mode==='unmapped'?'queued':'mapped',nativeExecutionId:turn,evidenceRef:'fixture:exact-turn'});
  const ref={provider:'claude' as const,sessionId:message.targetSessionId,nativeExecutionId:mode==='wrong_turn'?randomUUID():turn};
  const hint:any={schemaVersion:1,...ref,phase:'stop',observedAt:now,backgroundPending:mode==='background',continuation:false,incomplete:false};await life.enqueueCleanHint(hint);
  await life.putEvent({...hint,...(mode==='event_incomplete'?{incomplete:true}:{}),eventKey:eventKey(ref,'stop')});await life.markApplied(eventKey(ref,'stop'));if(mode==='competing_event'){await life.putEvent({...hint,phase:'failure',eventKey:eventKey(ref,'failure')});await life.markApplied(eventKey(ref,'failure'));}if(mode==='conflict')await life.markConflict(ref,'multiple_terminal_events');
  const before=await readFile(path.join(root,'messages',id+'.json'));const work=await api.inspectConnectionWork(f.c,f.pairs[0].connectionId);
  if(mode==='exact')assert.equal(work.nativeOutstanding,0);else assert.ok(work.nativeOutstanding>0,mode);
  assert.deepEqual(await readFile(path.join(root,'messages',id+'.json')),before);assert.equal((await store.get(id))!.state,'expired');assert.equal((await store.get(id))!.resultRef,undefined);
 }
});