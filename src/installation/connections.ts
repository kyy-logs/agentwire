import path from 'node:path';import {readFile,open,unlink} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {assertId,realClock} from '../model.ts';import type {MessageRecord} from '../model.ts';import {requestBus} from '../ipc.ts';import {FileMessageStore} from '../store.ts';import {FileLifecycleStore} from '../lifecycle/store.ts';
import {discoverCandidates} from './discovery.ts';import {ensureService,serviceHealth,shutdownService} from './service.ts';import {optional,atomicBytes,jsonBytes,resolveLayout,safePath,acquireLock,assertNoConnectionSwitch,deadPid} from './paths.ts';import type {Candidate,ConnectionRecord,PairedConnectionRecord,InstallContext,SourceRef,Provider} from './model.ts';import type {PairActivation,PairDeps} from '../pairing/model.ts';
import {withPairState} from '../pairing/store.ts';import {assertPairAdmission,pairEndpoints} from '../pairing/health.ts';
type Deps=PairDeps&{shutdown?:typeof shutdownService;connectionId?:string;archive?:boolean};
const terminal=new Set(['completed','delivered','failed','expired','stopped']);
const stateFor=(c:InstallContext,id:string)=>{assertId(id);return path.join(resolveLayout(c).connections,id,'state');};
const recordFor=(c:InstallContext,id:string)=>{assertId(id);return path.join(resolveLayout(c).connections,id,'connection.json');};
export async function readConnection(c:InstallContext,id:string):Promise<ConnectionRecord>{const f=await safePath(c.installRoot,recordFor(c,id)),r=JSON.parse(await readFile(f,'utf8'));if(![1,2].includes(r.schemaVersion)||r.connectionId!==id)throw Error('invalid_connection');for(const p of ['codex','claude']){if(r[p]?.provider!==p||!path.isAbsolute(r[p]?.workspaceRoot||''))throw Error('invalid_connection');assertId(r[p].sessionId);}
 if(typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))throw Error('invalid_connection');
 if(r.schemaVersion===1){assertId(r.probeIds?.forward);assertId(r.probeIds?.reverse);}else{if(r.admissionMode!=='identity-pair-v1'||r.pairing?.identity!=='confirmed'||!['pairing','paired','offline','needs_check','disconnected'].includes(r.phase)||'probeIds'in r)throw Error('invalid_connection');assertId(r.pairing.activationId);}return r;}
const load=readConnection;
async function save(c:InstallContext,r:ConnectionRecord){await safePath(c.installRoot,recordFor(c,r.connectionId));await atomicBytes(recordFor(c,r.connectionId),jsonBytes(r));return r;}
async function activeId(c:InstallContext){const b=await optional(path.join(c.installRoot,'active-connection.json'));if(!b)throw Error('not_connected');const id=JSON.parse(b.toString()).connectionId;assertId(id);return id;}
/** allowTransition is for read-only diagnostics, never admission. */
export async function activeConnection(c:InstallContext,allowTransition=false){if(!allowTransition)await assertNoConnectionSwitch(c);return load(c,await activeId(c));}
async function call(state:string,op:string,payload?:unknown){const r=await requestBus(state,{requestId:randomUUID(),op,payload});if(!r.ok)throw Error(r.errorCode||'bus_request_rejected');return r.data;}
function verifySource(r:ConnectionRecord,source:SourceRef){if(!['codex','claude'].includes(source.provider)||r[source.provider].sessionId!==source.sessionId)throw Error('source_session_mismatch');}
async function changeRoutes(c:InstallContext,r:ConnectionRecord,remove=false){const l=resolveLayout(c),b=await optional(l.routes),current=b?JSON.parse(b.toString()):{schemaVersion:1,routes:[]};if(current.schemaVersion!==1||!Array.isArray(current.routes))throw Error('invalid_routes');const routes=current.routes.filter((x:any)=>x.connectionId!==r.connectionId);if(!remove)for(const provider of ['codex','claude'] as const){if(routes.some((x:any)=>x.provider===provider&&x.sessionId===r[provider].sessionId))throw Error('session_already_routed');routes.push({provider,sessionId:r[provider].sessionId,connectionId:r.connectionId});}await safePath(l.root,l.routes);await atomicBytes(l.routes,jsonBytes({schemaVersion:1,routes}));}
export function sameChat(a:Candidate,b:Candidate){return a.provider===b.provider&&a.sessionId===b.sessionId&&path.relative(a.workspaceRoot,b.workspaceRoot)==='';}
export function samePair(r:ConnectionRecord,a:Pick<PairActivation,'codex'|'claude'>){return sameChat(r.codex,a.codex)&&sameChat(r.claude,a.claude);}
/** Internal only: caller holds connection.lock throughout activation/recovery. */
export async function checkPairedRoutesLocked(c:InstallContext,a:Pick<PairActivation,'connectionId'|'codex'|'claude'>){
 await assertNoConnectionSwitch(c);
 const f=await safePath(c.installRoot,resolveLayout(c).routes),bytes=await optional(f);if(!bytes)return;
 if(bytes.length>262144)throw Error('pairing_activation_requires_check');let r;try{r=JSON.parse(bytes.toString());}catch{throw Error('pairing_activation_requires_check');}
 if(r.schemaVersion!==1||!Array.isArray(r.routes)||r.routes.length>2)throw Error('pairing_activation_requires_check');const seen=new Set();
 for(const route of r.routes){if(!route||!['codex','claude'].includes(route.provider)||route.connectionId!==a.connectionId||route.sessionId!==a[route.provider as Provider].sessionId||seen.has(route.provider))throw Error('pairing_activation_requires_check');seen.add(route.provider);}
}
/** Completed identity is historical; current routing must still match before a
 * recovery is called successful or a new message is accepted. Missing completed
 * infrastructure pauses for inspection rather than recreating unknown routes. */
