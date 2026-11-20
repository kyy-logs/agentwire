import path from 'node:path';
import {readdir,lstat,open} from 'node:fs/promises';
import {safePath} from '../installation/paths.ts';
import {validateAction} from './model.ts';
import type {ActionEvidenceReader,ActionEvidence} from './model.ts';
import {proveClaudeAction,proveCodexAction} from './native-actions.ts';
export function createNativeActionReader(options:{home:string;launchers:string[]}):ActionEvidenceReader{return {async proveAction(r):Promise<ActionEvidence>{
 try{validateAction(r);const base=path.join(options.home,r.actor.provider==='codex'?'.codex/sessions':'.claude/projects'),matches:string[]=[];let count=0;
 async function visit(dir:string,depth:number){if(depth>8)throw Error('limit');let entries;try{entries=await readdir(await safePath(options.home,dir),{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw e;}for(const ent of entries){if(++count>20000)throw Error('limit');const f=path.join(dir,ent.name);if(ent.isSymbolicLink())throw Error('symlink');if(ent.isDirectory())await visit(f,depth+1);else if(ent.isFile()&&(ent.name===r.actor.sessionId+'.jsonl'||r.actor.provider==='codex'&&ent.name.endsWith('-'+r.actor.sessionId+'.jsonl')))matches.push(f);}}
 await visit(base,0);if(matches.length!==1)return {status:matches.length?'conflict':'unavailable'};
 const f=await safePath(options.home,matches[0]),before=await lstat(f,{bigint:true});if(before.size>16777216n)return {status:'limit'};
 const h=await open(f,'r');let bytes:Buffer;try{const info=await h.stat({bigint:true});if(info.ino!==before.ino||info.dev!==before.dev)throw Error('changed');bytes=Buffer.alloc(Number(before.size)+1);const n=await h.read(bytes,0,bytes.length,0);bytes=bytes.subarray(0,n.bytesRead);}finally{await h.close();}
 const after=await lstat(f,{bigint:true});if(['ino','dev','size','mtimeNs','ctimeNs'].some(k=>(before as any)[k] !== (after as any)[k]))return {status:'limit',errorCode:'native_file_changed_during_scan'};
 if(bytes.length&&!bytes.toString('utf8').endsWith('\n'))return {status:'limit',errorCode:'native_partial_line'};
 const rows=[];for(const line of bytes.toString('utf8').split('\n'))if(line.trim()){if(Buffer.byteLength(line)>2097152)return {status:'limit'};rows.push(JSON.parse(line));}
 return (r.actor.provider==='codex'?proveCodexAction:proveClaudeAction)(rows,r,options.launchers);
 }catch(e:any){return {status:e.message==='limit'?'limit':'unavailable',errorCode:'native_action_read_failed'};}
 }};}
