import {createAppServer} from './native/app-server.ts';
import type {AppServerClient} from './native/app-server.ts';
import {createCodexEvidence} from './native/codex-evidence.ts';
import {createClaudeEvidence} from './native/claude-evidence.ts';
import {IdentityStore} from './native/identity-store.ts';
import {NativeDispatcher} from './native/dispatcher.ts';
import {CleanProcessor} from './lifecycle/clean-processor.ts';
import type {Provider,EvidenceReader,WireVersion} from './native/model.ts';
import os from 'node:os';
import {readFile,appendFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startIpc} from './ipc.ts';
import {FileMessageStore,atomicJson} from './store.ts';
import {LocalBus} from './bus.ts';
import {realClock} from './model.ts';
import type {AgentAdapter,AgentBinding,Clock} from './model.ts';
import {CodexAdapter,runChild} from './adapters/codex.ts';
import {ClaudeAdapter,resolveClaude,postClaude} from './adapters/claude.ts';
import {createObserver} from './observer.ts';
import {statusPage} from './status.ts';
import {FileLifecycleStore} from './lifecycle/store.ts';
import {LifecycleProcessor} from './lifecycle/processor.ts';
import {randomUUID,createHash} from 'node:crypto';
import {assertNoConnectionSwitch} from './installation/paths.ts';
type MainOptions={native?:{client:AppServerClient;readers:Record<Provider,EvidenceReader>};installRoot?:string;connectionId?:string;newAutoWireVersion?:WireVersion;adapters?:AgentAdapter[];clock?:Clock;intervalMs?:number;signals?:boolean;quiet?:boolean;codexExe?:string};
async function codexExe(){
  if(process.env.LOCAL_BUS_CODEX_EXE)return process.env.LOCAL_BUS_CODEX_EXE;
  if(process.platform==='win32'){
    const base=path.join(process.env.ProgramFiles||'C:/Program Files','WindowsApps');
    try{for(const n of (await readdir(base)).filter(n=>n.startsWith('OpenAI.Codex_')).sort().reverse()){const exe=path.join(base,n,'app','resources','codex.exe');try{await access(exe);return exe;}catch{}}}catch{}
  }
  return 'codex';
}
export async function startMain(root:string,options:MainOptions={}){
  const instanceId=randomUUID();
  root=path.resolve(root);let clean:CleanProcessor|undefined,nativeClient:AppServerClient|undefined,workerPromise:Promise<void>|undefined;let bus:LocalBus|undefined,lifecycle:LifecycleProcessor|undefined,closing=false,working=false,storageError=false;const clock=options.clock||realClock;
  let installRoot=options.installRoot;
  if(!installRoot&&path.basename(root)==='state'&&path.basename(path.dirname(path.dirname(root)))==='connections'){
    try{const r=JSON.parse(await readFile(path.join(path.dirname(root),'connection.json'),'utf8'));if(r.connectionId===path.basename(path.dirname(root))&&[1,2].includes(r.schemaVersion))installRoot=path.dirname(path.dirname(path.dirname(root)));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  }
  const admissionGuard=async()=>{if(installRoot)await assertNoConnectionSwitch({installRoot,home:'',sourceRoot:'',nodeExe:process.execPath});};
  await admissionGuard();
  const log=async(event:string,extra:Record<string,unknown>={})=>{
    try{await appendFile(path.join(root,'bus.log'),JSON.stringify({at:clock.now().toISOString(),event,...extra})+'\n',{mode:0o600});}
    catch{storageError=true;if(!options.quiet)process.stderr.write(JSON.stringify({status:'storage_requires_check',errorCode:'log_write_failed'})+'\n');}
  };
  const ipc=await startIpc(root,async request=>{
    if(!bus||closing)return {requestId:request.requestId,ok:false,errorCode:'bus_initializing_or_closing'};
    const p=request.payload||{};
    try{
      let data:any;
      if(request.op==='accept'){await admissionGuard();if(storageError)throw new Error('storage_requires_check');data=await bus.accept(p);await log('accepted',{messageId:data.message.messageId,state:data.state});}
      else if(request.op==='reply-current'){await admissionGuard();if(storageError)throw new Error('storage_requires_check');data=await bus.replyCurrent(p);await log('accepted',{messageId:data.message.messageId,state:data.state});}
      else if(request.op==='bind'){await admissionGuard();data=await bus.bind(p);}
      else if(request.op==='status'){data=statusPage(await bus.status(p.taskId),p);for(const item of data.items){if(item.activeAttemptId){const intent=await bus.nativeDispatcher?.store.get(item.activeAttemptId);if(intent)item.native={attemptId:intent.attemptId,transportId:intent.transportId,connectionId:intent.connectionId,phase:intent.phase,nativeExecutionId:intent.nativeExecutionId,errorCode:intent.errorCode};}}}
      else if(request.op==='check')data=await bus.check(p.messageId);
      else if(request.op==='stop'){await bus.stop(p.taskId);data={taskId:p.taskId,status:'bus_stopped',nativeAgentCancelled:false};}
      else if(request.op==='health')data={instanceId,pid:process.pid,stateRoot:root,status:storageError?'storage_requires_check':'running',bindings:[...bus.bindings.values()],lifecycle:await lifecycle?.health()};
      else if(request.op==='diagnostic-health')data={instanceId,pid:process.pid,stateRoot:root,status:storageError||lifecycle?.lastError?'storage_requires_check':'running',bindings:[...bus.bindings.values()],lifecycle:null,diagnosticReadOnly:true};
      else if(request.op==='shutdown'){if(p.instanceId!==instanceId)throw new Error('instance_mismatch');bus.requestShutdown();data={instanceId,status:'closing'};}
      else throw new Error('unknown_operation');
      return {requestId:request.requestId,ok:true,data};
    }catch(e){const raw=e instanceof Error?e.message:'';const code=/^[a-z_]+$/.test(raw)?raw:'request_failed';if(request.op!=='diagnostic-health')await log('request_error',{op:request.op,errorCode:code});return {requestId:request.requestId,ok:false,errorCode:code};}
  },{afterRespond:(r,result)=>{if(r.op==='shutdown'&&result.ok)void close().catch(()=>{process.exitCode=1;});}});
  let timer:ReturnType<typeof setInterval>|undefined;
  const close=async()=>{if(closing)return;closing=true;bus?.requestShutdown();if(timer)clearInterval(timer);if(options.signals!==false){process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}await ipc.close();await workerPromise;await bus?.chain;await clean?.close();await nativeClient?.close();await log('stopped');};
  const signal=()=>{void close().catch(()=>{process.exitCode=1;});};
  try{
    let bindings:AgentBinding[]=[];
    try{const saved=JSON.parse(await readFile(path.join(root,'bindings.json'),'utf8'));if(saved.schemaVersion!==1||!Array.isArray(saved.bindings))throw new Error('invalid_bindings');bindings=saved.bindings;}catch(e){if((e as any).code!=='ENOENT')throw e;}
    const executable=options.codexExe||await codexExe();nativeClient=options.native?.client||createAppServer({exe:executable});const readers=options.native?.readers||{codex:createCodexEvidence(nativeClient),claude:createClaudeEvidence({claudeHome:path.join(os.homedir(),'.claude')})};const identities=new IdentityStore(root,clock),dispatcher=new NativeDispatcher(identities,readers);
    const observe=createObserver(),command={cliPath:fileURLToPath(new URL('./cli.ts',import.meta.url)),stateRoot:root};
    const adapters=options.adapters||[
      new CodexAdapter(runChild,{exe:executable,appServer:nativeClient,observe,command}),
      new ClaudeAdapter({resolve:resolveClaude,post:postClaude,command,observe:async(b,r)=>{
        for(let i=0;i<8;i++){const result=await observe(b,r);if(result.status==='submitted')return result;if(i<7)await new Promise(done=>setTimeout(done,200));}return {status:'unknown'};
      }})
    ];
    bus=new LocalBus({nativeDispatcher:dispatcher,connectionId:options.connectionId,newAutoWireVersion:options.newAutoWireVersion,store:new FileMessageStore(root,clock),bindings,adapters,clock,saveBindings:b=>atomicJson(path.join(root,'bindings.json'),{schemaVersion:1,bindings:b})});
    const report=await bus.recover();storageError=report.quarantinedFiles.length>0;await log('started',{recovery:report});
    lifecycle=new LifecycleProcessor(bus,new FileLifecycleStore(root));await lifecycle.recover();
    clean=new CleanProcessor(bus,identities,lifecycle.store,readers);await clean.recover();
    if(lifecycle.lastError||(await lifecycle.store.recover()).quarantined)storageError=true;
    const interval=options.intervalMs??500;
    await atomicJson(path.join(root,'diagnostic-endpoint.json'),{schemaVersion:1,operation:'diagnostic-health',instanceId,pid:process.pid,stateRoot:root,tokenSha256:createHash('sha256').update(await readFile(path.join(root,'auth.token'))).digest('hex')});
    if(interval>0)timer=setInterval(()=>{if(working||closing||storageError)return;working=true;workerPromise=(async()=>{await admissionGuard();await lifecycle!.drain();await clean!.drain();if(lifecycle!.lastError){storageError=true;await log('lifecycle_requires_check',{errorCode:lifecycle!.lastError});return;}if(!closing)await bus!.tick();})().catch(async()=>{storageError=true;await log('storage_or_tick_error',{status:'paused'});}).finally(()=>working=false);},interval);
    if(options.signals!==false){process.on('SIGINT',signal);process.on('SIGTERM',signal);}
    if(!options.quiet)process.stdout.write(JSON.stringify({status:'running',stateRoot:root,recovery:report})+'\n');
    return {bus,lifecycle,clean,close};
  }catch(e){await close();throw e;}
}
