import path from 'node:path';
import {readdir,readFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assertId,realClock} from '../model.ts';
import {FileMessageStore} from '../store.ts';
import {FileLifecycleStore,validateCleanHint} from '../lifecycle/store.ts';
import {validateExecution,executionKey,digest} from '../lifecycle/model.ts';
import {IdentityStore} from '../native/identity-store.ts';
import {activeConnection,readConnection} from './connections.ts';
import {safePath,optional,atomicBytes,jsonBytes,hash,acquireLock,assertNoConnectionSwitch,deadPid} from './paths.ts';
import {pairEndpoints} from '../pairing/health.ts';
import {inspectService,shutdownService} from './service.ts';
import {withPairState} from '../pairing/store.ts';
import {sameChat} from './connections.ts';
import type {InstallContext,SourceRef,ConnectionRecord,PairedConnectionRecord} from './model.ts';
import type {PairDeps} from '../pairing/model.ts';

const terminal=new Set(['completed','delivered','failed','expired','stopped']);
const isId=(id:string)=>{try{assertId(id);return true;}catch{return false;}};
export const connectionState=(c:InstallContext,id:string)=>{assertId(id);return path.join(c.installRoot,'connections',id,'state');};
/** Unlike store.list(), inspection never creates absent directories. */
async function names(c:InstallContext,dir:string){
 await safePath(c.installRoot,dir);let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return [];throw e;}
 if(entries.length>10000)throw Error('connection_history_limit');
 for(const e of entries)if(e.isSymbolicLink())throw Error('symlink_not_allowed');return entries;
}
export async function inspectConnectionWork(c:InstallContext,id:string){
 const root=connectionState(c,id),store=new FileMessageStore(root,realClock),life=new FileLifecycleStore(root);
 const work={unfinished:0,uncertain:0,nativeOutstanding:0,artifactsPending:0};
 const records=new Map();
 for(const e of await names(c,path.join(root,'messages'))){
  if(e.name.endsWith('.tmp')){work.artifactsPending++;continue;}if(!e.isFile()||!e.name.endsWith('.json'))throw Error('connection_storage_requires_check');
  await safePath(c.installRoot,path.join(root,'messages',e.name));const r=await store.get(e.name.slice(0,-5));if(!r)throw Error('connection_storage_requires_check');records.set(r.message.messageId,r);
  if(!terminal.has(r.state))work.unfinished++;if(r.state==='needs_check')work.uncertain++;
  if(r.message.kind!=='reply'&&r.attempts>0&&r.receipt?.status!=='rejected'&&!r.resultRef&&!await life.getResult(r.message.messageId))work.nativeOutstanding++;
 }
 for(const r of records.values())if(r.resultRef){
  assertId(r.resultRef);const reply=records.get(r.resultRef),m=r.message,b=reply?.message;
  if(!b||b.kind!=='reply'||b.replyTo!==m.messageId||b.taskId!==m.taskId||b.from!==m.to||b.to!==m.from||m.schemaVersion===2&&(b.schemaVersion!==2||b.sourceSessionId!==m.targetSessionId||b.targetSessionId!==m.sourceSessionId))throw Error('connection_storage_requires_check');
 }
 const native=new IdentityStore(root,realClock);
 for(const e of await names(c,native.root)){
  if(e.name==='quarantine'||e.name.endsWith('.tmp')){work.artifactsPending++;continue;}if(!e.isFile()||!e.name.endsWith('.json'))throw Error('connection_storage_requires_check');
  await safePath(c.installRoot,path.join(native.root,e.name));const i=await native.get(e.name.slice(0,-5));if(!i)throw Error('connection_storage_requires_check');
  const r=records.get(i.messageId);if(!r)throw Error('connection_storage_requires_check');const settled=r.resultRef||r.message.kind==='reply'&&r.state==='delivered'&&r.receipt?.status==='accepted'&&r.receipt.evidenceRef;
  if(i.phase==='needs_check'||!['not_written','reply_committed','delivered'].includes(i.phase)&&!settled)work.nativeOutstanding++;
 }
 for(const dir of ['quarantine','lifecycle/inbox','lifecycle/quarantine','lifecycle/conflicts'])work.artifactsPending+=(await names(c,path.join(root,dir))).length;
 for(const e of await names(c,path.join(root,'lifecycle','executions'))){
  if(!e.isFile()||!e.name.endsWith('.json')){work.artifactsPending++;continue;}
  const file=await safePath(c.installRoot,path.join(root,'lifecycle','executions',e.name));const execution=JSON.parse(await readFile(file,'utf8'));validateExecution(execution);if(executionKey(execution)+'.json'!==e.name||!records.has(execution.messageId))throw Error('connection_storage_requires_check');
  if(execution.replyMessageId){const reply=records.get(execution.replyMessageId);if(!reply||reply.message.kind!=='reply'||reply.message.replyTo!==execution.messageId)throw Error('connection_storage_requires_check');}if(execution.phase!=='applied')work.artifactsPending++;
 }
 for(const e of await names(c,path.join(root,'lifecycle','events'))){if(!e.isFile()||!e.name.endsWith('.json'))throw Error('connection_storage_requires_check');await safePath(c.installRoot,path.join(root,'lifecycle','events',e.name));const event=await life.getEvent(e.name.slice(0,-5));if(!event)throw Error('connection_storage_requires_check');if(!await life.isApplied(event.eventKey))work.artifactsPending++;}
 for(const e of await names(c,path.join(root,'lifecycle','clean-hints'))){if(!e.isFile()||!e.name.endsWith('.json'))throw Error('connection_storage_requires_check');const file=await safePath(c.installRoot,path.join(root,'lifecycle','clean-hints',e.name)),hint=JSON.parse(await readFile(file,'utf8'));validateCleanHint(hint);const {observedAt,...semantic}=hint;if(digest(JSON.stringify(semantic))+'.json'!==e.name)throw Error('connection_storage_requires_check');}
 for(const e of await names(c,path.join(root,'lifecycle','results'))){if(!e.isFile()||!e.name.endsWith('.json'))throw Error('connection_storage_requires_check');await safePath(c.installRoot,path.join(root,'lifecycle','results',e.name));const result=await life.getResult(e.name.slice(0,-5));if(!result||!records.has(result.messageId))throw Error('connection_storage_requires_check');}
 return work;
}
export async function listConnections(c:InstallContext,source:SourceRef,deps:PairDeps={}){
 if(!['codex','claude'].includes(source.provider))throw Error('source_provider_invalid');assertId(source.sessionId);
 let current:ConnectionRecord|undefined;const errors:{connectionId?:string;code:string}[]=[];
 try{current=await activeConnection(c,true);}catch(e:any){if(e.message!=='not_connected')errors.push({code:e.message});}
 const connections:any[]=[];
 for(const e of await names(c,path.join(c.installRoot,'connections'))){
  if(!isId(e.name))continue;
  try{
   const r=await readConnection(c,e.name);if(r[source.provider].sessionId!==source.sessionId)continue;
   const view:any={...r,active:current?.phase!=='disconnected'&&current?.connectionId===r.connectionId,endpoint:await pairEndpoints(c,r as PairedConnectionRecord,deps)};
   try{view.work=await inspectConnectionWork(c,r.connectionId);}catch{view.errorCode='connection_storage_requires_check';}
   connections.push(view);
  }catch{errors.push({connectionId:e.name,code:'invalid_connection'});}
 }
 connections.sort((a,b)=>Number(b.active)-Number(a.active)||a.createdAt.localeCompare(b.createdAt)||a.connectionId.localeCompare(b.connectionId));
 return {current:current?.phase==='disconnected'?undefined:current,lastSelected:current?.phase==='disconnected'?current:undefined,connections,errors};
}

