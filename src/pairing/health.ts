import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {safePath} from '../installation/paths.ts';
import {realClock} from '../model.ts';
import {FileMessageStore} from '../store.ts';
import {FileLifecycleStore} from '../lifecycle/store.ts';
import {digest} from '../lifecycle/model.ts';
import {IdentityStore} from '../native/identity-store.ts';
import {discoverCandidates} from '../installation/discovery.ts';
import type {InstallContext,PairedConnectionRecord} from '../installation/model.ts';
import type {PairDeps,PairHealth,PairTransaction} from './model.ts';
export async function pairEndpoints(c:InstallContext,r:PairedConnectionRecord,deps:PairDeps={}):Promise<PairHealth['endpoint']>{
 const endpoint:PairHealth['endpoint']={codex:'unknown',claude:'unknown'};
 for(const p of ['codex','claude'] as const){try{const matches=(await(deps.discover||discoverCandidates)(c,p,r[p].sessionId)).filter(x=>x.sessionId===r[p].sessionId);
  if(matches.length===1&&path.relative(matches[0].workspaceRoot,r[p].workspaceRoot)===''&&matches[0].availability==='live_endpoint')endpoint[p]='detected';else if(!matches.length&&p==='claude')endpoint[p]='offline';
 }catch{/* A failed scan or ambiguous endpoint is unknown, never detected. */}}
 return endpoint;
}
export function assertPairAdmission(tx:PairTransaction,r:PairedConnectionRecord){
 if(!['paired','offline'].includes(r.phase)||r.errorCode||tx.state.activations.some(a=>a.connectionId===r.connectionId&&a.phase!=='paired'))throw Error('connection_not_ready');
 const a=tx.state.activations.find(a=>a.activationId===r.pairing.activationId);
 if(a&&(a.connectionId!==r.connectionId||a.codex.sessionId!==r.codex.sessionId||a.claude.sessionId!==r.claude.sessionId))throw Error('pairing_activation_requires_check');
 // Completed ledger families expire after 24h; the full paired connection
 // remains durable. An unfinished family is retained and always blocks sends.
}
export async function inspectPairHealth(c:InstallContext,r:PairedConnectionRecord,deps:PairDeps={}):Promise<PairHealth>{
 const health:PairHealth={identity:'confirmed',endpoint:await pairEndpoints(c,r,deps),roundtrip:{codex_to_claude:{status:'untested'},claude_to_codex:{status:'untested'}}};
 const root=path.join(c.installRoot,'connections',r.connectionId,'state'),messages=new FileMessageStore(root,realClock),life=new FileLifecycleStore(root),native=new IdentityStore(root,realClock);
 const directory=await safePath(c.installRoot,path.join(root,'messages'));let files:string[];try{files=await readdir(directory);}catch(e:any){if(e.code!=='ENOENT')throw e;files=[];}
 for(const name of files.filter(n=>n.endsWith('.json')).sort()){
  await safePath(c.installRoot,path.join(directory,name));const parent=await messages.get(name.slice(0,-5));if(!parent)throw Error('connection_storage_requires_check');
  const m=parent.message;if(m.schemaVersion!==2||m.kind==='reply'||!['codex','claude'].includes(m.from)||!['codex','claude'].includes(m.to)||m.sourceSessionId!==r[m.from as 'codex'|'claude'].sessionId||m.targetSessionId!==r[m.to as 'codex'|'claude'].sessionId||parent.state!=='completed'||parent.completion?.nativeOutcome!=='response_ended'||!parent.activeAttemptId||!parent.resultRef)continue;
  const result=await life.getResult(m.messageId),i=await native.get(parent.activeAttemptId),reply=await messages.get(parent.resultRef);
  if(!result||result.nativeOutcome!=='response_ended'||result.ref.provider!==m.to||result.ref.sessionId!==m.targetSessionId||!i||i.connectionId!==r.connectionId||i.messageId!==m.messageId||i.provider!==m.to||i.targetSessionId!==m.targetSessionId||i.sourceSessionId!==m.sourceSessionId||i.bodySha256!==digest(m.body)||i.nativeExecutionId!==result.ref.nativeExecutionId||i.phase!=='reply_committed'||!reply?.activeAttemptId)continue;
  const execution=await life.getExecution(result.ref),back=reply.message,j=await native.get(reply.activeAttemptId);
  if(!execution||execution.phase!=='applied'||execution.messageId!==m.messageId||execution.replyMessageId!==back.messageId||execution.dispatchNonce!==parent.dispatchNonce||execution.terminalEventKey!==result.terminalEventKey||parent.completion.eventKey!==result.terminalEventKey||parent.completion.sha256!==result.sha256||await life.hasConflict(result.ref))continue;
  if(back.schemaVersion!==2||back.kind!=='reply'||back.replyTo!==m.messageId||back.taskId!==m.taskId||back.from!==m.to||back.to!==m.from||back.sourceSessionId!==m.targetSessionId||back.targetSessionId!==m.sourceSessionId||reply.state!=='delivered'||reply.receipt?.status!=='accepted'||!reply.receipt.evidenceRef||!j||!['queued','mapped','needs_check'].includes(j.phase)||j.connectionId!==r.connectionId||j.messageId!==back.messageId||j.provider!==m.from||j.targetSessionId!==m.sourceSessionId||j.sourceSessionId!==m.targetSessionId||j.bodySha256!==digest(back.body)||['native_binding_conflict','multiple_native_executions'].includes(j.errorCode||''))continue;
  const direction=m.from==='codex'?'codex_to_claude':'claude_to_codex';health.roundtrip[direction]={status:'observed',messageId:m.messageId,observedAt:reply.updatedAt};
 }
 return health;
}
