import path from 'node:path';
import {readdir,lstat,open} from 'node:fs/promises';
import {safePath} from '../installation/paths.ts';
import {validateAction} from './model.ts';
import type {ActionEvidenceReader,ActionEvidence,ActionRequest} from './model.ts';
import {proveClaudeAction,proveCodexAction,codexActionCalls} from './native-actions.ts';
const MAX_LINE=2097152,MAX_ROWS=100000,MAX_FILES=64,MAX_FILE=64*1024*1024,MAX_TOTAL=256*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameVersion=(a:any,b:any)=>['ino','dev','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
function codexName(name:string,id:string){if(name===id+'.jsonl'||name.endsWith('-'+id+'.jsonl'))return true;const marker='-'+id+'_',at=name.lastIndexOf(marker);return at>=0&&name.endsWith('.jsonl')&&UUID.test(name.slice(at+marker.length,-6));}
async function scanCodex(file:string,before:any,r:ActionRequest){
 const h=await open(file,'r'),rows:any[]=[];let carry=Buffer.alloc(0),offset=0,count=0;
 try{if(!sameVersion(before,await h.stat({bigint:true})))throw Error('native_file_changed_during_scan');
  const buffer=Buffer.alloc(65536),size=Number(before.size);
  while(offset<size){const n=(await h.read(buffer,0,Math.min(buffer.length,size-offset),offset)).bytesRead;if(!n)throw Error('native_file_changed_during_scan');offset+=n;let bytes=Buffer.concat([carry,buffer.subarray(0,n)]),nl:number;
   while((nl=bytes.indexOf(10))>=0){if(nl>MAX_LINE)throw Error('limit');const line=bytes.subarray(0,nl);bytes=bytes.subarray(nl+1);if(!line.toString('utf8').trim())continue;if(++count>MAX_ROWS)throw Error('limit');const row=JSON.parse(line.toString('utf8')),p=row.type==='response_item'?row.payload:row.payload??row;
    // Keep each proof within its own file. Filtering removes unrelated bodies,
    // never metadata, starts, all exec calls, or tool outputs (including duplicates).
    if(row.type==='session_meta'||p.type==='task_started'||p.name==='exec'&&typeof p.input==='string'||p.output!==undefined)rows.push(row);
   }
   if(bytes.length>MAX_LINE)throw Error('limit');carry=Buffer.from(bytes);
  }
  if(carry.length)throw Error('native_partial_line');
  if(!sameVersion(before,await h.stat({bigint:true}))||!sameVersion(before,await lstat(file,{bigint:true})))throw Error('native_file_changed_during_scan');return rows;
 }finally{await h.close();}
}
export function createNativeActionReader(options:{home:string;launchers:string[]}):ActionEvidenceReader{return {async proveAction(r):Promise<ActionEvidence>{
 try{validateAction(r);const base=path.join(options.home,r.actor.provider==='codex'?'.codex/sessions':'.claude/projects'),matches:string[]=[];let count=0;
 async function visit(dir:string,depth:number){if(depth>8)throw Error('limit');let entries;try{entries=await readdir(await safePath(options.home,dir),{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw e;}for(const ent of entries){if(++count>20000)throw Error('limit');const f=path.join(dir,ent.name);if(ent.isSymbolicLink())throw Error('symlink');if(ent.isDirectory())await visit(f,depth+1);else if(ent.isFile()&&(r.actor.provider==='codex'?codexName(ent.name,r.actor.sessionId):ent.name===r.actor.sessionId+'.jsonl')){matches.push(f);if(matches.length>MAX_FILES)throw Error('limit');}}}
 await visit(base,0);
 if(r.actor.provider==='codex'){
  if(!matches.length)return {status:'unavailable'};
  const files=[];let total=0;for(const name of matches){const file=await safePath(options.home,name),before=await lstat(file,{bigint:true});if(!before.isFile()||before.size>BigInt(MAX_FILE))throw Error('limit');total+=Number(before.size);if(total>MAX_TOTAL)throw Error('limit');files.push({file,before});}
  const proofs:ActionEvidence[]=[];let executions=0;
  for(const {file,before}of files){const rows=await scanCodex(file,before,r),metas=rows.filter(x=>x.type==='session_meta');if(metas.length!==1||metas[0].payload?.id!==r.actor.sessionId||!['vscode','cli'].includes(metas[0].payload?.source))return {status:'unavailable',errorCode:'native_session_identity_unconfirmed'};executions+=codexActionCalls(rows,r,options.launchers).length;if(executions>1)return {status:'conflict',errorCode:'multiple_native_executions'};proofs.push(proveCodexAction(rows,r,options.launchers));}
  // Recheck all snapshots, including earlier segments, before releasing proof.
  for(const {file,before}of files)if(!sameVersion(before,await lstat(file,{bigint:true})))throw Error('native_file_changed_during_scan');
  const blocked=proofs.find(p=>p.status==='conflict'||p.status==='limit');if(blocked)return blocked;
  const verified=proofs.filter(p=>p.status==='verified'),pending=proofs.some(p=>p.status==='pending');
  if(verified.length>1||verified.length&&pending)return {status:'conflict',errorCode:'multiple_native_executions'};
  return verified[0]??{status:pending?'pending':'unavailable'};
 }
 if(matches.length!==1)return {status:matches.length?'conflict':'unavailable'};
 const f=await safePath(options.home,matches[0]),before=await lstat(f,{bigint:true});if(before.size>16777216n)return {status:'limit'};
 const h=await open(f,'r');let bytes:Buffer;try{const info=await h.stat({bigint:true});if(info.ino!==before.ino||info.dev!==before.dev)throw Error('changed');bytes=Buffer.alloc(Number(before.size)+1);const n=await h.read(bytes,0,bytes.length,0);bytes=bytes.subarray(0,n.bytesRead);}finally{await h.close();}
 const after=await lstat(f,{bigint:true});if(!sameVersion(before,after))return {status:'limit',errorCode:'native_file_changed_during_scan'};
 if(bytes.length&&!bytes.toString('utf8').endsWith('\n'))return {status:'limit',errorCode:'native_partial_line'};
 const rows=[];for(const line of bytes.toString('utf8').split('\n'))if(line.trim()){if(Buffer.byteLength(line)>MAX_LINE)return {status:'limit'};rows.push(JSON.parse(line));}
 return proveClaudeAction(rows,r,options.launchers);
 }catch(e:any){const limited=['limit','native_partial_line','native_file_changed_during_scan'].includes(e.message);return {status:limited?'limit':'unavailable',errorCode:limited&&e.message!=='limit'?e.message:'native_action_read_failed'};}
 }};}
