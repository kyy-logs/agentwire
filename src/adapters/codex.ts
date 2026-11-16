import type {AppServerClient} from '../native/app-server.ts';
import {spawn} from 'node:child_process';
import type {AgentAdapter,AgentBinding,AgentMessage,MessageRecord,ChildRunner,ReconcileResult,SubmitResult,ProbeResult,SubmitOptions} from '../model.ts';
import {envelope} from '../envelope.ts';
import type {ReplyCommand} from '../envelope.ts';
export type CodexOptions={exe:string;appServer?:AppServerClient;submitTimeoutMs?:number;remote?:string;observe?:(b:AgentBinding,r:MessageRecord)=>Promise<ReconcileResult>;command?:ReplyCommand};
// Conservative CreateProcessW budget: force quotes around every argument and
// include backslashes escaped before quotes or at the end of a quoted argument.
function windowsCommandUnits(exe:string,args:readonly string[]){
  const quoted=(value:string)=>{let units=2,slashes=0;for(const c of value){if(c==='\\'){slashes++;continue;}units+=c==='"'?2*slashes+2:slashes+c.length;slashes=0;}return units+2*slashes;};
  return [exe,...args].reduce((n,arg)=>n+quoted(arg)+1,0); // separators + final NUL
}
export const runChild:ChildRunner=async(exe,args,{timeoutMs})=>new Promise(resolve=>{
  let stdout='',stderr='',timedOut=false,done=false;
  const child=spawn(exe,[...args],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const finish=(exitCode:number|null)=>{if(done)return;done=true;clearTimeout(timer);resolve({exitCode,stdout,stderr,timedOut});};
  const timer=setTimeout(()=>{timedOut=true;child.kill();finish(null);},timeoutMs);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',s=>stdout=(stdout+s).slice(-1048576));child.stderr.on('data',s=>stderr=(stderr+s).slice(-1048576));
  child.on('error',()=>finish(null));child.on('close',finish);
});
export class CodexAdapter implements AgentAdapter {
  readonly kind='codex';runner:ChildRunner;options:CodexOptions;
  constructor(runner:ChildRunner,options:CodexOptions){this.runner=runner;this.options=options;}
  async probe(b:AgentBinding):Promise<ProbeResult>{
    const r=await this.runner(this.options.exe,['queue','--help'],{timeoutMs:5000});return {status:r.exitCode===0&&r.stdout.includes('--thread')?'available':'unsupported',details:['queue capability only; original-thread reachability requires actual inbound evidence',b.sessionId]};
  }
  async submit(b:AgentBinding,m:AgentMessage,options?:SubmitOptions):Promise<SubmitResult>{
    if(m.targetSessionId!==b.sessionId)return {status:'rejected',retryable:false,errorCode:'binding_mismatch'};
    if(m.schemaVersion===2){if(!options?.transportId||!this.options.appServer)return {status:'rejected',retryable:false,errorCode:'native_dispatch_unavailable'};try{const r:any=await this.options.appServer.call('thread/queue/add',{threadId:b.sessionId,input:[{type:'text',text:envelope(m),text_elements:[]}],clientUserMessageId:options.transportId});if(r.queuedSubmission?.clientUserMessageId!==options.transportId)return {status:'unknown',retryable:false,errorCode:'native_queue_identity_unconfirmed'};return {status:'accepted',nativeId:r.queuedSubmission.id};}catch{return {status:'unknown',retryable:false,errorCode:'native_queue_unconfirmed'};}}
    const args=['queue','--thread',b.sessionId,'--message',envelope(m,this.options.command,options)];
    if(this.options.remote)args.push('--remote',this.options.remote);
    if(process.platform==='win32'&&windowsCommandUnits(this.options.exe,args)>32767)return {status:'rejected',retryable:false,errorCode:'command_line_too_long'};
    try{
      const r=await this.runner(this.options.exe,args,{timeoutMs:this.options.submitTimeoutMs??15000});
      if(r.timedOut)return {status:'unknown',retryable:false,errorCode:'queue_timeout'};
      const match=r.stdout.match(/Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})\./i);
      if(r.exitCode===0&&match?.[2]===b.sessionId)return {status:'accepted',nativeId:match[1],...(r.stderr.trim()?{errorCode:'native_warning'}:{})};
      if(r.exitCode!==0&&/thread not found|unknown thread/i.test(r.stderr))return {status:'rejected',retryable:false,errorCode:'unknown_thread'};
      return {status:'unknown',retryable:false,errorCode:'queue_unconfirmed'};
    }catch{return {status:'unknown',retryable:false,errorCode:'queue_exception'};}
  }
  async reconcile(b:AgentBinding,r:MessageRecord):Promise<ReconcileResult>{return this.options.observe?this.options.observe(b,r):{status:'unknown'};}
}
