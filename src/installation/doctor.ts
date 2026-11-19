import path from 'node:path';
import {readFile,stat,open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {inspectChatInstallation} from './configuration.ts';
import {activeConnection} from './connections.ts';
import {inspectConnectionBindings,inspectConnectionRoutes,inspectConnectionWork,connectionState} from './connection-management.ts';
import {safePath,optional,hash} from './paths.ts';
import {inspectService} from './service.ts';
import {pairEndpoints,inspectPairHealth} from '../pairing/health.ts';
import {errorGuidance} from './guidance.ts';
import type {InstallContext,PairedConnectionRecord} from './model.ts';
import type {PairDeps} from '../pairing/model.ts';
import {readAutomation,listPairJobs} from '../pairing/jobs.ts';import {inspectPairWorker} from '../pairing/worker.ts';

type Check={id:string;status:'ok'|'warning'|'error'|'unverified';code:string;summary:string;nextAction:string};
export async function probeInstallationWrite(root:string){
 const file=await safePath(root,path.join(root,'.doctor-'+randomUUID()+'.tmp'));let handle;
 try{handle=await open(file,'wx',0o600);await handle.writeFile('agentwire-doctor-write-check\n');await handle.sync();}finally{if(handle){try{await handle.close();}finally{await unlink(file);}}}
}
type Options={env?:Record<string,string|undefined>;checkWrite?:boolean;connectionDeps?:PairDeps;probeWrite?:typeof probeInstallationWrite};
export async function diagnoseInstallation(c:InstallContext,options:Options={}){
 const env=options.env||process.env,checks:Check[]=[];
 let automation:any;
 try{const a=await readAutomation(c);automation={mode:a.enabled?'auto':'manual',worker:await inspectPairWorker(c),jobs:(await listPairJobs(c)).map(j=>({requestId:j.requestId,phase:j.phase,notification:j.notification.phase,errorCode:j.errorCode}))};}catch{automation={errorCode:'pairing_automation_requires_check'};}
 const add=(id:string,status:Check['status'],code:string,summary?:string,nextAction?:string)=>{const guidance=errorGuidance(code);checks.push({id,status,code,summary:summary||guidance.summary,nextAction:nextAction||guidance.nextAction});};
 const capture=async(id:string,fn:()=>Promise<unknown>,code:string)=>{try{await fn();add(id,'ok','verified','检查通过。','none');return true;}catch(e:any){const actual=['EPERM','EACCES'].includes(e.code)?'storage_access_denied':/^[a-z_]+$/.test(e.message||'')?e.message:code;add(id,'error',actual);return false;}};
 const paths={home:c.home,installRoot:path.resolve(c.installRoot),runtimeRoot:path.join(c.installRoot,'runtime'),nodeExe:c.nodeExe,nodeVersion:process.versions.node,pinnedRoot:env.AGENTWIRE_INSTALL_ROOT||null,localAppData:env.LOCALAPPDATA||null};
 add('node_runtime',Number(process.versions.node.split('.')[0])>=24?'ok':'error','node_runtime',`当前 Node ${process.versions.node}，要求 >=24。`,'use_node_24_or_newer');
 const exists=await capture('install_root',async()=>{if(!(await stat(await safePath(c.installRoot,c.installRoot))).isDirectory())throw Error('install_root_missing');},'install_root_missing');
 if(env.AGENTWIRE_INSTALL_ROOT&&(!path.isAbsolute(env.AGENTWIRE_INSTALL_ROOT)||path.relative(path.resolve(env.AGENTWIRE_INSTALL_ROOT),paths.installRoot)!==''))add('install_root_pin','error','install_root_mismatch');
 else add('install_root_pin','ok','install_root_resolved','本次执行实际使用上述 installRoot。','none');
 let installation:any;try{installation=await inspectChatInstallation(c);for(const p of ['codex','claude'])for(const [key,label] of [['hookFile','hook'],['skillFile','skill'],['runtimeEntry','runtime']]){const value=installation[p][key];add(p+'_'+label,['configured','present'].includes(value)?'ok':'error',p+'_'+label+'_'+value,`${p} ${label}: ${value}`,'review_setup_preview_no_automatic_configuration_changes');}}catch{add('installation','error','installation_inspection_failed');}
 add('native_trust','unverified','native_trust_unverified','文件配置不能证明原生程序已加载或信任 Hook。','inspect_hooks_in_exact_native_chat');
 await capture('runtime_artifacts',async()=>{
  const bytes=await readFile(await safePath(c.installRoot,path.join(c.installRoot,'install','manifest.json')));if(bytes.length>2097152)throw Error('invalid_manifest');const manifest=JSON.parse(bytes.toString());
  if(manifest.schemaVersion!==1||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files)||!Object.keys(manifest.files).length||Object.keys(manifest.files).length>10000)throw Error('invalid_manifest');
  for(const [file,expected] of Object.entries(manifest.files)){if(!path.isAbsolute(file)||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw Error('invalid_manifest');const actual=await optional(await safePath(c.installRoot,file));if(!actual||hash(actual)!==expected)throw Error('runtime_artifact_changed');}
 },'runtime_manifest_unavailable');
 if(options.checkWrite&&exists)await capture('write_access',()=> (options.probeWrite||probeInstallationWrite)(paths.installRoot),'write_probe_failed');
 else add('write_access','unverified','write_access_unverified',exists?'尚未实测当前执行环境的写入权限。':'安装目录缺失，未创建探针。',exists?'doctor_check_write_to_test_current_execution_environment':'review_setup_preview');
 let transition=false;try{transition=!!await optional(await safePath(c.installRoot,path.join(c.installRoot,'connection-transition.json')));add('connection_transition',transition?'error':'ok',transition?'connection_switch_requires_check':'no_pending_switch',transition?undefined:'没有未完成的连接切换。',transition?undefined:'none');}catch{add('connection_transition','error','connection_switch_requires_check');}
 let connection;try{connection=await activeConnection(c,true);}catch(e:any){if(e.message==='not_connected')add('active_connection','warning','not_connected','尚无活动连接。','pair_exact_chats');else add('active_connection','error','active_connection_requires_check');}
 let pairHealth;
 await capture('connection_routes',()=>inspectConnectionRoutes(c,connection),'connection_routes_require_check');
 if(connection){
  add('active_connection',connection.phase==='disconnected'?'warning':'ok','saved_connection',`保存状态: ${connection.phase}；不代表本次通信已验证。`,'inspect_endpoint_and_roundtrip_checks');
  await capture('connection_bindings',()=>inspectConnectionBindings(c,connection),'connection_bindings_require_check');
  await capture('connection_work',async()=>{const work=await inspectConnectionWork(c,connection.connectionId);if(work.unfinished)throw Error('connection_has_unfinished_tasks');if(work.nativeOutstanding)throw Error('connection_native_work_outstanding');if(work.artifactsPending)throw Error('connection_storage_requires_check');},'connection_storage_requires_check');
  try{const h=await inspectService(connectionState(c,connection.connectionId));add('bus_service',h.status==='running'?'ok':'error',h.status==='running'?'bus_running':'service_storage_requires_check',`本地 Bus: ${h.status}`,'inspect_original_bus_without_resending_tasks');}catch(e:any){const offline=['ENOENT','ECONNREFUSED'].includes(e.code),unsupported=e.message==='bus_diagnostic_protocol_unverified';add('bus_service',offline?'warning':unsupported?'unverified':'error',offline?'bus_offline':unsupported?'bus_diagnostic_protocol_unverified':'service_identity_unconfirmed',offline?'本地 Bus 当前离线；不会为诊断自动启动。':unsupported?'无法确认此 Bus 支持只读诊断；未向旧服务发送未知命令。':'本地 Bus 身份或应答未确认。','check_existing_pair_service_before_delegation_do_not_resend');}
  const endpoint=await pairEndpoints(c,connection as PairedConnectionRecord,options.connectionDeps);
  for(const p of ['codex','claude'] as const)add(p+'_endpoint',endpoint[p]==='detected'?'ok':endpoint[p]==='offline'?'warning':'unverified',p+'_endpoint_'+endpoint[p],`${p} 精确端点观察: ${endpoint[p]}`,'open_or_resume_exact_chat_history_is_not_online_proof');
  if(connection.schemaVersion===2){try{pairHealth=await inspectPairHealth(c,connection,options.connectionDeps);}catch{add('roundtrip_evidence','error','connection_storage_requires_check');}}
 }
 const diagnosticStatus=checks.some(x=>x.status==='error')?'needs_check':'checked';
 return {paths,checks,installation,connection,pairHealth,automation,diagnosticStatus,phase:connection?.phase==='disconnected'&&!transition?'disconnected':diagnosticStatus==='needs_check'?'needs_check':connection?.phase||'disconnected'};
}
