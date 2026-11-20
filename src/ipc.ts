import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {mkdir,realpath,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export type BusRequest={requestId:string;token?:string;op:string;payload?:any};
export type BusResponse={requestId:string;ok:boolean;data?:any;errorCode?:string};
const MAX=1048576;
export async function pipeFor(root:string):Promise<string>{
  await mkdir(root,{recursive:true});let canonical=await realpath(root);
  if(process.platform==='win32')canonical=canonical.toLowerCase();
  const hash=createHash('sha256').update(canonical).digest('hex').slice(0,24);
  return process.platform==='win32'?`\\\\.\\pipe\\local-agent-bus-${hash}`:path.join(os.tmpdir(),`local-agent-bus-${hash}.sock`);
}
function authenticated(a:unknown,b:string){if(typeof a!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export async function startIpc(root:string,handle:(r:BusRequest)=>Promise<BusResponse>,options:{afterRespond?:(r:BusRequest,response:BusResponse)=>void}={}){
  const pipe=await pipeFor(root),token=randomBytes(32).toString('hex');const sockets=new Set<net.Socket>();let ready=false;
  const server=net.createServer(s=>{
    sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});s.setTimeout(5000,()=>s.destroy());s.setEncoding('utf8');
    let buffer='',chain=Promise.resolve();
    const respond=(r:BusResponse)=>{if(!s.destroyed)s.write(JSON.stringify(r)+'\n');};
    s.on('data',part=>{
      buffer+=part;
      for(;;){const end=buffer.indexOf('\n');const frame=end<0?buffer:buffer.slice(0,end);
        if(Buffer.byteLength(frame)>MAX){respond({requestId:'',ok:false,errorCode:'frame_too_large'});s.end();buffer='';return;}
        if(end<0)return;buffer=buffer.slice(end+1);
        chain=chain.then(async()=>{
          let r:BusRequest;try{r=JSON.parse(frame);}catch{respond({requestId:'',ok:false,errorCode:'invalid_json'});return;}
          if(!r||!ready||!authenticated(r.token,token)){respond({requestId:typeof r?.requestId==='string'?r.requestId:'',ok:false,errorCode:'unauthorized'});return;}
          if(typeof r.requestId!=='string'||typeof r.op!=='string'){respond({requestId:'',ok:false,errorCode:'invalid_request'});return;}
          const {token:ignored,...safe}=r;
          try{const result=await handle(safe);if(safe.op==='shutdown'&&result.ok&&options.afterRespond){s.once('close',()=>options.afterRespond!(safe,result));s.end(JSON.stringify(result)+'\n');}else respond(result);}catch{respond({requestId:r.requestId,ok:false,errorCode:'request_failed'});}
        });
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(pipe,()=>{server.removeListener('error',reject);resolve();});});
  try{await writeFile(path.join(root,'auth.token'),token+'\n',{mode:0o600});ready=true;}catch(e){server.close();throw e;}
  return {async close(){ready=false;for(const s of sockets)s.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
export async function requestBus(root:string,request:BusRequest,options:{timeoutMs?:number}={}):Promise<BusResponse>{
  const token=(await readFile(path.join(root,'auth.token'),'utf8')).trim(),pipe=await pipeFor(root);
  return new Promise((resolve,reject)=>{
    const s=net.createConnection(pipe);let buffer='';s.setEncoding('utf8');
    const fail=(e:Error)=>{s.destroy();reject(e);};
    s.setTimeout(options.timeoutMs??5000,()=>fail(new Error('ipc_timeout')));s.on('error',fail);
    s.on('connect',()=>s.write(JSON.stringify({...request,token})+'\n'));
    s.on('end',()=>{if(!s.destroyed)fail(new Error('ipc_closed_without_ack'));});
    s.on('data',part=>{buffer+=part;if(Buffer.byteLength(buffer)>MAX){fail(new Error('response_too_large'));return;}const end=buffer.indexOf('\n');if(end<0)return;
      try{const r=JSON.parse(buffer.slice(0,end));if(r.requestId!==request.requestId)throw new Error('request_id_mismatch');s.destroy();resolve(r);}catch(e){fail(e as Error);}
    });
  });
}
