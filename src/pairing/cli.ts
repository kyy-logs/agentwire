import {parseArgs} from 'node:util';
import {resolvePairRequest} from './requests.ts';
import {issueCode} from './store.ts';
import {redeemCode} from './service.ts';
import {inspectPairHealth} from './health.ts';
import {activeConnection,inspectConnection} from '../installation/connections.ts';
import type {InstallContext} from '../installation/model.ts';
import type {PairDeps} from './model.ts';
export async function runPairCommand(c:InstallContext,args:string[],io:{stdout:{write(s:string):unknown}},deps:PairDeps={}):Promise<number>{
 const emit=(v:unknown)=>io.stdout.write(JSON.stringify(v)+'\n');let action='unknown';
 try{const {positionals,values}=parseArgs({args,allowPositionals:true,strict:true,options:{intent:{type:'string'}}});action=positionals[0];if(positionals.length!==1||!['issue','redeem','status'].includes(action))throw Error('invalid_command');
  if(action==='status'){if(values.intent)throw Error('unexpected_option');let r;try{r=await activeConnection(c);}catch(e:any){if(e.message!=='not_connected')throw e;emit({ok:true,operation:'pair',phase:'disconnected',nextAction:'generate_code_in_target_chat'});return 0;}
   const checked=await inspectConnection(c,r.connectionId);emit({ok:true,operation:'pair',phase:checked.phase,data:{connection:checked,...(checked.schemaVersion===2?{health:await inspectPairHealth(c,checked,deps)}:{})},nextAction:checked.schemaVersion===2?'paired_identity_only_tasks_need_native_evidence':'legacy_probe_admission_unchanged'});return 0;}
  if(!values.intent)throw Error('pairing_identity_unconfirmed');const intent=await resolvePairRequest(c,values.intent,deps);if(intent.command.kind!==action)throw Error('pairing_identity_unconfirmed');
  if(action==='issue'){const result=await issueCode(c,intent.intentId,deps),issuer=result.issuer.provider==='claude'?'Claude':'Codex';emit({ok:true,operation:'pair',phase:'code_issued',data:{...result,redeemIn:result.issuer.provider==='claude'?'codex':'claude',redeemPrompt:`连接 ${issuer}，连接码 ${result.code}`},nextAction:'enter_code_in_other_chat_within_five_minutes'});return 0;}
  const r=await redeemCode(c,intent.intentId,deps);emit({ok:true,operation:'pair',phase:r.phase,data:{connection:r,...(r.schemaVersion===2?{health:await inspectPairHealth(c,r,deps)}:{})},nextAction:r.schemaVersion===2?'identity_paired_roundtrip_unverified':'legacy_admission_unchanged'});return 0;
 }catch(e:any){const errorCode=/^[a-z_]+$/.test(e.message||'')?e.message:String(e.code||'').startsWith('ERR_PARSE_ARGS')?'unexpected_option':'pairing_activation_requires_check';emit({ok:false,operation:'pair',action,errorCode,nextAction:'check_exact_current_native_request_do_not_guess_or_change_permissions'});return ['invalid_command','unexpected_option'].includes(errorCode)?2:3;}
}
