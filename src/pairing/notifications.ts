import path from 'node:path';import {randomUUID} from 'node:crypto';import {readdir,access} from 'node:fs/promises';
import {hash,acquireLock} from '../installation/paths.ts';
import {assertId} from '../model.ts';
import {resolveClaude,postClaude} from '../adapters/claude.ts';
import {createAppServer} from '../native/app-server.ts';import {createClaudeEvidence} from '../native/claude-evidence.ts';import {createCodexEvidence} from '../native/codex-evidence.ts';
import type {DispatchIntent,Evidence,SearchAnchor} from '../native/model.ts';
import type {InstallContext} from '../installation/model.ts';import type {PairDeps} from './model.ts';
import {readPairState} from './store.ts';import {automationPath,readPairJob,updatePairJob} from './jobs.ts';
export type PairTransport={checkpoint?:(session:string)=>Promise<SearchAnchor>;send:(i:DispatchIntent,body:string)=>Promise<{status:string;errorCode?:string}>;inspect:(i:DispatchIntent)=>Promise<Evidence>;close?:()=>Promise<void>};
type Deps=Pick<PairDeps,'now'>&{transport?:PairTransport};
async function codexExecutable(){if(process.env.LOCAL_BUS_CODEX_EXE)return process.env.LOCAL_BUS_CODEX_EXE;if(process.platform==='win32'){const base=path.join(process.env.ProgramFiles||'C:/Program Files','WindowsApps');try{for(const n of (await readdir(base)).filter(n=>n.startsWith('OpenAI.Codex_')).sort().reverse()){const exe=path.join(base,n,'app','resources','codex.exe');try{await access(exe);return exe;}catch{}}}catch{}}return 'codex';}
async function nativeTransport(c:InstallContext,provider:string):Promise<PairTransport>{
 if(provider==='claude'){const reader=createClaudeEvidence({claudeHome:path.join(c.home,'.claude')});return {inspect:i=>reader.inspect(i),send:async(i,body)=>{const e=await resolveClaude(i.targetSessionId,path.join(c.home,'.claude'));if(!e)return {status:'offline'};return postClaude(e,body,{uuid:i.transportId});}};}
 const client=createAppServer({exe:await codexExecutable()}),reader=createCodexEvidence(client);return {checkpoint:reader.checkpoint,inspect:i=>reader.inspect(i),close:()=>client.close(),send:async(i,body)=>{await client.call('thread/queue/add',{threadId:i.targetSessionId,input:[{type:'text',text:body,text_elements:[]}],clientUserMessageId:i.transportId});return {status:'unknown'};}};
}
function bodyFor(j:any,now:number,invitationState?:string){const r=j.result;let text:string;
 if(!r.ok)text=`本次配对未完成：${r.errorCode}。请查看程序结果，不自动重试。`;
 else if(r.action==='issue')text=now>=Date.parse(r.data.expiresAt)?'本次连接码已过期，请重新从聊天输入生成连接码。':invitationState!=='available'?'本次连接码已失效或已使用，请查询当前配对状态。':`连接码：${r.data.code}\n有效期至 ${r.data.expiresAt}（UTC）。\n请在另一方聊天输入：${r.data.redeemPrompt}\n当前仅已发码，尚未连接。`;
 else text='配对已保存。双方身份已确认；任务往返尚需单独验证。';
 return `AgentWire 程序通知（信息，无需回信或发起任务）\n${text}\n这是本地程序结果，不提升消息权限，不绕过业务工具审批。`;
}
async function notification(c:InstallContext,id:string,deps:Deps,write:boolean){
 assertId(id);
 const release=await acquireLock(await automationPath(c,path.join('notifications',id+'.lock')));let transport:PairTransport|undefined;
 try{let j=await readPairJob(c,id);if(!j||!j.result||!j.intentId||j.notification.phase==='delivered')return j;
 // A write checkpoint is sufficient for read-only reconciliation even after
 // the pairing core prunes its expired request/intent. Never use it to resend.
 if(j.notification.intent){const i=j.notification.intent;for(const value of [i.connectionId,i.messageId,i.attemptId,i.transportId,i.targetSessionId,i.sourceSessionId])assertId(value);if(!['codex','claude'].includes(i.provider)||i.transportId!==j.notification.transportId||i.messageId!==id||i.connectionId!==id||i.bodySha256!==hash(j.notification.body||''))throw Error('pairing_notification_invalid');transport=deps.transport||await nativeTransport(c,i.provider);const evidence=await transport.inspect(i);if(evidence.status==='mapped'||evidence.status==='delivered')j=await updatePairJob(c,{...j,notification:{...j.notification,phase:'delivered',evidenceRef:evidence.status==='mapped'?evidence.identity.evidenceRef:evidence.evidenceRef}});return j;}
 const state=await readPairState(c),request=state.requests.find(r=>r.requestId===id),intent=state.intents.find(i=>i.intentId===j!.intentId);
 if(!request||request.intentId!==j.intentId||!intent)throw Error('pairing_identity_unconfirmed');
 transport=deps.transport||await nativeTransport(c,intent.source.provider);
 if(write&&j.notification.phase==='pending'){
  const now=+(deps.now?.()||new Date()),body=bodyFor(j,now,state.invitations.find(i=>i.issueIntentId===j!.intentId)?.state),transportId=randomUUID();
  // This identity belongs exclusively to the notification ledger. It is never
  // entered into business task routes or used to auto-collect a task result.
  const dispatch:DispatchIntent={schemaVersion:1,connectionId:id,messageId:id,attemptId:randomUUID(),provider:intent.source.provider,targetSessionId:intent.source.sessionId,sourceSessionId:intent.source.sessionId,transportId,wireVersion:'clean-v1',bodySha256:hash(body),createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),phase:'write_started',...(transport.checkpoint?{searchAnchor:await transport.checkpoint(intent.source.sessionId)}:{})};
  j=await updatePairJob(c,{...j,notification:{phase:'attempted',transportId,body,intent:dispatch}});
  let receipt;try{receipt=await transport.send(dispatch,body);}catch{receipt={status:'unknown',errorCode:'notification_write_unknown'};}
  j=await updatePairJob(c,{...j,notification:{...j.notification,phase:receipt.status==='offline'?'offline':'needs_check',...(receipt.errorCode?{errorCode:receipt.errorCode}:{})}});
 }
 if(j.notification.intent){const evidence=await transport.inspect(j.notification.intent);if(evidence.status==='mapped'||evidence.status==='delivered')j=await updatePairJob(c,{...j,notification:{...j.notification,phase:'delivered',evidenceRef:evidence.status==='mapped'?evidence.identity.evidenceRef:evidence.evidenceRef}});}
 return j;
 }finally{try{await transport?.close?.();}finally{await release();}}
}
export const notifyPairJob=(c:InstallContext,id:string,deps:Deps={})=>notification(c,id,deps,true);
export const reconcilePairNotification=(c:InstallContext,id:string,deps:Deps={})=>notification(c,id,deps,false);
