import type {InstallContext} from '../installation/model.ts';
import type {PairJob} from './jobs.ts';
import {activeConnection,sameChat,samePair} from '../installation/connections.ts';
import {readPairState} from './store.ts';
import {errorGuidance} from '../installation/guidance.ts';

type Description={status:string;summary:string;nextStep:string};
/** A read-only identity check, never proof that either endpoint is online. */
async function originalPairStillSaved(c:InstallContext,j:PairJob){
 try{
  const state=await readPairState(c),intent=state.intents.find(i=>i.intentId===j.intentId);
  if(intent?.command.kind!=='redeem')return false;
  const command=intent.command,inv=state.invitations.find(i=>i.code===command.code);
  if(inv?.state!=='claimed'||inv.issuer.provider!==command.target||inv.issuer.provider===intent.source.provider)return false;
  const a=state.activations.find(a=>a.activationId===inv.activationId);
  if(!a||a.phase!=='paired'||!sameChat(a[intent.source.provider],intent.source)||!sameChat(a[inv.issuer.provider],inv.issuer))return false;
  const current=await activeConnection(c);
  return current.schemaVersion===2&&current.connectionId===a.connectionId&&['paired','offline'].includes(current.phase)&&!current.errorCode&&samePair(current,a)&&!state.activations.some(x=>x.connectionId===current.connectionId&&x.phase!=='paired');
 }catch{return false;}
}
export async function pairOperationDescription(c:InstallContext,j:PairJob,now=Date.now()):Promise<Description>{
 const r=j.result;
 if(j.phase==='succeeded'&&r?.ok===true){
  if(r.action==='issue'){
   if(!Number.isFinite(Date.parse(r.data?.expiresAt))||now>=Date.parse(r.data.expiresAt))return {status:'succeeded',summary:'连接码已生成，但现已过期或有效期待核对；发码不表示已配对。',nextStep:'请在目标聊天重新生成连接码，不要使用旧码。'};
   let available=false;try{available=(await readPairState(c)).invitations.some(i=>i.issueIntentId===j.intentId&&i.state==='available');}catch{}
   return available?{status:'succeeded',summary:'连接码已生成；仅已发码，尚未建立配对。',nextStep:'请在另一方聊天输入本次有效连接码；不要重复发码。'}:{status:'succeeded',summary:'连接码已生成，但现已使用、失效或有效状态待核对。',nextStep:'请先查询当前配对状态，不要使用旧码或盲目重新配对。'};
  }
  return {status:'succeeded',summary:'配对已保存；双方身份已确认，当前任务通信需单独验证。',nextStep:'无需重新配对；可向对方发送实际任务。'};
 }
 if(j.phase==='disabled')return {status:'disabled',summary:'本次自动配对未执行，自动配对已停用。',nextStep:'请先查看配对模式；本请求不会自动重放。'};
 const code=r?.errorCode||j.errorCode;
 if(code){
  const guidance=errorGuidance(code);
  if(code==='pairing_code_used'&&await originalPairStillSaved(c,j))return {status:'rejected',summary:'本次重复兑换被拒绝；原配对仍有效（身份配对已核对，不代表当前通信已验证）。',nextStep:'无需重新配对，也不要重复兑换同一码；可查询当前配对状态。'};
  return {status:j.phase==='needs_check'?'needs_check':'rejected',summary:guidance.summary,nextStep:guidance.nextStep};
 }
 if(['waiting_native','verified','applying'].includes(j.phase))return {status:'pending',summary:'配对请求已登记，尚未确认完成。',nextStep:'等待程序结果；不要重复输入连接码。'};
 return {status:'needs_check',summary:'本次操作结果待核对，暂不能确认配对成功。',nextStep:'请保留当前状态，查询本次结果，不要盲目重试。'};
}
export async function pairJobDescription(c:InstallContext,j:PairJob,now=Date.now()){
 const n=j.notification,proven=n.phase==='delivered'&&typeof n.evidenceRef==='string'&&!!n.evidenceRef.trim();
 const status=n.phase==='delivered'&&!proven?'needs_check':n.phase;
 const summaries:Record<string,string>={
  pending:'结果通知尚未发送。',attempted:'结果通知已尝试发送，送达待核对。',
  needs_check:'结果通知送达待核对；这不改变操作结果。',
  offline:'通知通路报告离线，尚未确认送达；这不改变操作结果。',
  suppressed:'结果通知已按授权停止追踪。',delivered:'结果通知已确认送达；不代表业务任务已通过验证。'
 };
 return {operation:await pairOperationDescription(c,j,now),notification:{status,summary:summaries[status],nextStep:proven?'无需处理通知。':status==='suppressed'?'无需重发通知。':'查询本次通知记录；不要为通知问题重复兑换连接码。'}};
}
