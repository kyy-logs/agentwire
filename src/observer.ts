import {createReadStream} from 'node:fs';
import {readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {AgentBinding,MessageRecord,ReconcileResult} from './model.ts';
import {assertId} from './model.ts';
import {parsePacket} from './lifecycle/normalize.ts';
type Seen={at:string;ref:string;busyReply?:{taskId:string;from:string;to:string}};
type Cursor={offset:number;carry:Buffer;sessionId?:string;seen:Map<string,Seen>;discard:boolean};
export function createObserver(options:{codexHome?:string;claudeHome?:string}={}){
  const cursors=new Map<string,Cursor>();
  const codexHome=options.codexHome||path.join(os.homedir(),'.codex'),claudeHome=options.claudeHome||path.join(os.homedir(),'.claude');
  async function files(b:AgentBinding){
    const base=path.join(b.kind==='codex'?codexHome:claudeHome,b.kind==='codex'?'sessions':'projects');
    try{return (await readdir(base,{recursive:true})).filter(n=>b.kind==='codex'?path.basename(n).includes(b.sessionId)&&n.endsWith('.jsonl'):path.basename(n)===b.sessionId+'.jsonl').map(n=>path.join(base,n));}catch(e){if((e as any).code==='ENOENT')return [];throw e;}
  }
  async function scan(file:string,b:AgentBinding){
    const size=(await stat(file)).size;let c=cursors.get(file);
    if(!c||c.offset>size){c={offset:0,carry:Buffer.alloc(0),seen:new Map(),discard:false};cursors.set(file,c);}
    if(size===c.offset)return c;
    for await(const chunk of createReadStream(file,{start:c.offset,end:size-1})){
      c.offset+=chunk.length;let buf=Buffer.concat([c.carry,chunk]);let end:number;
      while((end=buf.indexOf(10))>=0){const line=buf.subarray(0,end);buf=buf.subarray(end+1);if(c.discard){c.discard=false;continue;}
        let r:any;try{r=JSON.parse(line.toString('utf8'));}catch{continue;}
        if(b.kind==='codex'&&r.type==='session_meta'){c.sessionId=r.payload?.id;continue;}
        let text='',busyReply:Seen['busyReply'];
        if(b.kind==='codex'){
          if(c.sessionId!==b.sessionId||r.type!=='response_item'||r.payload?.type!=='message'||r.payload.role!=='user')continue;
          text=Array.isArray(r.payload.content)?r.payload.content.filter((x:any)=>x.type==='input_text').map((x:any)=>x.text).join('\n'):'';
        }else{
          if(r.sessionId!==b.sessionId)continue;
          if(r.type==='attachment'){
            const a=r.attachment,packet=parsePacket(a?.prompt);
            if(r.isSidechain!==false||a?.type!=='queued_command'||a.commandMode!=='prompt'||a.origin?.kind!=='peer'||packet?.kind!=='reply')continue;
            try{assertId(r.uuid);assertId(a.source_uuid);}catch{continue;}
            const prefix='<system-reminder>\nAnother Claude session sent a message while you were working:\n'+a.prompt+'\n';
            if(!Array.isArray(r.rendered)||!r.rendered.some((x:any)=>typeof x.content==='string'&&x.content.startsWith(prefix)))continue;
            text=a.prompt;busyReply={taskId:packet.taskId,from:packet.from,to:packet.to};
          }else{
            if(r.type!=='user'||r.message?.role!=='user')continue;
            const content=r.message.content;text=typeof content==='string'?content:Array.isArray(content)?content.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('\n'):'';
          }
        }
        const match=text.match(/^(?:Another Claude session sent a message:\r?\n)?LOCAL_AGENT_BUS messageId=([0-9a-f-]{36})(?:\s|$)/i);
        if(match&&Number.isFinite(Date.parse(r.timestamp))){const old=c.seen.get(match[1]);if(!busyReply||!old||old.busyReply)c.seen.set(match[1],{at:r.timestamp,ref:file+'#'+(r.uuid||r.timestamp),...(busyReply?{busyReply}:{})});}
      }
      if(buf.length>2097152){c.discard=true;c.carry=Buffer.alloc(0);}else c.carry=Buffer.from(buf);
    }
    return c;
  }
  return async(b:AgentBinding,r:MessageRecord):Promise<ReconcileResult>=>{
    if(b.sessionId!==r.message.targetSessionId)return {status:'unknown'};
    try{for(const file of await files(b)){const c=await scan(file,b),seen=c.seen.get(r.message.messageId);if(seen?.busyReply&&(r.message.kind!=='reply'||seen.busyReply.taskId!==r.message.taskId||seen.busyReply.from!==r.message.from||seen.busyReply.to!==r.message.to))continue;if(seen&&Date.parse(seen.at)>=Date.parse(r.message.createdAt))return {status:'submitted',evidenceRef:seen.ref};}return {status:'not_found'};}catch{return {status:'unknown'};}
  };
}