export async function assertPairedInfrastructureLocked(c:InstallContext,r:ConnectionRecord){
 try{
  const current=await activeConnection(c);if(current.connectionId!==r.connectionId||!samePair(current,r))throw Error('conflict');
  await checkPairedRoutesLocked(c,r);const routes=JSON.parse((await readFile(await safePath(c.installRoot,resolveLayout(c).routes))).toString());if(routes.routes.length!==2)throw Error('missing_routes');
  if(r.schemaVersion===1)return; // Legacy selection need not have started a Bus.
  if(!['paired','offline'].includes(r.phase))throw Error('incomplete_connection');
  const file=await safePath(c.installRoot,path.join(stateFor(c,r.connectionId),'bindings.json')),bytes=await readFile(file);if(bytes.length>262144)throw Error('bindings_limit');const saved=JSON.parse(bytes.toString());if(saved.schemaVersion!==1||!Array.isArray(saved.bindings)||saved.bindings.length!==2)throw Error('missing_bindings');
  const seen=new Set();for(const b of saved.bindings){if(!b||!['codex','claude'].includes(b.agentId)||b.kind!==b.agentId||b.sessionId!==r[b.agentId as Provider].sessionId||typeof b.workspaceRoot!=='string'||path.relative(b.workspaceRoot,r[b.agentId as Provider].workspaceRoot)!==''||seen.has(b.agentId))throw Error('binding_conflict');seen.add(b.agentId);}
 }catch{throw Error('pairing_activation_requires_check');}
}
/** Never called outside a withPairState transaction. No Agent messages/probes. */
export async function activatePairedConnectionLocked(c:InstallContext,a:PairActivation,deps:PairDeps={}):Promise<PairedConnectionRecord>{
 await checkPairedRoutesLocked(c,a);let r:PairedConnectionRecord;
 try{const prior=await load(c,a.connectionId);if(prior.schemaVersion!==2||prior.pairing.activationId!==a.activationId||!samePair(prior,a)||!['pairing','paired','offline'].includes(prior.phase))throw Error('pairing_activation_requires_check');r=prior;}
 catch(e:any){if(e.code!=='ENOENT')throw e;r={schemaVersion:2,admissionMode:'identity-pair-v1',connectionId:a.connectionId,phase:'pairing',codex:a.codex,claude:a.claude,createdAt:a.createdAt,pairing:{activationId:a.activationId,identity:'confirmed'}};await save(c,r);}
 await deps.afterStep?.('connection_written');const state=stateFor(c,a.connectionId);await (deps.ensure||ensureService)(c,state);
 const health=await call(state,'health');if(!Array.isArray(health.bindings))throw Error('pairing_activation_requires_check');const seen=new Set();
 for(const b of health.bindings){if(!b||!['codex','claude'].includes(b.agentId)||b.kind!==b.agentId||b.sessionId!==a[b.agentId as Provider].sessionId||typeof b.workspaceRoot!=='string'||path.relative(b.workspaceRoot,a[b.agentId as Provider].workspaceRoot)!==''||seen.has(b.agentId))throw Error('pairing_activation_requires_check');seen.add(b.agentId);}
 for(const p of ['codex','claude'] as const)await call(state,'bind',{agentId:p,kind:p,sessionId:a[p].sessionId,workspaceRoot:a[p].workspaceRoot});await deps.afterStep?.('bound');
 await checkPairedRoutesLocked(c,a);await changeRoutes(c,r);await deps.afterStep?.('routes_written');
 let active:ConnectionRecord|undefined;try{active=await activeConnection(c);}catch(e:any){if(e.message!=='not_connected')throw e;}
 if(active&&active.phase!=='disconnected'&&(active.connectionId!==a.connectionId||!samePair(active,a)))throw Error('pairing_activation_requires_check');
 const pointer=await safePath(c.installRoot,path.join(c.installRoot,'active-connection.json'));await atomicBytes(pointer,jsonBytes({connectionId:a.connectionId}));await deps.afterStep?.('active_written');r.phase='paired';delete r.errorCode;await save(c,r);await deps.afterStep?.('connection_paired');return r;
}
export async function selectConnection(c:InstallContext,source:SourceRef,peer:Candidate,options:{self?:Candidate;probeWireVersion?:'legacy'|'clean-v1'}={}):Promise<ConnectionRecord>{
 assertId(source.sessionId);assertId(peer.sessionId);if(!['codex','claude'].includes(peer.provider)||peer.provider===source.provider||!path.isAbsolute(peer.workspaceRoot))throw Error('invalid_peer');
 const l=resolveLayout(c);await safePath(l.root,l.root);const {mkdir}=await import('node:fs/promises');await mkdir(l.root,{recursive:true});const release=await acquireLock(path.join(l.root,'connection.lock'));
 try{let old:ConnectionRecord|undefined;try{old=await activeConnection(c);}catch(e:any){if(e.message!=='not_connected')throw e;}if(old&&old.phase!=='disconnected'){if(old[source.provider]?.sessionId===source.sessionId&&old[peer.provider]?.sessionId===peer.sessionId)return old;throw Error('active_connection_exists');}
 const self=options.self||(await discoverCandidates(c,source.provider)).find(x=>x.sessionId===source.sessionId);if(!self||self.sessionId!==source.sessionId||self.provider!==source.provider||!path.isAbsolute(self.workspaceRoot))throw Error('source_candidate_unavailable');
 const now=new Date(),r:ConnectionRecord={schemaVersion:1,connectionId:randomUUID(),phase:'selected',probeWireVersion:options.probeWireVersion||'clean-v1',codex:(source.provider==='codex'?self:peer),claude:(source.provider==='claude'?self:peer),probeIds:{forward:randomUUID(),reverse:randomUUID()},createdAt:now.toISOString(),probeDeadlineAt:new Date(+now+120000).toISOString()};await save(c,r);await changeRoutes(c,r);await atomicBytes(path.join(l.root,'active-connection.json'),jsonBytes({connectionId:r.connectionId}));return r;
 }finally{await release();}
}
export async function beginProbes(c:InstallContext,id:string,deps:Deps={}):Promise<ConnectionRecord>{
 await assertNoConnectionSwitch(c);
 const r=await load(c,id);if(r.phase==='disconnected')throw Error('connection_disconnected');if(r.schemaVersion===2)return inspectConnection(c,id,deps);if(r.phase==='ready')return inspectConnection(c,id,deps);if(r.phase==='needs_check')return inspectConnection(c,id,deps);
 const state=stateFor(c,id);await (deps.ensure||ensureService)(c,state);for(const p of ['codex','claude'] as const)await call(state,'bind',{agentId:p,kind:p,sessionId:r[p].sessionId,workspaceRoot:r[p].workspaceRoot});
 r.phase='probing';await save(c,r);
 for(const [direction,from,to] of [['forward','codex','claude'],['reverse','claude','codex']] as const){const messageId=r.probeIds[direction];if(await new FileMessageStore(state,realClock).get(messageId))continue;try{await call(state,'accept',{messageId,kind:'task',from,to,returnMode:'auto',body:r.probeWireVersion==='clean-v1'?'连接测试：仅计算23×29，正常回答一行667。不要使用工具、修改文件或发起任务；程序自动回传。':'LOCALBUS-CONNECT '+messageId+'：仅计算23×29，正常回答一行 LOCALBUS-CONNECT '+messageId+' 667。不要使用工具、修改文件或发起任务；程序自动回传。'});}catch(e:any){r.phase='needs_check';r.errorCode=/^[a-z_]+$/.test(e.message)?e.message:'probe_accept_unconfirmed';await save(c,r);return r;}}
 return r;
}
export async function inspectConnection(c:InstallContext,id:string,deps:Deps={}):Promise<ConnectionRecord>{
 const r=await load(c,id);if(r.schemaVersion===2||['selected','awaiting_native_trust','disconnected'].includes(r.phase)||r.errorCode==='native_work_may_continue_keep_routes')return r;const state=stateFor(c,id),store=new FileMessageStore(state,realClock),life=new FileLifecycleStore(state);let complete=true;
 for(const messageId of Object.values(r.probeIds)){const parent=await store.get(messageId),result=await life.getResult(messageId);if(!parent?.resultRef||!result){complete=false;continue;}const reply=await store.get(parent.resultRef);if(parent.state!=='completed'||parent.completion?.nativeOutcome!=='response_ended'||result.body.trim()!==(r.probeWireVersion==='clean-v1'?'667':'LOCALBUS-CONNECT '+messageId+' 667')||reply?.state!=='delivered'||!reply.receipt?.evidenceRef){complete=false;continue;}const execution=await life.getExecution(result.ref);if(r.probeWireVersion==='clean-v1'&&parent.message.schemaVersion!==2){complete=false;continue;}if(execution?.messageId!==messageId||execution.phase==='needs_check'||result.ref.sessionId!==parent.message.targetSessionId){complete=false;}}
 if(complete){r.phase='ready';delete r.errorCode;}else if(+(deps.now?.()||new Date())>Date.parse(r.probeDeadlineAt)){r.phase='needs_check';r.errorCode='connection_probe_unconfirmed';}await save(c,r);return r;
}
async function sendPaired(c:InstallContext,r:PairedConnectionRecord,source:SourceRef,target:Provider,payload:unknown,deps:Deps):Promise<MessageRecord>{
 return withPairState(c,async tx=>{const current=await activeConnection(c);if(current.connectionId!==r.connectionId||current.schemaVersion!==2)throw Error('retry_connection_changed');verifySource(current,source);assertPairAdmission(tx,current);const endpoint=await pairEndpoints(c,current,deps);
  if(endpoint[target]==='offline'||target==='claude'&&endpoint[target]!=='detected')throw Error('pairing_target_unavailable');await assertPairedInfrastructureLocked(c,current);await(deps.ensure||ensureService)(c,stateFor(c,r.connectionId));return call(stateFor(c,r.connectionId),'accept',payload);
 },deps);
}
async function sendLegacy(c:InstallContext,r:ConnectionRecord,source:SourceRef,payload:unknown,deps:Deps){
 const release=await acquireLock(path.join(c.installRoot,'connection.lock'));try{const current=await activeConnection(c);if(current.connectionId!==r.connectionId)throw Error('retry_connection_changed');verifySource(current,source);await(deps.ensure||ensureService)(c,stateFor(c,r.connectionId));if((await inspectConnection(c,r.connectionId,deps)).phase!=='ready')throw Error('connection_not_ready');return await call(stateFor(c,r.connectionId),'accept',payload);}finally{await release();}
}
export async function askPeer(c:InstallContext,source:SourceRef,target:Provider,body:string,outboundId:string,deps:Deps={}):Promise<MessageRecord>{const r=await activeConnection(c);if(deps.connectionId&&deps.connectionId!==r.connectionId)throw Error('retry_connection_changed');verifySource(r,source);if(target===source.provider||!['codex','claude'].includes(target))throw Error('invalid_peer');if(r.phase==='disconnected')throw Error('not_connected');const payload={messageId:outboundId,kind:'task',from:source.provider,to:target,returnMode:'auto',body};if(r.schemaVersion===2)return sendPaired(c,r,source,target,payload,deps);return sendLegacy(c,r,source,payload,deps);}
export async function followupPeer(c:InstallContext,source:SourceRef,replyId:string,body:string,outboundId:string,deps:Deps={}):Promise<MessageRecord>{const r=await activeConnection(c);if(deps.connectionId&&deps.connectionId!==r.connectionId)throw Error('retry_connection_changed');verifySource(r,source);const payload={messageId:outboundId,kind:'followup',from:source.provider,replyTo:replyId,body};if(r.schemaVersion===2)return sendPaired(c,r,source,source.provider==='codex'?'claude':'codex',payload,deps);return sendLegacy(c,r,source,payload,deps);}
export async function disconnect(c:InstallContext,id:string,stopRequested=false,deps:Deps={}):Promise<ConnectionRecord>{await safePath(c.installRoot,c.installRoot);const release=await acquireLock(path.join(c.installRoot,'connection.lock'));try{await assertNoConnectionSwitch(c);return await disconnectLocked(c,id,stopRequested,deps);}finally{await release();}}
async function disconnectLocked(c:InstallContext,id:string,stopRequested=false,deps:Deps={}):Promise<ConnectionRecord>{const r=await load(c,id),state=stateFor(c,id),records=await new FileMessageStore(state,realClock).list(),unfinished=records.filter(x=>!terminal.has(x.state));if(unfinished.length&&!stopRequested)throw Error('unfinished_tasks');if(unfinished.length){for(const taskId of new Set(unfinished.map(x=>x.message.taskId)))await call(state,'stop',{taskId});}
 const {inspectConnectionWork}=await import('./connection-management.ts');
 const work=await inspectConnectionWork(c,id);if(work.artifactsPending)throw Error('connection_storage_requires_check');if(work.unfinished||work.uncertain)throw Error('unfinished_tasks');
 if(work.nativeOutstanding&&!deps.archive){r.phase='needs_check';r.errorCode='native_work_may_continue_keep_routes';return save(c,r);}
 // The existing admission guard covers direct IPC as well as normal clients.
 // Retain it on interrupted/unconfirmed disconnect, just as for a switch.
 const guard=await safePath(c.installRoot,path.join(c.installRoot,'connection-transition.json')),marker=jsonBytes({schemaVersion:1,operationId:randomUUID(),from:id,phase:'disconnecting'});await atomicBytes(guard,marker);
 try{const h=await serviceHealth(state);if((await (deps.shutdown||shutdownService)(h)).status!=='closed')throw Error('service_shutdown_unconfirmed');}catch(e:any){if(e.message==='service_shutdown_unconfirmed')throw e;if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;
  // IPC closes before in-flight writes and process exit. An unavailable socket
  // cannot retire the routes while its managed service might still be running.
  const bytes=await optional(await safePath(c.installRoot,path.join(c.installRoot,'install','runtime-active.json')));
  if(bytes){const marker=JSON.parse(bytes.toString());if(marker.stateRoot===path.resolve(state)&&!deadPid(marker.pid))throw Error('service_shutdown_unconfirmed');}
 }
 const after=await inspectConnectionWork(c,id);if(after.artifactsPending)throw Error('connection_storage_requires_check');if(after.unfinished||after.uncertain)throw Error('unfinished_tasks');
 if(after.nativeOutstanding&&!deps.archive){r.phase='needs_check';r.errorCode='native_work_may_continue_keep_routes';return save(c,r);}
 await changeRoutes(c,r,true);r.phase='disconnected';delete r.errorCode;await save(c,r);
 const actual=await optional(guard);if(!actual?.equals(marker))throw Error('connection_switch_requires_check');await unlink(guard);return r;}
