import {recoverCollaborationOne} from './collaboration/recovery.ts';
import {CollaborationStore} from './collaboration/store.ts';
import {createNativeActionReader} from './collaboration/native-reader.ts';
import {createAgentRuntime} from './agents/registry.ts';
import {recordTiming} from './latency.ts';
import {reconcilePairStartup} from './pairing/worker.ts';
import {createAppServer} from './native/app-server.ts';
import type {AppServerClient} from './native/app-server.ts';
import {IdentityStore} from './native/identity-store.ts';
import {NativeDispatcher} from './native/dispatcher.ts';
import {CleanProcessor} from './lifecycle/clean-processor.ts';
import {CodexQueuePump} from './native/codex-queue.ts';
import {isPairControlExecution} from './pairing/lifecycle-control.ts';
import {isSwitchControlExecution} from './installation/lifecycle-control.ts';
import {createNonTaskVerifier} from './installation/non-task-evidence.ts';
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
  root=path.resolve(root);let clean:CleanProcessor|undefined,nativeClient:AppServerClient|undefined,workerPromise:Promise<void>|undefined;let bus:LocalBus|undefined,lifecycle:LifecycleProcessor|undefined,closing=false,working=false,storageError=false,initialized=false;let requestWork=()=>{};const clock=options.clock||realClock;
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
    if(!bus||closing||!initialized)return {requestId:request.requestId,ok:false,errorCode:'bus_initializing_or_closing'};
    const p=request.payload||{},admissionStarted=performance.now();
    try{
      let data:any;
      if(request.op==='accept'){await admissionGuard();if(storageError)throw new Error('storage_requires_check');data=await bus.accept(p);await log('accepted',{messageId:data.message.messageId,state:data.state});requestWork();await recordTiming(root,{stage:'admission_committed',messageId:data.message.messageId,taskId:data.message.taskId,state:data.state,durationsMs:{admissionMs:performance.now()-admissionStarted}});}
      else if(request.op==='collaboration-open'){await admissionGuard();if(storageError)throw Error('storage_requires_check');if(!bus.collaboration)throw Error('collaboration_service_upgrade_required');if(Object.keys(p).some(k=>!['input','actor'].includes(k)))throw Error('invalid_input');data=await bus.serial(()=>bus!.collaboration!.openOne(p.input,p.actor));requestWork();}
      else if(request.op==='collaboration-action'){await admissionGuard();if(storageError)throw Error('storage_requires_check');if(!bus.collaboration)throw Error('collaboration_service_upgrade_required');data=await bus.serial(()=>bus!.collaboration!.submitActionOne(p));requestWork();}
      else if(request.op==='collaboration-status'){if(!bus.collaboration)throw Error('collaboration_service_upgrade_required');data={items:(await bus.collaboration.store.listTasks()).slice(0,50).map(t=>({taskId:t.taskId,phase:t.phase,revision:t.revision})),nextCursor:null};}
      else if(request.op==='reply-current'){await admissionGuard();if(storageError)throw new Error('storage_requires_check');data=await bus.replyCurrent(p);await log('accepted',{messageId:data.message.messageId,state:data.state});requestWork();await recordTiming(root,{stage:'admission_committed',messageId:data.message.messageId,taskId:data.message.taskId,state:data.state,durationsMs:{admissionMs:performance.now()-admissionStarted}});}
      else if(request.op==='wake'){requestWork();data={status:'wake_requested'};}
      else if(request.op==='bind'){await admissionGuard();data=await bus.bind(p);}
      else if(request.op==='status'){data=statusPage(await bus.status(),p,bus.clock.now());for(const item of data.items){if(item.activeAttemptId){const intent=await bus.nativeDispatcher?.store.get(item.activeAttemptId);if(intent)item.native={attemptId:intent.attemptId,transportId:intent.transportId,connectionId:intent.connectionId,phase:intent.phase,nativeExecutionId:intent.nativeExecutionId,errorCode:intent.errorCode};}}}
      else if(request.op==='check')data=await bus.check(p.messageId);
      else if(request.op==='stop'){await bus.stop(p.taskId);data={taskId:p.taskId,status:'bus_stopped',nativeAgentCancelled:false};}
      else if(request.op==='health')data={instanceId,pid:process.pid,stateRoot:root,status:storageError?'storage_requires_check':'running',capabilities:{structuredCollaboration:bus.collaboration?1:0},bindings:[...bus.bindings.values()],lifecycle:await lifecycle?.health()};
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
    const executable=options.codexExe||await codexExe();nativeClient=options.native?.client||createAppServer({exe:executable});
    const observe=createObserver(),command={cliPath:fileURLToPath(new URL('./cli.ts',import.meta.url)),stateRoot:root};
    const runtime=await createAgentRuntime({client:nativeClient,exe:executable,home:os.homedir(),observe,command});
    const readers=options.native?.readers||runtime.readers,adapters=options.adapters||runtime.adapters;
    const identities=new IdentityStore(root,clock),dispatcher=new NativeDispatcher(identities,readers);
    bus=new LocalBus({onTiming:event=>recordTiming(root,event),nativeDispatcher:dispatcher,connectionId:options.connectionId,newAutoWireVersion:options.newAutoWireVersion,store:new FileMessageStore(root,clock),bindings,adapters,clock,saveBindings:b=>atomicJson(path.join(root,'bindings.json'),{schemaVersion:1,bindings:b})});
    if(options.connectionId){const collabStore=new CollaborationStore(root);await collabStore.inspect();bus.enableCollaboration({store:collabStore,proof:createNativeActionReader({home:os.homedir(),launchers:[...(installRoot?[path.join(installRoot,'bin','labus.cmd'),path.join(installRoot,'bin','labus.cmd').replaceAll('\\','/')]:[])]})});}
    const report=await bus.recover();storageError=report.quarantinedFiles.length>0;await log('started',{recovery:report});
    if(bus.collaboration)await bus.serial(()=>recoverCollaborationOne(bus!.collaboration!));
    const controlExecution=installRoot?(async(ref:any)=>{const c={installRoot:installRoot!,home:os.homedir(),sourceRoot:installRoot!,nodeExe:process.execPath},id=options.connectionId||path.basename(path.dirname(root));return await isPairControlExecution(c,id,ref)||await isSwitchControlExecution(c,id,ref);}):undefined;
    const nonTaskExecution=installRoot?createNonTaskVerifier({installRoot,home:os.homedir(),sourceRoot:installRoot,nodeExe:process.execPath},options.connectionId||path.basename(path.dirname(root))):undefined;
    lifecycle=new LifecycleProcessor(bus,new FileLifecycleStore(root),controlExecution,nonTaskExecution);await lifecycle.recover();
    clean=new CleanProcessor(bus,identities,lifecycle.store,readers);await clean.recover();
    const queue=new CodexQueuePump(bus,nativeClient,admissionGuard);
    if(lifecycle.lastError||(await lifecycle.store.recover()).quarantined)storageError=true;
    const interval=options.intervalMs??500;
    await atomicJson(path.join(root,'diagnostic-endpoint.json'),{schemaVersion:1,operation:'diagnostic-health',instanceId,pid:process.pid,stateRoot:root,tokenSha256:createHash('sha256').update(await readFile(path.join(root,'auth.token'))).digest('hex')});
    let lastStartupScan=0,startupErrorLogged=false;
    // A wake is a hint only: persisted records and native evidence remain authoritative.
    // Keep one drain, retaining a wake arriving during any await in the current cycle.
    let requested=false;
    const work=async()=>{if(installRoot&&Date.now()-lastStartupScan>=1000){lastStartupScan=Date.now();try{await reconcilePairStartup({installRoot,home:os.homedir(),sourceRoot:installRoot,nodeExe:process.execPath});}catch{if(!startupErrorLogged){startupErrorLogged=true;await log('pair_startup_monitor_requires_check');}}}if(storageError||closing)return;await admissionGuard();await bus!.serial(async()=>{await bus!.collaboration?.drainOne();});await lifecycle!.drain();await clean!.drain();if(lifecycle!.lastError){storageError=true;await log('lifecycle_requires_check',{errorCode:lifecycle!.lastError});return;}if(!closing)await bus!.tick();if(!closing)await queue.drain();};
    requestWork=()=>{
      if(interval<=0||closing)return;
      requested=true;if(working)return;working=true;
      workerPromise=(async()=>{
        await new Promise<void>(resolve=>setImmediate(resolve));
        while(requested&&!closing){requested=false;await work();}
      })().catch(async(error)=>{if(error?.message==='connection_switch_requires_check')return;storageError=true;await log('storage_or_tick_error',{status:'paused'});}).finally(()=>working=false);
    };
    if(interval>0)timer=setInterval(requestWork,interval);
    if(options.signals!==false){process.on('SIGINT',signal);process.on('SIGTERM',signal);}
    initialized=true;
    if(!options.quiet)process.stdout.write(JSON.stringify({status:'running',stateRoot:root,recovery:report})+'\n');
    return {bus,lifecycle,clean,close};
  }catch(e){await close();throw e;}
}
