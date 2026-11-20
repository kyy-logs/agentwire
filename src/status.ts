import {assertId} from './model.ts';
import type {MessageRecord} from './model.ts';
// Status is an operational summary. Full body remains available via check(id).
// Bounded text fields prevent adapter diagnostics from inflating IPC frames.
export function statusPage(records:MessageRecord[],options:{after?:string;limit?:number;taskId?:string}={},now=new Date()){
  const limit=options.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('invalid_status_limit');
  if(options.taskId!==undefined)assertId(options.taskId);
  const visible=options.taskId===undefined?records:records.filter(r=>r.message.taskId===options.taskId);
  let start=0;if(options.after!==undefined){assertId(options.after);const at=visible.findIndex(r=>r.message.messageId===options.after);if(at<0)throw new Error('invalid_status_cursor');start=at+1;}
  const selected=visible.slice(start,start+limit);
  const trim=(s:unknown,n:number)=>typeof s==='string'?s.slice(0,n):undefined;
  const items=selected.map(r=>{
    const {body,...message}=r.message;const {receipt,lastError,completion,...rest}=r;
    return {...rest,message,display:messageDescription(r,records,now),lastError:trim(lastError,256),completion:completion?{nativeOutcome:trim(completion.nativeOutcome,32),businessVerdict:trim(completion.businessVerdict,32),eventKey:trim(completion.eventKey,64),artifactRef:trim(completion.artifactRef,256),sha256:trim(completion.sha256,64),truncated:!!completion.truncated}:undefined,receipt:receipt?{status:receipt.status,nativeId:trim(receipt.nativeId,128),evidenceRef:trim(receipt.evidenceRef,512),errorCode:trim(receipt.errorCode,128),retryable:receipt.retryable}:undefined};
  });
  return {items,nextCursor:start+selected.length<visible.length?selected.at(-1)!.message.messageId:null,total:visible.length};
}

/** Display only; never changes admission, retries, deadlines or stored state. */
function messageDescription(r:MessageRecord,records:MessageRecord[],now:Date){
 const status=r.state==='delivered'&&!(r.receipt?.status==='accepted'&&r.receipt.evidenceRef?.trim())?'needs_check':r.state;
 const summaries:Record<string,string>={
  pending:'消息正在排队，尚未确认提交给对方。',
  submitting:'正在提交消息，尚未确认对方收到。',
  submitted:'消息已提交给对方，等待处理结果。',
  completed:'已记录本回合结果；业务结论未验证，结果消息的送达需另行核对。',
  delivered:'回复已送达；内容正确性及业务结论未验证。',
  needs_check:r.lastError==='result_timeout_no_native_cancel'?'等待结果已超时；对方任务是否结束仍待核对。':'消息投递或处理状态待核对，具体原因尚未确认。',
  failed:'本次消息处理失败；对方是否仍有工作需按记录核对。',
  expired:'本次消息已过期；不代表对方任务已取消。',
  stopped:'Bus 已停止追踪本次消息；不代表对方任务已取消。'
 };
 const waiting=waitingDescription(r,records,now);
 return {status,waiting,summary:waiting?.summary??summaries[status],nextStep:waiting?.nextStep??(['needs_check','failed','expired','stopped'].includes(status)?'请检查原消息和原生记录，不要重复发送或自动重试。':status==='completed'?'查看关联结果消息；按任务验收标准核对内容。':status==='delivered'?'无需确认或回信；仅按已授权任务继续。':'等待状态更新，不要重复发送；目前不能判断具体等待原因。')};
}

type WaitingDescription={reason:string;summary:string;nextStep:string;blockedBy?:string;nextAttemptAt?:string};
/** Explain only gates visible in persisted records. This is not a native runtime probe. */
function waitingDescription(r:MessageRecord,records:MessageRecord[],now:Date):WaitingDescription|undefined{
 if(!['pending','submitting','submitted'].includes(r.state))return;
 const noResend='请核对原任务和原生记录，不要重复发送或自行重试。';
 if(Date.parse(r.message.expiresAt)<=+now||r.state==='submitted'&&r.resultDeadlineAt!==undefined&&Date.parse(r.resultDeadlineAt)<=+now)
  return {reason:'deadline_elapsed',summary:'等待期限已到，保存状态尚待调度器核对；不代表对方任务已取消。',nextStep:noResend};
 if(r.state==='pending'){
  const family=records.find(x=>x.message.taskId===r.message.taskId&&(x.stoppedAt||['needs_check','stopped','expired'].includes(x.state)));
  if(family)return {reason:'family_paused',summary:'同一任务存在待核对、过期或停止追踪的记录，后续投递已暂停。',nextStep:noResend,blockedBy:family.message.messageId};

  const retry=r.receipt?.status==='rejected'&&r.receipt.retryable===true;
  const nextAttemptAt=retry&&r.nextAttemptAt&&Date.parse(r.nextAttemptAt)>+now?r.nextAttemptAt:undefined;
  if(nextAttemptAt)return r.receipt?.errorCode==='session_offline'
   ?{reason:'target_offline',summary:'上次投递时未发现目标聊天在线，消息正在等待下一次投递。',nextStep:'请检查已配对的原目标聊天是否打开；程序仅按既有重试规则处理，不要重复发送。',nextAttemptAt}
   :{reason:'retry_backoff',summary:'上次投递被明确拒绝，正在等待已安排的重试时间。',nextStep:'等待程序按既有规则重试；不要手动重复发送。',nextAttemptAt};
  const target=r.message.kind!=='reply'&&records.find(x=>x.message.messageId!==r.message.messageId&&x.message.targetSessionId===r.message.targetSessionId&&x.message.kind!=='reply'&&['submitting','submitted','needs_check'].includes(x.state));
  if(target)return {reason:'target_task_unresolved',summary:'目标聊天已有尚未解决的协作任务，本消息正在等待投递位置。',nextStep:'先查看占用位置的原任务；不能据此判断对方正在计算或等待审批，不要重复发送。',blockedBy:target.message.messageId};
  return {reason:'bus_queue',summary:'消息正在 Bus 排队，尚未确认提交给对方。',nextStep:'等待调度更新；当前没有足够证据说明更具体的原因，不要重复发送。'};
 }
 if(r.state==='submitting')return {reason:'submission_in_progress',summary:'消息正在提交，尚未确认对方收到。',nextStep:'等待投递证据，不要再次发送。'};
 return {reason:'awaiting_result',summary:'消息已提交，正在等待处理结果；具体执行或审批状态尚未确认。',nextStep:'等待原任务结果；若需排查请查看目标原聊天，不要重复发送。'};
}
