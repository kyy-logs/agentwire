import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {requestBus} from './ipc.ts';
import type {BusRequest,BusResponse} from './ipc.ts';
import {assertId,assertAgent} from './model.ts';
export type CliIo={stdout:{write(s:string):unknown};stderr:{write(s:string):unknown};request?:(root:string,r:BusRequest)=>Promise<BusResponse>};
export async function runCli(args:readonly string[],io:CliIo=process):Promise<number>{
  let messageId:string|undefined;
  try{
    const names=['state','agent','kind','session','workspace','from','to','text','id','reply-to','task','message','limit','after','return-mode'];
    const {values:v,positionals:p}=parseArgs({args:[...args],options:Object.fromEntries(names.map(n=>[n,{type:'string'}])),allowPositionals:true,strict:true});
    const command=p[0];if(p.length!==1||!['start','bind','send','reply','reply-current','followup','status','check','stop'].includes(command))throw new Error('invalid_command');
    const allowed:Record<string,string[]>={start:[],bind:['agent','kind','session','workspace'],send:['from','to','text','id','return-mode'],reply:['from','reply-to','text','id'],'reply-current':['from','text','id'],followup:['from','reply-to','text','id'],status:['task','limit','after'],check:['message'],stop:['task']};
    for(const k of Object.keys(v))if(k!=='state'&&!allowed[command].includes(k))throw new Error('unexpected_option_'+k);
    const need=(name:string)=>{const value=v[name];if(typeof value!=='string'||!value.trim())throw new Error('missing_'+name);return value;};
    const root=path.resolve(typeof v.state==='string'?v.state:path.join(process.env.LOCALAPPDATA||os.homedir(),'LocalAgentBus'));
    if(command==='start'){const {startMain}=await import('./main.ts');await startMain(root);return 0;}
    let payload:any,op=command;
    if(['send','reply','reply-current','followup'].includes(command)){
      messageId=typeof v.id==='string'?v.id:randomUUID();assertId(messageId);const from=need('from');assertAgent(from);
      payload={messageId,kind:command==='send'?'task':command==='reply-current'?'reply':command,from,body:need('text')};
      if(command==='send'){payload.to=need('to');assertAgent(payload.to);if(v['return-mode']){const mode=need('return-mode');if(!['manual','auto'].includes(mode))throw new Error('invalid_return_mode');payload.returnMode=mode;}}else if(command!=='reply-current'){payload.replyTo=need('reply-to');assertId(payload.replyTo);}
      op=command==='reply-current'?'reply-current':'accept';io.stdout.write(JSON.stringify({messageId,status:'sending'})+'\n');
    }else if(command==='bind'){
      const agentId=need('agent'),kind=need('kind'),sessionId=need('session'),workspaceRoot=need('workspace');assertAgent(agentId);assertId(sessionId);
      if(!['codex','claude'].includes(kind)||!path.isAbsolute(workspaceRoot))throw new Error('invalid_binding');payload={agentId,kind,sessionId,workspaceRoot};
    }else if(command==='status'){payload=v.task?{taskId:need('task')}:{};if(payload.taskId)assertId(payload.taskId);if(v.after){payload.after=need('after');assertId(payload.after);}if(v.limit){const value=need('limit');if(!/^[1-9]\d{0,2}$/.test(value)||Number(value)>100)throw new Error('invalid_status_limit');payload.limit=Number(value);}}
    else if(command==='check'){payload={messageId:need('message')};assertId(payload.messageId);}
    else{payload={taskId:need('task')};assertId(payload.taskId);}
    let response:BusResponse;
    try{response=await(io.request||requestBus)(root,{requestId:randomUUID(),op,payload});}
    catch(e){const oversized=e instanceof Error&&e.message==='response_too_large';io.stderr.write(JSON.stringify({status:'unconfirmed',messageId,errorCode:oversized?'response_too_large':'transport_unconfirmed',instruction:messageId?'retry_with_same_id':oversized?'use_status_pagination_or_check':'check_bus_running'})+'\n');return 4;}
    io.stdout.write(JSON.stringify(response)+'\n');return response.ok?0:3;
  }catch(e){io.stderr.write(JSON.stringify({status:'invalid',messageId,errorCode:e instanceof Error?e.message:'invalid_arguments'})+'\n');return 2;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runCli(process.argv.slice(2));
