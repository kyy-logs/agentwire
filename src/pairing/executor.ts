import {resolvePairRequest} from './requests.ts';
import {issueCode} from './store.ts';
import {redeemCode} from './service.ts';
import type {InstallContext} from '../installation/model.ts';
import type {PairDeps} from './model.ts';
import {withPairOperation} from './operations.ts';

/** Shared program operation. No model invocation, source override, or latest lookup. */
export async function executePairRequest(c:InstallContext,requestId:string,deps:PairDeps&{beforeOperation?:(intentId:string)=>Promise<void>;expectedAction?:string}={}):Promise<any>{
 let action='unknown',intentId:string|undefined;
 try{return await withPairOperation(c,async()=>{
  const intent=await resolvePairRequest(c,requestId,deps);intentId=intent.intentId;action=intent.command.kind;if(deps.expectedAction&&deps.expectedAction!==action)throw Error('pairing_identity_unconfirmed');await deps.beforeOperation?.(intentId);
  if(action==='issue'){
   const result=await issueCode(c,intentId,deps),issuer=result.issuer.provider==='claude'?'Claude':'Codex';
   return {ok:true,operation:'pair',action,phase:'code_issued',intentId,data:{...result,redeemIn:result.issuer.provider==='claude'?'codex':'claude',redeemPrompt:`连接 ${issuer}，连接码 ${result.code}`}};
  }
  const connection=await redeemCode(c,intentId,deps);return {ok:true,operation:'pair',action,phase:connection.phase,intentId,data:{connection}};
 });
 }catch(e:any){return {ok:false,operation:'pair',action,...(intentId?{intentId}:{}),errorCode:['EPERM','EACCES'].includes(e.code)?'pairing_storage_access_denied':/^[a-z_]+$/.test(e.message||'')?e.message:'pairing_execution_requires_check'};}
}