type SwitchDeps=PairDeps&{shutdown?:typeof shutdownService;afterSwitchStep?:(step:'guard_written'|'services_stopped'|'routes_written'|'active_written')=>Promise<void>};
type SwitchPlan={schemaVersion:1;operationId:string;source:SourceRef;from?:ConnectionRecord;to:PairedConnectionRecord;expiresAt:string;snapshot:Record<string,string|null>;canApply:true;status:'preview'|'applied'};
const transitionFile=(c:InstallContext)=>path.join(c.installRoot,'connection-transition.json');
const recordFile=(c:InstallContext,id:string)=>path.join(path.dirname(connectionState(c,id)),'connection.json');
const planFile=(c:InstallContext,id:string)=>{assertId(id);return path.join(c.installRoot,'install','connection-switches',id+'.json');};
function verifyCaller(r:ConnectionRecord,source:SourceRef){if(!['codex','claude'].includes(source.provider)||r[source.provider].sessionId!==source.sessionId)throw Error('source_session_mismatch');}
export async function inspectConnectionBindings(c:InstallContext,r:ConnectionRecord){
 try{
  const file=await safePath(c.installRoot,path.join(connectionState(c,r.connectionId),'bindings.json')),b=await readFile(file);if(b.length>262144)throw Error('limit');const value=JSON.parse(b.toString());
  if(value.schemaVersion!==1||!Array.isArray(value.bindings)||value.bindings.length!==2)throw Error('invalid');const seen=new Set();
  for(const binding of value.bindings){const p=binding?.agentId;if(!['codex','claude'].includes(p)||seen.has(p)||binding.kind!==p||!sameChat(r[p as 'codex'|'claude'],{provider:p,sessionId:binding.sessionId,workspaceRoot:binding.workspaceRoot} as any))throw Error('invalid');seen.add(p);}
 }catch{throw Error('connection_bindings_require_check');}
}
export async function inspectConnectionRoutes(c:InstallContext,r?:ConnectionRecord){
 try{
  const b=await optional(await safePath(c.installRoot,path.join(c.installRoot,'routes.json'))),value=b?JSON.parse(b.toString()):{schemaVersion:1,routes:[]};
  if(b&&b.length>262144||value.schemaVersion!==1||!Array.isArray(value.routes))throw Error('invalid');
  const live=r&&r.phase!=='disconnected';if(value.routes.length!==(live?2:0))throw Error('invalid');const seen=new Set();
  for(const route of value.routes){const p=route?.provider;if(!live||!['codex','claude'].includes(p)||seen.has(p)||route.connectionId!==r.connectionId||route.sessionId!==r[p as 'codex'|'claude'].sessionId)throw Error('invalid');seen.add(p);}
 }catch{throw Error('connection_routes_require_check');}
}
async function assertIdle(c:InstallContext,r:ConnectionRecord){
 let work;try{work=await inspectConnectionWork(c,r.connectionId);}catch{throw Error('connection_storage_requires_check');}
 if(work.unfinished||work.uncertain)throw Error('connection_has_unfinished_tasks');
 if(work.nativeOutstanding)throw Error('connection_native_work_outstanding');if(work.artifactsPending)throw Error('connection_storage_requires_check');
}
async function targetAvailable(c:InstallContext,r:PairedConnectionRecord,deps:PairDeps){
 const discover=deps.discover||(await import('./discovery.ts')).discoverCandidates;
 for(const p of ['codex','claude'] as const){const matches=(await discover(c,p,r[p].sessionId)).filter(x=>x.sessionId===r[p].sessionId);if(matches.length!==1||!sameChat(matches[0],r[p])||p==='claude'&&matches[0].availability!=='live_endpoint')throw Error('pairing_target_unavailable');}
}
async function snapshot(c:InstallContext,from:ConnectionRecord|undefined,to:ConnectionRecord){
 const files=[path.join(c.installRoot,'active-connection.json'),path.join(c.installRoot,'routes.json'),recordFile(c,to.connectionId),path.join(connectionState(c,to.connectionId),'bindings.json')];
 if(from&&from.connectionId!==to.connectionId)files.push(recordFile(c,from.connectionId),path.join(connectionState(c,from.connectionId),'bindings.json'));
 const out:Record<string,string|null>={};for(const f of files){const b=await optional(await safePath(c.installRoot,f));out[path.relative(c.installRoot,f)]=b?hash(b):null;}
 for(const r of [from,to].filter((r,index,all)=>r&&all.findIndex(x=>x?.connectionId===r.connectionId)===index) as ConnectionRecord[]){const accepted=(await names(c,path.join(connectionState(c,r.connectionId),'messages'))).filter(e=>e.isFile()&&e.name.endsWith('.json')).map(e=>e.name).sort();out['accepted:'+r.connectionId]=hash(JSON.stringify(accepted));}return out;
}
async function current(c:InstallContext){try{return await activeConnection(c);}catch(e:any){if(e.message!=='not_connected')throw e;}}
async function validateSwitch(c:InstallContext,source:SourceRef,from:ConnectionRecord|undefined,to:ConnectionRecord,deps:SwitchDeps){
 verifyCaller(to,source);if(from&&from.phase!=='disconnected')verifyCaller(from,source);
 if(to.schemaVersion!==2)throw Error('legacy_connection_requires_reconnect');
 if(to.phase!=='disconnected'||to.errorCode)throw Error('connection_not_ready');
 if(from&&from.phase!=='disconnected'&&(!['paired','ready'].includes(from.phase)||from.errorCode))throw Error('connection_not_ready');
 await inspectConnectionRoutes(c,from);await inspectConnectionBindings(c,to);await assertIdle(c,to);
 if(from&&from.phase!=='disconnected'){await inspectConnectionBindings(c,from);await assertIdle(c,from);}
 for(const r of [from,to]){if(!r||r.phase==='disconnected'&&r!==to)continue;try{const h=await inspectService(connectionState(c,r.connectionId));if(h.status!=='running')throw Error('service_storage_requires_check');}catch(e:any){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}}
 await targetAvailable(c,to,deps);
}
export async function previewConnectionSwitch(c:InstallContext,source:SourceRef,id:string,deps:SwitchDeps={}):Promise<SwitchPlan>{
 return withPairState(c,async tx=>{
  await assertNoConnectionSwitch(c);if(tx.state.activations.some(a=>a.phase!=='paired'))throw Error('pairing_activation_requires_check');
  const from=await current(c),to=await readConnection(c,id);if(from?.connectionId===id&&from.phase!=='disconnected')throw Error('connection_already_active');
  await validateSwitch(c,source,from,to,deps);
  const result:SwitchPlan={schemaVersion:1,operationId:randomUUID(),source,from,to:to as PairedConnectionRecord,expiresAt:new Date(+(deps.now?.()||new Date())+300000).toISOString(),snapshot:await snapshot(c,from,to),canApply:true,status:'preview'};
  await atomicBytes(await safePath(c.installRoot,planFile(c,result.operationId)),jsonBytes(result));return result;
 },deps);
}
async function stopBus(c:InstallContext,r:ConnectionRecord,deps:SwitchDeps){
 const state=connectionState(c,r.connectionId);let h;
 try{h=await inspectService(state);}catch(e:any){
  if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw Error('service_shutdown_unconfirmed');
  const b=await optional(await safePath(c.installRoot,path.join(c.installRoot,'install','runtime-active.json')));
  if(b){const m=JSON.parse(b.toString());if(m.stateRoot===path.resolve(state)&&!deadPid(m.pid))throw Error('service_shutdown_unconfirmed');}return;
 }
 if(h.status!=='running')throw Error('service_storage_requires_check');
 if((await(deps.shutdown||shutdownService)(h)).status!=='closed')throw Error('service_shutdown_unconfirmed');
}
export async function applyConnectionSwitch(c:InstallContext,source:SourceRef,id:string,operationId:string,deps:SwitchDeps={}):Promise<PairedConnectionRecord>{
 return withPairState(c,async tx=>{
  await assertNoConnectionSwitch(c);if(tx.state.activations.some(a=>a.phase!=='paired'))throw Error('pairing_activation_requires_check');
  const bytes=await readFile(await safePath(c.installRoot,planFile(c,operationId)));if(bytes.length>262144)throw Error('switch_preview_changed');const plan:SwitchPlan=JSON.parse(bytes.toString());
  if(plan.schemaVersion!==1||plan.operationId!==operationId||plan.to?.connectionId!==id||plan.source?.provider!==source.provider||plan.source?.sessionId!==source.sessionId)throw Error('source_session_mismatch');
  const from=await current(c),to=await readConnection(c,id);verifyCaller(to,source);
  if(plan.status==='applied'){if(from?.connectionId!==id||from.phase!=='paired'||from.schemaVersion!==2)throw Error('switch_preview_changed');await inspectConnectionRoutes(c,from);await inspectConnectionBindings(c,from);return from;}
  if(plan.status!=='preview'||!Number.isFinite(Date.parse(plan.expiresAt)))throw Error('switch_preview_changed');if(+(deps.now?.()||new Date())>=Date.parse(plan.expiresAt))throw Error('switch_preview_expired');
  if(JSON.stringify(await snapshot(c,from,to))!==JSON.stringify(plan.snapshot))throw Error('switch_preview_changed');
  await validateSwitch(c,source,from,to,deps);
  const guard=await safePath(c.installRoot,transitionFile(c));await atomicBytes(guard,jsonBytes({schemaVersion:1,operationId,from:from?.connectionId,to:id,phase:'switching'}));await deps.afterSwitchStep?.('guard_written');
  // Every admission entry checks the durable guard. Stop the two Bus services,
  // wait for in-flight writes, then read the queues again before changing routes.
  if(from&&from.phase!=='disconnected')await stopBus(c,from,deps);await stopBus(c,to,deps);await deps.afterSwitchStep?.('services_stopped');
  if(JSON.stringify(await snapshot(c,from,to))!==JSON.stringify(plan.snapshot))throw Error('switch_preview_changed');await validateSwitch(c,source,from,to,deps);
  const routes={schemaVersion:1,routes:(['codex','claude'] as const).map(provider=>({provider,sessionId:to[provider].sessionId,connectionId:id}))};
  await atomicBytes(await safePath(c.installRoot,path.join(c.installRoot,'routes.json')),jsonBytes(routes));await deps.afterSwitchStep?.('routes_written');
  if(from&&from.connectionId!==id&&from.phase!=='disconnected')await atomicBytes(recordFile(c,from.connectionId),jsonBytes({...from,phase:'disconnected'}));
  const restored={...to,phase:'paired' as const} as PairedConnectionRecord;await atomicBytes(recordFile(c,id),jsonBytes(restored));await atomicBytes(path.join(c.installRoot,'active-connection.json'),jsonBytes({connectionId:id}));await deps.afterSwitchStep?.('active_written');
  await atomicBytes(planFile(c,operationId),jsonBytes({...plan,status:'applied'}));await unlink(guard);return restored;
 },deps);
}
