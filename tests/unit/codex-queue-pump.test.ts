import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {temp,clock} from '../helpers.ts';
import {LocalBus} from '../../src/bus.ts';
import {FileMessageStore} from '../../src/store.ts';
import {IdentityStore} from '../../src/native/identity-store.ts';
import {NativeDispatcher} from '../../src/native/dispatcher.ts';
import {startMain} from '../../src/main.ts';
const api:any=await import('../../src/native/codex-queue.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

async function fixture(t:any){
 const root=await temp(t),time=clock(),store=new FileMessageStore(root,time),ids=new IdentityStore(root,time);
 const bindings=['codex','claude'].map(kind=>({agentId:kind,kind,sessionId:randomUUID(),workspaceRoot:root})) as any;
 let sends=0,visible=false;const reader:any={inspect:async(i:any)=>visible?{status:'mapped',identity:{provider:i.provider,sessionId:i.targetSessionId,transportId:i.transportId,nativeExecutionId:randomUUID(),evidenceRef:'exact-original-input'}}:{status:'missing'}};
 const adapters=bindings.map((b:any)=>({kind:b.kind,probe:async()=>({status:'available',details:[]}),submit:async()=>{sends++;return {status:'accepted'};},reconcile:async()=>({status:'unknown'})}));
 const bus=new LocalBus({store,bindings,adapters,clock:time,newAutoWireVersion:'clean-v1',nativeDispatcher:new NativeDispatcher(ids,{codex:reader,claude:reader}),connectionId:randomUUID()} as any);
 const parent=await bus.accept({messageId:randomUUID(),kind:'task',from:'claude',to:'codex',returnMode:'auto',body:'one accepted task'});await bus.tick();
 const intent=(await ids.list())[0],queueId=randomUUID(),calls:any[]=[];
 let status='completed',runtime='idle',loaded=true,wrongIdentity=false,queue:any[]=[{id:queueId,clientUserMessageId:intent.transportId}],duringRead:(()=>Promise<void>)|undefined,startError=false;
 const client:any={call:async(method:string,p:any)=>{calls.push({method,p});if(method==='thread/loaded/list')return {data:loaded?[intent.targetSessionId]:[],nextCursor:null};if(method==='thread/read')return {thread:{id:wrongIdentity?randomUUID():intent.targetSessionId,status:{type:runtime}}};if(method==='thread/turns/list')return {data:[{id:randomUUID(),status}],nextCursor:null};if(method==='thread/queue/list'){await duringRead?.();return {data:queue,nextCursor:null};}if(method==='thread/queue/start'){assert.equal((await ids.get(intent.attemptId))?.queueStart?.status,'attempted','persist before native side effect');if(startError)throw Error('native response lost');return {turn:{id:randomUUID()}};}throw Error('unexpected_method');}};
 return {bus,ids,time,store,parent,intent,queueId,calls,client,sends:()=>sends,setStatus:(s:string)=>status=s,setRuntime:(s:string)=>runtime=s,setLoaded:(v:boolean)=>loaded=v,setWrongIdentity:()=>wrongIdentity=true,setQueue:(q:any[])=>queue=q,onRead:(f:()=>Promise<void>)=>duringRead=f,failStart:()=>startError=true,showEvidence:()=>visible=true};
}

test('idle queue pump starts the existing exact head once and never adds another message',async t=>{
 assert.equal(typeof api.CodexQueuePump,'function');const f=await fixture(t),pump=new api.CodexQueuePump(f.bus,f.client);
 await pump.drain();await pump.drain();assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,1);assert.equal(f.calls.find(x=>x.method==='thread/queue/start').p.queuedSubmissionId,f.queueId);assert.equal(f.sends(),1);assert.equal((await f.ids.get(f.intent.attemptId))?.queueStart?.status,'started');
});

test('busy turn, another queue head, duplicate transport and missing queue never start or resend',async t=>{
 for(const mode of ['busy','other_head','duplicate','absent']){assert.equal(typeof api.CodexQueuePump,'function');const f=await fixture(t);if(mode==='busy')f.setStatus('inProgress');if(mode==='other_head')f.setQueue([{id:randomUUID(),clientUserMessageId:randomUUID()},{id:f.queueId,clientUserMessageId:f.intent.transportId}]);if(mode==='duplicate')f.setQueue([{id:f.queueId,clientUserMessageId:f.intent.transportId},{id:randomUUID(),clientUserMessageId:f.intent.transportId}]);if(mode==='absent')f.setQueue([]);await new api.CodexQueuePump(f.bus,f.client).drain();assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,0,mode);assert.equal(f.sends(),1);}
});

test('expiry, shutdown and route guard during read prevent a new native execution',async t=>{
 for(const mode of ['expiry','shutdown','guard']){assert.equal(typeof api.CodexQueuePump,'function');const f=await fixture(t);let blocked=false;f.onRead(async()=>{if(mode==='expiry')f.time.value=Date.parse(f.parent.message.expiresAt);if(mode==='shutdown')f.bus.requestShutdown();if(mode==='guard')blocked=true;});await new api.CodexQueuePump(f.bus,f.client,async()=>{if(blocked)throw Error('connection_switch_requires_check');}).drain().catch((e:any)=>{assert.equal(mode,'guard');assert.match(e.message,/connection_switch/);});assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,0,mode);}
});

