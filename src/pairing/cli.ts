import {parseArgs} from 'node:util';
import {readPairState} from './store.ts';import {parsePairCommand} from './capture.ts';
import {withInstallLock} from '../installation/paths.ts';
import {inspectPairHealth} from './health.ts';
import {activeConnection,inspectConnection} from '../installation/connections.ts';
import type {InstallContext} from '../installation/model.ts';
import type {PairDeps} from './model.ts';
import {errorGuidance} from '../installation/guidance.ts';
import {executePairRequest} from './executor.ts';
import {readAutomation,setAutomation,readPairJob} from './jobs.ts';
import {recoverPairJob} from './worker.ts';
import {notifyPairJob,pairJobView} from './notifications.ts';import type {PairTransport} from './notifications.ts';
export async function runPairCommand(c:InstallContext,args:string[],io:{stdout:{write(s:string):unknown}},deps:PairDeps&{notificationTransport?:PairTransport}={}):Promise<number>{
 const emit=(v:unknown)=>io.stdout.write(JSON.stringify(v)+'\n');let action='unknown';
 try{const {positionals,values}=parseArgs({args,allowPositionals:true,strict:true,options:{intent:{type:'string'},request:{type:'string'},mode:{type:'string'},apply:{type:'boolean'}}});action=positionals[0];if(positionals.length!==1||!['issue','redeem','status','mode','result','recover'].includes(action))throw Error('invalid_command');
  const allowed:Record<string,string[]>={issue:['intent'],redeem:['intent'],status:[],mode:['mode','apply'],result:['request'],recover:['request']};if(Object.keys(values).some(k=>!allowed[action].includes(k)))throw Error('unexpected_option');
  if(action==='mode'){if(!['auto','manual'].includes(values.mode||''))throw Error('unexpected_option');const enabled=values.mode==='auto',current=await readAutomation(c);emit({ok:true,operation:'pair',phase:values.apply?'configured':'preview',data:values.apply?await withInstallLock(c,()=>setAutomation(c,enabled,deps)):{current,requested:values.mode,scope:'exact_human_pairing_only_no_business_commands'},nextAction:values.apply?'new_native_inputs_only_old_jobs_never_replayed':'review_automatic_hook_execution_scope_then_apply'});return 0;}
  if(action==='result'||action==='recover'){if(!values.request)throw Error('pairing_job_missing');let job=action==='recover'?await recoverPairJob(c,values.request,deps):await readPairJob(c,values.request);if(!job)throw Error('pairing_job_missing');let notificationError:string|undefined;if(action==='recover'){try{job=(await notifyPairJob(c,values.request,{now:deps.now,transport:deps.notificationTransport}))||job;}catch{notificationError='notification_requires_check';}}const codeExpired=job.result?.action==='issue'&&+(deps.now?.()||new Date())>=Date.parse(job.result.data.expiresAt);const now=+(deps.now?.()||new Date()),view=pairJobView(job,now);emit({ok:true,operation:'pair',phase:view.phase,data:{job:view,requestExpired:now>=Date.parse(job.expiresAt),codeExpired,notificationError},nextAction:'inspect_exact_program_result_notification_is_separate'});return 0;}
  if(action==='status'){if(values.intent)throw Error('unexpected_option');let r;try{r=await activeConnection(c);}catch(e:any){if(e.message!=='not_connected')throw e;emit({ok:true,operation:'pair',phase:'disconnected',nextAction:'generate_code_in_target_chat'});return 0;}
   const checked=await inspectConnection(c,r.connectionId);emit({ok:true,operation:'pair',phase:checked.phase,data:{connection:checked,...(checked.schemaVersion===2?{health:await inspectPairHealth(c,checked,deps)}:{})},nextAction:checked.schemaVersion===2?'paired_identity_only_tasks_need_native_evidence':'legacy_probe_admission_unchanged'});return 0;}
  if(!values.intent)throw Error('pairing_identity_unconfirmed');const request=(await readPairState(c)).requests.find(r=>r.requestId===values.intent);if(!request||parsePairCommand(request.event.prompt)?.kind!==action)throw Error('pairing_identity_unconfirmed');
  const managed=await readPairJob(c,values.intent),result=managed?(await recoverPairJob(c,values.intent,deps)).result:await executePairRequest(c,values.intent,{...deps,expectedAction:action});if(!result?.ok)throw Error(result?.errorCode||'pairing_execution_requires_check');
  if(action==='issue'){emit({...result,nextAction:'enter_code_in_other_chat_within_one_hour'});return 0;}
  const r=result.data.connection;emit({...result,data:{connection:r,...(r.schemaVersion===2?{health:await inspectPairHealth(c,r,deps)}:{})},nextAction:r.schemaVersion===2?'identity_paired_roundtrip_unverified':'legacy_admission_unchanged'});return 0;
 }catch(e:any){const accessDenied=['EPERM','EACCES'].includes(e.code),errorCode=accessDenied?'pairing_storage_access_denied':/^[a-z_]+$/.test(e.message||'')?e.message:String(e.code||'').startsWith('ERR_PARSE_ARGS')?'unexpected_option':'pairing_activation_requires_check';emit({ok:false,operation:'pair',action,errorCode,...errorGuidance(errorCode)});return ['invalid_command','unexpected_option'].includes(errorCode)?2:3;}
}
