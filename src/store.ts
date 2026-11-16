import { mkdir,open,readFile,readdir,rename,unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertId,sameMessage,validateMessage } from './model.ts';
import type { AgentMessage,Clock,MessageRecord,MessageStore,RecoveryReport } from './model.ts';
export async function atomicJson(file:string,value:unknown,beforeRename?:()=>Promise<void>){
  await mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';
  let handle;
  try{
    handle=await open(tmp,'wx',0o600);await handle.writeFile(JSON.stringify(value,null,2)+'\n','utf8');await handle.sync();await handle.close();handle=undefined;
    await beforeRename?.();await rename(tmp,file);
  }catch(e){await handle?.close().catch(()=>{});await unlink(tmp).catch(()=>{});throw e;}
}
const states=['pending','submitting','submitted','completed','delivered','needs_check','failed','expired','stopped'];
function validateRecord(r:MessageRecord){validateMessage(r.message);if(!states.includes(r.state)||!Number.isInteger(r.attempts)||r.attempts<0||!Number.isFinite(Date.parse(r.updatedAt)))throw new Error('invalid record schema');}
export class FileMessageStore implements MessageStore {
  root:string;clock:Clock;hooks:{beforeRename?:()=>Promise<void>};chain:Promise<unknown>=Promise.resolve();
  constructor(root:string,clock:Clock,hooks:{beforeRename?:()=>Promise<void>}={}){this.root=path.resolve(root);this.clock=clock;this.hooks=hooks;}
  file(id:string){assertId(id);return path.join(this.root,'messages',id+'.json');}
  serial<T>(fn:()=>Promise<T>):Promise<T>{const p=this.chain.then(fn);this.chain=p.catch(()=>{});return p;}
  async get(id:string):Promise<MessageRecord|undefined>{
    try{const r=JSON.parse(await readFile(this.file(id),'utf8'));validateRecord(r);if(r.message.messageId!==id)throw new Error('invalid record filename');return r;}
    catch(e:any){if(e.code==='ENOENT')return undefined;throw e;}
  }
  async putNew(message:AgentMessage){return this.serial(async()=>{
    validateMessage(message);const old=await this.get(message.messageId);
    if(old){if(!sameMessage(old.message,message))throw new Error('conflict');return {record:old,duplicate:true};}
    const record:MessageRecord={message,state:'pending',attempts:0,updatedAt:this.clock.now().toISOString(),...(message.returnMode==='auto'?{returnMode:'auto' as const}:{})};
    await atomicJson(this.file(message.messageId),record,this.hooks.beforeRename);return {record,duplicate:false};
  });}
  async replace(record:MessageRecord){return this.serial(async()=>{
    validateRecord(record);const old=await this.get(record.message.messageId);
    if(!old)throw new Error('message not found');if(!sameMessage(old.message,record.message))throw new Error('immutable message conflict');
    await atomicJson(this.file(record.message.messageId),record,this.hooks.beforeRename);
  });}
  async files(){await mkdir(path.join(this.root,'messages'),{recursive:true});return (await readdir(path.join(this.root,'messages'))).filter(n=>n.endsWith('.json')).sort();}
  async list(){const records:MessageRecord[]=[];for(const n of await this.files()){const r=await this.get(n.slice(0,-5));if(r)records.push(r);}return records.sort((a,b)=>a.message.createdAt.localeCompare(b.message.createdAt)||a.message.messageId.localeCompare(b.message.messageId));}
  async recover(now:Date):Promise<RecoveryReport>{
    const report:RecoveryReport={needsCheckIds:[],quarantinedFiles:[],repairedTaskIds:[]};
    for(const name of await this.files()){
      try{await this.get(name.slice(0,-5));}catch(e){
        if(typeof (e as any).code==='string')throw e;
        const dir=path.join(this.root,'quarantine');await mkdir(dir,{recursive:true});const dest=path.join(dir,randomUUID()+'-'+name);
        await rename(path.join(this.root,'messages',name),dest);report.quarantinedFiles.push(dest);
      }
    }
    try{report.quarantinedFiles=(await readdir(path.join(this.root,'quarantine'))).map(n=>path.join(this.root,'quarantine',n));}catch(e){if((e as any).code!=='ENOENT')throw e;}
    report.orphanTemporaryFiles=(await readdir(path.join(this.root,'messages'))).filter(n=>n.endsWith('.tmp')).map(n=>path.join(this.root,'messages',n));
    const records=await this.list();
    for(const r of records){
      if(r.state==='submitting'){r.state='needs_check';r.lastError='restart_during_submit';report.needsCheckIds.push(r.message.messageId);await this.replace(r);}
      else if(r.state==='pending'&&Date.parse(r.message.expiresAt)<=+now){r.state='expired';await this.replace(r);}
    }
    for(const reply of records.filter(r=>r.message.kind==='reply'&&!r.late)){
      const parent=records.find(r=>r.message.messageId===reply.message.replyTo);
      const root=records.find(r=>r.message.messageId===reply.message.taskId);
      if(root&&(root.stoppedAt||['stopped','expired'].includes(root.state)||Date.parse(reply.message.createdAt)>=Date.parse(root.message.expiresAt))){reply.late=true;reply.state='stopped';reply.lastError='late_reply_no_forward';await this.replace(reply);continue;}
      if(parent&&parent.message.kind!=='reply'&&parent.message.taskId===reply.message.taskId&&parent.message.from===reply.message.to&&parent.message.to===reply.message.from&&!['stopped','expired'].includes(parent.state)&&parent.state!=='completed'){
        parent.state='completed';parent.resultRef=reply.message.messageId;await this.replace(parent);report.repairedTaskIds.push(parent.message.messageId);
      }
    }
    return report;
  }
}
