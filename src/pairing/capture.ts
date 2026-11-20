import path from 'node:path';
import {findAgent,getAgent} from '../agents/registry.ts';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {assertId} from '../model.ts';
import {safePath,hash} from '../installation/paths.ts';
import type {InstallContext,Provider} from '../installation/model.ts';
import type {PairCommand,PairIntent,PairDeps,PairEvent} from './model.ts';

const HOOK_LIMIT=1048576,TAIL_LIMIT=8388608,LINE_LIMIT=2097152,INTENT_MS=120000;
export function parsePairCommand(text:string):PairCommand|undefined{
 if(typeof text!=='string'||Buffer.byteLength(text)>HOOK_LIMIT)return;
 const value=text.trim();
 if(value==='生成连接码'||value==='给这个聊天生成连接码')return {kind:'issue'};
 const match=/^连接 (Claude|Codex)，连接码 ([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-?[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4})$/i.exec(value);
 if(!match)return;const code=match[2].toUpperCase().replace('-','');
 return {kind:'redeem',target:match[1].toLowerCase() as Provider,code:code.slice(0,4)+'-'+code.slice(4)};
}

function nativePath(file:string){return /^\\\\\?\\[A-Za-z]:\\/.test(file)?file.slice(4):file;}
/** Syntax/shape only. This does not prove human origin or read native records. */
export function normalizePairEvent(provider:Provider,event:unknown):PairEvent|undefined{
 try{
 const agent=findAgent(provider);if(!agent)return;let e:any=event;
 if(event instanceof Uint8Array){if(event.byteLength>HOOK_LIMIT)return;e=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(event));}
 if(!e||typeof e!=='object'||e.hook_event_name!=='UserPromptSubmit'||typeof e.prompt!=='string'||Buffer.byteLength(JSON.stringify(e))>HOOK_LIMIT||!parsePairCommand(e.prompt))return;
 const inputId=e[agent.executionIdField];assertId(e.session_id);assertId(inputId);
 if(e.is_sidechain===true||e.agent_id||e.agent_type||typeof e.cwd!=='string'||!path.isAbsolute(e.cwd)||typeof e.transcript_path!=='string')return;
 const file=nativePath(e.transcript_path);if(!path.isAbsolute(file)||!file.endsWith('.jsonl'))return;
 if(agent.sessionNamedTranscript&&path.basename(file)!==e.session_id+'.jsonl')return;
 return {hook_event_name:'UserPromptSubmit',session_id:e.session_id,[agent.executionIdField]:inputId,prompt:e.prompt,cwd:e.cwd,transcript_path:file};
 }catch{return undefined;}
}
export async function readPairEvent(c:InstallContext,provider:Provider,event:unknown):Promise<PairEvent|undefined>{
 const e=normalizePairEvent(provider,event);if(!e)return;
 try{await safePath(path.join(c.home,getAgent(provider).transcriptDirectory),e.transcript_path);return e;}catch{return undefined;}
}
function lines(bytes:Buffer,skipPartial=false):any[]{
 if(skipPartial){const end=bytes.indexOf(10);if(end<0)throw Error('native_window_exhausted');bytes=bytes.subarray(end+1);}
 const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 const list=value.split('\n');
 if(list.at(-1)!=='')throw Error('native_snapshot_incomplete');list.pop();
 return list.map(line=>{if(Buffer.byteLength(line)>LINE_LIMIT)throw Error('native_line_limit');return JSON.parse(line);});
}
async function snapshot(file:string):Promise<any[]>{
 const handle=await open(file,'r');
 try{
 const before=await handle.stat();if(!before.isFile()||before.size===0)throw Error('native_empty');
 const size=before.size,n=Math.min(size,TAIL_LIMIT),tail=Buffer.alloc(n);
 if((await handle.read(tail,0,n,size-n)).bytesRead!==n)throw Error('native_short_read');
 let head:any[]=[];
 if(size>n){const length=Math.min(size,LINE_LIMIT+1),bytes=Buffer.alloc(length);const got=await handle.read(bytes,0,length,0);const end=bytes.subarray(0,got.bytesRead).indexOf(10);if(end<0||end>LINE_LIMIT)throw Error('native_metadata_limit');head=lines(bytes.subarray(0,end+1));}
 const rows=[...head,...lines(tail,size>n)],after=await handle.stat();
 if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw Error('native_changed');
 return rows;
 }finally{await handle.close();}
}
function intentId(provider:Provider,sessionId:string,inputId:string,prompt:string){
 const bytes=createHash('sha256').update(['agentwire-pair-v1',provider,sessionId,inputId,hash(prompt)].join('\0')).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** Read-only verification. Missing/future native evidence creates no intent or state.
 * Codex writes its input after UserPromptSubmit returns; callers must not treat
 * the Hook request alone as authority or wait inside that Hook for future input.
 */
export async function verifyPairIntent(c:InstallContext,provider:Provider,event:unknown,deps:PairDeps={}):Promise<PairIntent|undefined>{
 try{
 const e=await readPairEvent(c,provider,event);if(!e)return;const command=parsePairCommand(e.prompt)!;
 const agent=getAgent(provider),inputId=e[agent.executionIdField]!,file=e.transcript_path;
 const rows=await snapshot(file),proof=agent.provePairInput(rows,e);if(!proof)return;
 const captured=Date.parse(proof.timestamp),now=(deps.now??(()=>new Date()))().getTime();
 if(!Number.isFinite(captured)||!Number.isFinite(now)||captured>now||now>=captured+INTENT_MS)return;
 return {intentId:intentId(provider,e.session_id,inputId,e.prompt),source:{provider,sessionId:e.session_id,workspaceRoot:proof.cwd,availability:'candidate'},nativeInputId:inputId,command,capturedAt:new Date(captured).toISOString(),expiresAt:new Date(captured+INTENT_MS).toISOString(),proofRef:file+'#'+inputId};
 }catch{return undefined;} // Fail closed without logging peer content, paths or codes.
}
