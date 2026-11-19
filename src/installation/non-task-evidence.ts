import path from 'node:path';
import {open,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {InstallContext,Provider} from './model.ts';
import type {LifecycleEvent} from '../lifecycle/model.ts';
import {FileLifecycleStore,validateCleanHint} from '../lifecycle/store.ts';
import {validateEvent} from '../lifecycle/model.ts';
import {validateIntent} from '../native/identity-store.ts';
import {safePath} from './paths.ts';
import {readConnection} from './connections.ts';
import {inspectConnectionWork} from './connection-management.ts';

export type NonTaskProof={evidenceRef:string;snapshotSha256:string;inputCount:number;nativeOutcome:'response_ended'|'interrupted'};
type Witness={file:string;size:number;mtimeMs:number;ino:number};
type Scan={proofs:Map<string,NonTaskProof>;files:Witness[]};
const ENTRY_LIMIT=20000,FILE_LIMIT=128,BYTE_LIMIT=256*1024*1024,LINE_LIMIT=16*1024*1024;
async function jsonFiles(dir:string){try{const names=await readdir(dir,{withFileTypes:true});if(names.length>10000||names.some(e=>!e.isFile()||!e.name.endsWith('.json')))throw Error('non_task_evidence_invalid');const rows=[];for(const e of names){const file=await safePath(dir,path.join(dir,e.name)),h=await open(file,'r');try{if((await h.stat()).size>1048576)throw Error('non_task_evidence_limit');rows.push(JSON.parse(await h.readFile('utf8')));}finally{await h.close();}}return rows;}catch(e:any){if(e.code==='ENOENT')return [];throw e;}}
/** Exact session filenames only; never select a newest chat or inspect text to
 * infer a task. Complete bounded enumeration is necessary to reject duplicates. */
async function nativeFiles(c:InstallContext,p:Provider,session:string){
 const root=path.join(c.home,p==='codex'?'.codex':'.claude',p==='codex'?'sessions':'projects'),out:string[]=[];let count=0;
 async function walk(dir:string,depth:number){let entries;try{entries=await readdir(await safePath(root,dir),{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw e;}
  for(const e of entries){if(++count>ENTRY_LIMIT)throw Error('non_task_evidence_limit');if(e.isSymbolicLink())throw Error('non_task_evidence_symlink');const file=path.join(dir,e.name);if(e.isDirectory()){if(depth>=6)throw Error('non_task_evidence_limit');await walk(file,depth+1);}else if(e.isFile()&&e.name.endsWith('.jsonl')&&(p==='claude'?e.name===session+'.jsonl':e.name.includes(session))){out.push(await safePath(root,file));if(out.length>FILE_LIMIT)throw Error('non_task_evidence_limit');}}
 }await walk(root,0);return out.sort();
}
async function stableScan(c:InstallContext,p:Provider,session:string,files:Witness[]){
 const current=await nativeFiles(c,p,session);if(current.length!==files.length||current.some((f,n)=>f!==files[n].file))return false;
 for(const w of files){const s=await stat(w.file);if(s.size!==w.size||s.mtimeMs!==w.mtimeMs||s.ino!==w.ino)return false;}return true;
}

async function nativeProofs(c:InstallContext,p:Provider,session:string,cwd:string,targets:Set<string>):Promise<Scan>{
 const found=new Map<string,NonTaskProof[]>(),seen=new Map<string,number>(),files:Witness[]=[];let total=0;
 for(const file of await nativeFiles(c,p,session)){
  const handle=await open(file,'r');
  try{
   const before=await handle.stat();if(!before.isFile()||!before.size||(total+=before.size)>BYTE_LIMIT)throw Error('non_task_evidence_limit');
   files.push({file,size:before.size,mtimeMs:before.mtimeMs,ino:before.ino});
   const turns=new Map<string,{starts:any[];inputs:any[];ends:any[];tools:number;cwd:string|undefined}>();for(const id of targets)turns.set(id,{starts:[],inputs:[],ends:[],tools:0,cwd:undefined});
   let current:string|undefined,meta:any,metas=0;const hash=createHash('sha256');let pending=Buffer.alloc(0);
   const row=(line:Buffer)=>{
    if(line.length>LINE_LIMIT)throw Error('non_task_evidence_limit');const r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)),v=r.payload||{};
    if(p==='claude'){
     if(r.type==='user'&&r.sessionId===session&&targets.has(r.promptId)&&typeof r.message?.content==='string')turns.get(r.promptId)!.inputs.push(r);
     // Array text is also native human content; tool-result continuations are
     // excluded only by their native block types, never by their wording.
     else if(r.type==='user'&&r.sessionId===session&&targets.has(r.promptId)&&Array.isArray(r.message?.content)&&r.message.content.some((b:any)=>b?.type==='text'))turns.get(r.promptId)!.inputs.push(r);
     return;
    }
    if(r.type==='session_meta'){metas++;meta=v;}
    if(r.type==='event_msg'&&v.type==='task_started'){current=v.turn_id;turns.get(current!)?.starts.push(v);}
    if(r.type==='turn_context'&&typeof v.turn_id==='string')current=v.turn_id;
    const t=turns.get(current!);if(!t)return;
    if(r.type==='turn_context')t.cwd=v.cwd;
    if(r.type==='response_item'&&v.type==='message'&&v.role==='user')t.inputs.push(v);
    if(r.type==='response_item'&&['function_call','custom_tool_call','local_shell_call','function_call_output','custom_tool_call_output'].includes(v.type))t.tools++;
    if(r.type==='event_msg'&&['task_complete','turn_aborted'].includes(v.type))t.ends.push(v);
   };
   const stream=handle.createReadStream({start:0,end:before.size-1,autoClose:false});
   for await(const chunk of stream){hash.update(chunk);pending=Buffer.concat([pending,chunk]);let end;while((end=pending.indexOf(10))>=0){row(pending.subarray(0,end));pending=pending.subarray(end+1);}if(pending.length>LINE_LIMIT)throw Error('non_task_evidence_limit');}
   if(pending.length)throw Error('non_task_evidence_incomplete');const after=await handle.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw Error('non_task_evidence_changed');
   if(p==='codex'&&(metas!==1||meta?.id!==session||!['vscode','cli'].includes(meta.source)))throw Error('non_task_evidence_invalid');
   const snapshotSha256=hash.digest('hex');
   for(const [id,t] of turns){if(t.starts.length||t.inputs.length||t.ends.length)seen.set(id,(seen.get(id)||0)+1);let nativeOutcome:NonTaskProof['nativeOutcome']='response_ended';
    if(p==='codex'){
     if(t.starts.length!==1||t.ends.length!==1)continue;const a=t.starts[0].turn_attribution,end=t.ends[0];
     if(!a||a.turn_id!==id||a.turn_trigger!=='composer'||a.parent_turn_id!==null||a.initiating_agent_path!==null||a.root_turn_id!==id||path.relative(path.resolve(t.cwd??meta.cwd),path.resolve(cwd))!==''||end.turn_id!==id)continue;
     nativeOutcome=end.type==='turn_aborted'?'interrupted':'response_ended';
     if(t.inputs.length===0){if(nativeOutcome!=='interrupted'||t.tools!==0)continue;}
     else if(t.inputs.length===1){const input=t.inputs[0],m=input.internal_chat_message_metadata_passthrough;
      if(input.clientId!==undefined||input.client_id!==undefined||!Array.isArray(input.content)||input.content.length!==1||input.content[0]?.type!=='input_text'||typeof input.content[0].text!=='string'||m?.turn_id!==id||!Array.isArray(m.content_item_metadata)||m.content_item_metadata.length!==1||m.content_item_metadata[0]?.provenance?.type!=='user')continue;
     }else continue;
    }else{
     if(t.inputs.length!==1)continue;const input=t.inputs[0];if(input.origin?.kind!=='human'||input.isSidechain!==false||input.agentId!==undefined||typeof input.cwd!=='string'||path.relative(path.resolve(input.cwd),path.resolve(cwd))!==''||!(typeof input.message?.content==='string'||Array.isArray(input.message?.content)&&input.message.content.every((b:any)=>b?.type==='text'&&typeof b.text==='string')))continue;
    }
    const list=found.get(id)||[];list.push({evidenceRef:file+'#'+id,snapshotSha256,inputCount:t.inputs.length,nativeOutcome});found.set(id,list);
   }
  }finally{await handle.close();}
 }
 return {proofs:new Map([...found].filter(([id,v])=>v.length===1&&seen.get(id)===1).map(([id,v])=>[id,v[0]])),files};
}

/** Read-only proof, called under the Bus serial chain. It neither synthesizes
 * task input nor captures output. The processor appends an auditable applied
 * marker; original event/native records and task outcomes are unchanged. */
export function createNonTaskVerifier(c:InstallContext,connectionId:string){
 const cache=new Map<Provider,Scan>(),checked=new Map<Provider,number>();
 return async(e:LifecycleEvent):Promise<NonTaskProof|undefined>=>{
  try{
   validateEvent(e);if(!['stop','interrupt'].includes(e.phase)||e.output!==undefined||e.messageId||e.dispatchNonce||e.inputKind||e.backgroundPending||e.continuation||e.incomplete||e.errorCode!==(e.phase==='interrupt'?'native_interrupt':undefined))return;
   const r=await readConnection(c,connectionId);if(r.schemaVersion!==2||!['paired','ready'].includes(r.phase)||r[e.provider].sessionId!==e.sessionId)return;
   // Legacy tasks may lack native attempt IDs entirely. Never resolve orphan
   // events while any task/message or native execution still needs attention.
   const work=await inspectConnectionWork(c,connectionId);if(work.unfinished||work.uncertain||work.nativeOutstanding)return;
   const root=path.join(c.installRoot,'connections',connectionId,'state'),life=new FileLifecycleStore(root);if(await life.getExecution(e)||await life.hasConflict(e))return;
   const events=await jsonFiles(path.join(root,'lifecycle','events'));for(const v of events)validateEvent(v);
   const exact=events.filter(v=>v.provider===e.provider&&v.sessionId===e.sessionId&&v.nativeExecutionId===e.nativeExecutionId);if(exact.length!==1||exact[0].eventKey!==e.eventKey)return;
   const hints=await jsonFiles(path.join(root,'lifecycle','clean-hints'));for(const h of hints)validateCleanHint(h);const hs=hints.filter(h=>h.provider===e.provider&&h.sessionId===e.sessionId&&h.nativeExecutionId===e.nativeExecutionId);if(hs.length!==1||hs[0].phase!==e.phase||[hs[0].backgroundPending,hs[0].continuation,hs[0].incomplete].some(x=>x!==false))return;
   for(const i of await jsonFiles(path.join(root,'native','attempts'))){validateIntent(i);if(i.connectionId!==connectionId)return;if(i.provider!==e.provider||i.targetSessionId!==e.sessionId)continue;if(i.nativeExecutionId===e.nativeExecutionId||!i.nativeExecutionId&&!['not_written','reply_committed','delivered'].includes(i.phase))return;}
   let scan=cache.get(e.provider);
   // Re-enumerate exact-session files and check every snapshot before consuming
   // any prefetched proof. Replacement, append or new duplicate invalidates all.
   if(scan&&!await stableScan(c,e.provider,e.sessionId,scan.files)){cache.delete(e.provider);scan=undefined;}
   if(!scan&&(Date.now()-(checked.get(e.provider)||0)>5000)){
    checked.set(e.provider,Date.now());const targets=new Set<string>(events.filter(v=>v.provider===e.provider&&v.sessionId===e.sessionId&&v.phase!=='input').map(v=>v.nativeExecutionId));
    scan=await nativeProofs(c,e.provider,e.sessionId,r[e.provider].workspaceRoot,targets);if(!await stableScan(c,e.provider,e.sessionId,scan.files))return;cache.set(e.provider,scan);
   }
   const proof=scan?.proofs.get(e.nativeExecutionId);if(proof&&proof.nativeOutcome===(e.phase==='interrupt'?'interrupted':'response_ended'))return proof;
  }catch{cache.delete(e.provider);return;}
 };
}
