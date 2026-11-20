import path from 'node:path';import os from 'node:os';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {assertId} from '../model.ts';import {optional,safePath,resolveLayout} from './paths.ts';import type {InstallContext,Provider} from './model.ts';
import {openHookTiming} from './hook-timing.ts';import type {PairDeps} from '../pairing/model.ts';
const routerReady=performance.now(),nodeUptimeAtRouterReadyMs=process.uptime()*1000;
export async function routeHook(c:InstallContext,provider:Provider,input:AsyncIterable<Uint8Array>|Iterable<Uint8Array>,deps:PairDeps&{stdout?:{write(s:string):unknown}}={}):Promise<number>{
 if(!['codex','claude'].includes(provider))throw Error('invalid_provider');const l=resolveLayout(c);let n=0;const chunks:Buffer[]=[];for await(const chunk of input){n+=chunk.length;if(n>1048576)throw Error('stdin_limit');chunks.push(Buffer.from(chunk));}const bytes=Buffer.concat(chunks),event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(typeof event.session_id!=='string')return 0;
 const trace=await openHookTiming(c.installRoot,provider,event,{ready:routerReady,stdin:performance.now(),uptimeMs:nodeUptimeAtRouterReadyMs});
 try{
 trace?.mark('lifecycle_import_started');
 const [{runHook},{parsePairCommand}]=await Promise.all([import('../lifecycle/hook.ts'),import('../pairing/capture.ts')]);
 trace?.mark('lifecycle_import_ready');
 // Persist an existing route's input before starting a worker that can fail or
 // replace that route. New chats without a route can still stage pairing below.
 const file=await safePath(l.root,l.routes),b=await optional(file);let captureResult=0;
 if(b){if(b.length>262144)throw Error('routes_limit');const routes=JSON.parse(b.toString());if(routes.schemaVersion!==1||!Array.isArray(routes.routes)||routes.routes.length>20)throw Error('invalid_routes');
  const matching=routes.routes.filter((r:any)=>r.provider===provider&&r.sessionId===event.session_id);if(matching.length>1)throw Error('ambiguous_route');if(matching.length){const r=matching[0];assertId(r.connectionId);assertId(r.sessionId);const state=await safePath(l.connections,path.join(l.connections,r.connectionId,'state'));trace?.mark('route_ready');captureResult=await runHook(['--state',state,'--provider',provider,'--session',r.sessionId],[bytes],trace);if(captureResult!==0)return captureResult;}
 }
 trace?.mark('route_ready');
 // Before route lookup: new chats have no lifecycle route. Staging is not proof
 // or pairing; CLI consumption must verify the exact persisted native input.
 // Ordinary input and terminal events finish without loading the pairing control plane.
 if(event.hook_event_name!=='UserPromptSubmit'||!parsePairCommand(event.prompt))return captureResult;
 const {stagePairRequest}=await import('../pairing/requests.ts');
 let ticket=await stagePairRequest(c,provider,event,deps);
 const jobs=ticket?await import('../pairing/jobs.ts'):undefined;
 if(ticket&&jobs&&(await jobs.readAutomation(c)).enabled){
  const {enqueuePairJob,automationLock,readPairJob,updatePairJobLocked}=jobs;
  await enqueuePairJob(c,ticket,{...deps,startupOwnerPid:process.pid});let startUnconfirmed=false;
  try{const schedule=(deps as any).scheduleWorker||(await import('../pairing/worker.ts')).schedulePairWorker;await schedule(c);}catch{
   startUnconfirmed=true;
   // A launcher error can race with a worker that already committed. The same
   // admission lock protects its checkpoint; never overwrite started/results.
   await automationLock(c,async()=>{const j=await readPairJob(c,ticket!);if(j?.phase==='waiting_native'&&!j.intentId&&!j.result)await updatePairJobLocked(c,{...j,phase:'needs_check',errorCode:'pairing_worker_start_requires_check',result:{ok:false,operation:'pair',action:'unknown',errorCode:'pairing_worker_start_requires_check'}});});
  }
  const status=startUnconfirmed?'本次配对请求已登记，但后台执行器启动未确认（pairing_worker_start_requires_check）。不代表配对成功或已有连接断开；只读查询本次程序结果，不自动重试。':'本次配对请求已登记，由本地程序处理。当前尚未确认成功；程序将保存实际结果并通知本聊天。';
  (deps.stdout??process.stdout).write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:status+'不要调用配对工具、查询环境变量或自行生成码。业务工具审批继续生效。\nAGENTWIRE_PAIR_REQUEST_ID='+ticket+'\n此 ID 只用于本次只读查询：labus pair result --request '+ticket+'；不是手动 issue/redeem 凭据。不要从环境变量缺失推断失败，不复述内部编号，不轮询等待，不重复输入连接码。'}})+'\n');ticket=undefined;
 }
 if(ticket){const kind=parsePairCommand(event.prompt)!.kind;const additionalContext=`AGENTWIRE_PAIR_REQUEST=${ticket}\n该值在本轮原生 additionalContext 文本中，不是进程环境变量；直接读取上面的值，不用 Bash echo、printenv 或 PowerShell env 检查它。环境变量缺失不表示本轮上下文缺失。\n这是本次明确配对请求的临时凭据，原生来源尚未核验，不是连接码或成功回执。使用已加载的 labus 技能执行 labus pair ${kind} --intent ${ticket}。不填写会话ID或工作目录、不查最近凭据、不自行生成连接码；只展示程序实际结果。失败时如实说明，不改变权限或自动选择其他聊天。${provider==='codex'?'此命令需写入项目目录外的 AgentWire 用户级状态。使用 exec_command 时以 sandbox_permissions="require_escalated" 请求原生执行审批，并说明本次用户配对操作；不要在受限沙箱中盲试。审批被拒绝就停止报告，不修改权限设置，不复用过期凭据。':''}`;(deps.stdout??process.stdout).write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext}})+'\n');}
 return captureResult;
 }finally{await trace?.finish();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--root'||args[2]!=='--provider'||!path.isAbsolute(args[1]))throw Error('invalid_arguments');process.exitCode=await routeHook({installRoot:args[1],home:os.homedir(),sourceRoot:args[1],nodeExe:process.execPath},args[3] as Provider,process.stdin);}catch(e:any){process.stderr.write('labus_router_error '+(/^[a-z_]+$/.test(e.message)?e.message:'invalid_input')+'\n');process.exitCode=1;}}