test('unknown start and restart after committed start never retry a native execution',async t=>{
 for(const mode of ['unknown','crash']){assert.equal(typeof api.CodexQueuePump,'function');const f=await fixture(t);if(mode==='unknown')f.failStart();else await f.ids.advance(f.intent.attemptId,'queued',{queueStart:{submissionId:f.queueId,status:'attempted',attemptedAt:f.time.now().toISOString()}} as any);await new api.CodexQueuePump(f.bus,f.client).drain();await new api.CodexQueuePump(f.bus,f.client).drain();assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,mode==='unknown'?1:0);assert.equal((await f.store.get(f.parent.message.messageId))?.state,'needs_check');assert.equal(f.sends(),1);}
});

test('paused task, malformed status and expired message cannot be awakened',async t=>{
 for(const mode of ['paused','bad_status','expired']){assert.equal(typeof api.CodexQueuePump,'function');const f=await fixture(t);const r=(await f.store.get(f.parent.message.messageId))!;if(mode==='paused')await f.store.replace({...r,state:'needs_check'});if(mode==='expired')f.time.value=Date.parse(r.message.expiresAt);if(mode==='bad_status')f.setStatus('unknown-new-native-status');await new api.CodexQueuePump(f.bus,f.client).drain();assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,0,mode);}
});

test('deadline elapsed while inspecting the queue cannot start an execution',async t=>{
 const f=await fixture(t),r=(await f.store.get(f.parent.message.messageId))!;
 f.onRead(async()=>{f.time.value=Date.parse(r.resultDeadlineAt!);});
 await new api.CodexQueuePump(f.bus,f.client).drain();
 assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,0);
});

test('unknown queue start reconciles exact native evidence without another start or submission',async t=>{
 const f=await fixture(t);f.failStart();const pump=new api.CodexQueuePump(f.bus,f.client);await pump.drain();
 assert.equal((await f.store.get(f.parent.message.messageId))?.state,'needs_check');
 f.showEvidence();await f.bus.tick();await pump.drain();
 assert.equal((await f.store.get(f.parent.message.messageId))?.state,'submitted');
 assert.equal((await f.ids.get(f.intent.attemptId))?.phase,'mapped');
 assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,1);assert.equal(f.sends(),1);
});

test('service worker pumps an accepted native queue once and closes without another submission',async t=>{
 let runtime:any;const root=await temp({after:(fn:any)=>t.after(async()=>{await runtime?.close();await fn();})}),time=clock(),queueId=randomUUID();
 let sends=0,starts=0;const reader:any={inspect:async()=>({status:'missing'})};
 const client:any={close:async()=>{},call:async(method:string,p:any)=>{
  const target=runtime?.bus.bindings.get('codex')?.sessionId;
  if(method==='thread/loaded/list')return {data:[target],nextCursor:null};
  if(method==='thread/read')return {thread:{id:target,status:{type:'idle'}}};
  if(method==='thread/turns/list')return {data:[{id:randomUUID(),status:'completed'}]};
  if(method==='thread/queue/list'){const i=(await runtime.bus.nativeDispatcher.store.list())[0];return {data:[{id:queueId,clientUserMessageId:i.transportId}],nextCursor:null};}
  if(method==='thread/queue/start'){starts++;assert.equal(p.queuedSubmissionId,queueId);return {turn:{id:randomUUID()}};}
  throw Error('unexpected_method');
 }};
 const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:async()=>{sends++;return {status:'accepted' as const};},reconcile:async()=>({status:'unknown' as const})}));
 runtime=await startMain(root,{connectionId:randomUUID(),newAutoWireVersion:'clean-v1',adapters,native:{client,readers:{codex:reader,claude:reader}},clock:time,intervalMs:10,signals:false,quiet:true});
 for(const agentId of ['codex','claude'])await runtime.bus.bind({agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root});
 await runtime.bus.accept({messageId:randomUUID(),kind:'task',from:'claude',to:'codex',body:'service pump',returnMode:'auto'});
 for(let n=0;n<100&&!starts;n++)await new Promise(r=>setTimeout(r,10));
 await runtime.close();assert.equal(starts,1);assert.equal(sends,1);
});

test('terminal history never substitutes for the exact loaded and idle native runtime',async t=>{
 for(const mode of ['active','notLoaded','missing_loaded','wrong_identity']){
  const f=await fixture(t);f.setStatus('interrupted');
  if(mode==='missing_loaded')f.setLoaded(false);else if(mode==='wrong_identity')f.setWrongIdentity();else f.setRuntime(mode);
  await new api.CodexQueuePump(f.bus,f.client).drain();
  assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,0,mode);
  assert.equal((await f.ids.get(f.intent.attemptId))?.queueStart,undefined,mode);
 }
});

test('runtime becoming active after start-intent commit prevents native start',async t=>{
 const f=await fixture(t);const pump=new api.CodexQueuePump(f.bus,f.client,async()=>{if((await f.ids.get(f.intent.attemptId))?.queueStart?.status==='attempted')f.setRuntime('active');});
 await pump.drain();assert.equal(f.calls.filter(x=>x.method==='thread/queue/start').length,0);
 assert.equal((await f.ids.get(f.intent.attemptId))?.queueStart?.status,'not_started');
});
