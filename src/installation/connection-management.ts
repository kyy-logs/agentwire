import path from 'node:path';
import {readdir,readFile} from 'node:fs/promises';
import {assertId,realClock} from '../model.ts';
import {FileMessageStore} from '../store.ts';
import {FileLifecycleStore} from '../lifecycle/store.ts';
import {validateExecution} from '../lifecycle/model.ts';
import {IdentityStore} from '../native/identity-store.ts';
import {activeConnection,readConnection} from './connections.ts';
import {safePath} from './paths.ts';
import {pairEndpoints} from '../pairing/health.ts';
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
 const native=new IdentityStore(root,realClock);
 for(const e of await names(c,native.root)){
  if(e.name==='quarantine'||e.name.endsWith('.tmp')){work.artifactsPending++;continue;}if(!e.isFile()||!e.name.endsWith('.json'))throw Error('connection_storage_requires_check');
  await safePath(c.installRoot,path.join(native.root,e.name));const i=await native.get(e.name.slice(0,-5));if(!i)throw Error('connection_storage_requires_check');
  const r=records.get(i.messageId),settled=r&&(r.resultRef||r.message.kind==='reply'&&r.state==='delivered'&&r.receipt?.status==='accepted'&&r.receipt.evidenceRef);
  if(i.phase==='needs_check'||!['not_written','reply_committed','delivered'].includes(i.phase)&&!settled)work.nativeOutstanding++;
 }
 for(const dir of ['quarantine','lifecycle/inbox','lifecycle/quarantine','lifecycle/conflicts'])work.artifactsPending+=(await names(c,path.join(root,dir))).length;
 for(const e of await names(c,path.join(root,'lifecycle','executions'))){
  if(!e.isFile()||!e.name.endsWith('.json')){work.artifactsPending++;continue;}
  const file=await safePath(c.installRoot,path.join(root,'lifecycle','executions',e.name));const execution=JSON.parse(await readFile(file,'utf8'));validateExecution(execution);if(execution.phase!=='applied')work.artifactsPending++;
 }
 return work;
}
export async function listConnections(c:InstallContext,source:SourceRef,deps:PairDeps={}){
 if(!['codex','claude'].includes(source.provider))throw Error('source_provider_invalid');assertId(source.sessionId);
 let current:ConnectionRecord|undefined;const errors:{connectionId?:string;code:string}[]=[];
 try{current=await activeConnection(c);}catch(e:any){if(e.message!=='not_connected')errors.push({code:e.message});}
 const connections:any[]=[];
 for(const e of await names(c,path.join(c.installRoot,'connections'))){
  if(!isId(e.name))continue;
  try{
   const r=await readConnection(c,e.name);if(r[source.provider].sessionId!==source.sessionId)continue;
   const view:any={...r,active:current?.connectionId===r.connectionId,endpoint:await pairEndpoints(c,r as PairedConnectionRecord,deps)};
   try{view.work=await inspectConnectionWork(c,r.connectionId);}catch{view.errorCode='connection_storage_requires_check';}
   connections.push(view);
  }catch{errors.push({connectionId:e.name,code:'invalid_connection'});}
 }
 connections.sort((a,b)=>Number(b.active)-Number(a.active)||a.createdAt.localeCompare(b.createdAt)||a.connectionId.localeCompare(b.connectionId));
 return {current,connections,errors};
}
