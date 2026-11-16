import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {readFile,readdir} from 'node:fs/promises';
import type {AgentAdapter,AgentBinding,AgentMessage,MessageRecord,SubmitResult,ReconcileResult,ProbeResult,SubmitOptions} from '../model.ts';
import {envelope} from '../envelope.ts';
import type {ReplyCommand} from '../envelope.ts';
export type ClaudeEndpoint={pid:number;sessionId:string;socketPath:string;token:string};
export type ClaudeOptions={resolve:(id:string)=>Promise<ClaudeEndpoint|undefined>;post:(endpoint:ClaudeEndpoint,text:string,metadata?:{uuid:string})=>Promise<SubmitResult>;observe?:(b:AgentBinding,r:MessageRecord)=>Promise<ReconcileResult>;command?:ReplyCommand};
export async function resolveClaude(sessionId:string,home=path.join(os.homedir(),'.claude'),alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}}):Promise<ClaudeEndpoint|undefined>{
  const dir=path.join(home,'sessions');let names:string[];try{names=await readdir(dir);}catch(e){if((e as any).code==='ENOENT')return;throw e;}
  const candidates:any[]=[];
  for(const n of names.filter(n=>/^\d+\.json$/.test(n))){let r:any;try{r=JSON.parse(await readFile(path.join(dir,n),'utf8'));}catch{continue;}
    if(r.sessionId===sessionId&&Number.isInteger(r.pid)&&r.pid>0&&String(r.pid)+'.json'===n&&typeof r.messagingSocketPath==='string'&&alive(r.pid))candidates.push(r);
  }
  if(candidates.length>1)throw new Error('ambiguous_live_session');if(!candidates.length)return;
  const r=candidates[0],keys=names.filter(n=>n.startsWith(r.pid+'.')&&n.endsWith('.key'));if(keys.length!==1)throw new Error('ambiguous_or_missing_auth');
  const key=JSON.parse(await readFile(path.join(dir,keys[0]),'utf8'));if(typeof key.peerToken!=='string'||!key.peerToken)throw new Error('invalid_auth');
  return {pid:r.pid,sessionId,socketPath:r.messagingSocketPath,token:key.peerToken};
}
export async function postClaude(endpoint:ClaudeEndpoint,text:string,metadata?:{uuid:string}):Promise<SubmitResult>{
  return new Promise(resolve=>{
    const s=net.createConnection(endpoint.socketPath);let wrote=false,done=false;
    const finish=(r:SubmitResult)=>{if(done)return;done=true;s.destroy();resolve(r);};
    s.setTimeout(5000,()=>finish({status:wrote?'unknown':'rejected',retryable:!wrote,errorCode:'pipe_timeout'}));
    s.on('error',()=>finish({status:wrote?'unknown':'rejected',retryable:!wrote,errorCode:'pipe_error'}));
    s.on('connect',()=>{wrote=true;s.end(JSON.stringify({type:'auth',token:endpoint.token})+'\n'+JSON.stringify({type:'user',...(metadata?{uuid:metadata.uuid}:{}),message:{role:'user',content:text}})+'\n',()=>finish({status:'unknown',retryable:false,errorCode:'write_without_delivery_evidence'}));});
  });
}
export class ClaudeAdapter implements AgentAdapter {
  readonly kind='claude';options:ClaudeOptions;
  constructor(options:ClaudeOptions){this.options=options;}
  async probe(b:AgentBinding):Promise<ProbeResult>{try{return await this.options.resolve(b.sessionId)?{status:'available',details:['live session endpoint; delivery and tool approvals checked separately']}:{status:'offline',details:[b.sessionId]};}catch{return {status:'unknown',details:['session_resolution_failed']};}}
  async submit(b:AgentBinding,m:AgentMessage,options?:SubmitOptions):Promise<SubmitResult>{
    if(m.targetSessionId!==b.sessionId)return {status:'rejected',retryable:false,errorCode:'binding_mismatch'};
    let endpoint:ClaudeEndpoint|undefined;try{endpoint=await this.options.resolve(b.sessionId);}catch{return {status:'rejected',retryable:false,errorCode:'session_resolution_failed'};}
    if(!endpoint)return {status:'rejected',retryable:true,errorCode:'session_offline'};
    if(m.schemaVersion===2&&!options?.transportId)return {status:'rejected',retryable:false,errorCode:'native_identity_missing'};
    let result:SubmitResult;try{result=await this.options.post(endpoint,envelope(m,this.options.command,options),m.schemaVersion===2?{uuid:options!.transportId!}:undefined);}catch{return {status:'unknown',retryable:false,errorCode:'pipe_exception'};}
    if(m.schemaVersion===1&&result.status==='unknown'&&this.options.observe){
      const r:MessageRecord={message:m,state:'submitting',attempts:1,updatedAt:m.createdAt};
      const observed=await this.options.observe(b,r);if(observed.status==='submitted')return {status:'accepted',evidenceRef:observed.evidenceRef};
    }
    return result;
  }
  async reconcile(b:AgentBinding,r:MessageRecord):Promise<ReconcileResult>{return this.options.observe?this.options.observe(b,r):{status:'unknown'};}
}
