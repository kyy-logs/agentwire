import {actionDigest,sameActor} from './model.ts';
import type {ActionRequest,ActionEvidence,TaskRecord} from './model.ts';
import type {DispatchIntent} from '../native/model.ts';
function argv(s:string):string[]|undefined{
 if(/[;&|\r\n\x60$<>]/.test(s))return;
 const out:string[]=[];let i=0;while(i<s.length){while(s[i]===' ')i++;if(i===s.length)break;const q=s[i]==='"'?'"':s[i]==="'"?"'":undefined;let t='';if(q){i++;while(i<s.length&&s[i]!==q)t+=s[i++];if(s[i++]!==q||i<s.length&&s[i]!==' ')return;}else{while(i<s.length&&s[i]!==' '){if(/["']/.test(s[i]))return;t+=s[i++];}}out.push(t);}return out;
}
function matches(command:unknown,r:ActionRequest,launchers:string[]){
 if(typeof command!=='string')return false;const a=argv(command);if(!a||!launchers.includes(a[0])||a[1]!==r.kind)return false;
 const opts=new Map<string,string>();for(let n=2;n<a.length;n+=2){if(!a[n]?.startsWith('--')||!a[n+1]||opts.has(a[n]))return false;opts.set(a[n],a[n+1]);}
 const expect:any={'--provider':r.actor.provider,'--source-session':r.actor.sessionId,'--task':r.taskId,'--operation':r.operationId,'--revision':String(r.expectedRevision)};
 if(r.questionId)expect['--question']=r.questionId;if(r.deliveryId)expect['--delivery']=r.deliveryId;
 for(const [k,v]of Object.entries(expect))if(opts.get(k)!==v)return false;
 const body=['question','answer','revise'].includes(r.kind),bodykeys=['--text','--text-file'].filter(k=>opts.has(k));
 if(body&&bodykeys.length!==1||!body&&bodykeys.length)return false;
 if(opts.has('--text')&&opts.get('--text')!==r.body)return false;
 return [...opts.keys()].every(k=>k in expect||bodykeys.includes(k));
}
function receipt(output:any,r:ActionRequest):boolean{
 if(Array.isArray(output))return output.some(b=>b?.type==='input_text'&&receipt(b.text,r));
 if(typeof output==='object'&&output!==null){if(output.ok===true&&output.operation===r.kind&&output.phase==='pending_verification'&&output.data?.operationId===r.operationId&&output.data?.requestSha256===actionDigest(r))return true;return typeof output.output==='string'&&receipt(output.output,r);}
 if(typeof output!=='string'||output.length>2097152)return false;
 try{return receipt(JSON.parse(output),r);}catch{}
 return output.split(/\r?\n/).some(line=>{try{return receipt(JSON.parse(line),r);}catch{return false;}});
}
function result(candidates:ActionEvidence[]):ActionEvidence{return candidates.length>1?{status:'conflict',errorCode:'multiple_native_executions'}:candidates[0]??{status:'pending'};}
export function proveCodexAction(rows:any[],r:ActionRequest,launchers:string[]):ActionEvidence{
 if(rows.length>100000)return {status:'limit'};const metas=rows.filter(x=>x.type==='session_meta');if(metas.length!==1||metas[0].payload?.id!==r.actor.sessionId||!['vscode','cli'].includes(metas[0].payload.source))return {status:'unavailable'};
 const all=rows.map(x=>x.type==='response_item'?x.payload:x.payload??x),verified:ActionEvidence[]=[];let pending=false;
 for(const call of all){if(call.type!==undefined&&call.type!=='custom_tool_call'||call.name!=='exec'||typeof call.input!=='string')continue;
 const m=/^text\(\(await tools\.exec_command\((\{[\s\S]*\})\)\)\.output\);?$/.exec(call.input);if(!m)continue;let cmd;try{cmd=JSON.parse(m[1]).cmd;}catch{continue;}if(!matches(cmd,r,launchers))continue;
 const turn=call.internal_chat_message_metadata_passthrough?.turn_id;if(typeof turn!=='string')continue;
 const outputs=all.filter(x=>x.call_id===call.call_id&&x!==call&&x.output!==undefined);
 if(!outputs.length){pending=true;continue;}if(outputs.length!==1||outputs[0].internal_chat_message_metadata_passthrough?.turn_id!==turn||!receipt(outputs[0].output,r))continue;
 const starts=all.filter(x=>x.type==='task_started'&&x.turn_id===turn);if(starts.length!==1)continue;const attr=starts[0].turn_attribution;
 verified.push({status:'verified',ref:{...r.actor,nativeExecutionId:turn},requestSha256:actionDigest(r),evidenceRef:'codex:'+r.actor.sessionId+':'+call.call_id,human:attr?.turn_trigger==='composer'&&attr.parent_turn_id===null&&attr.initiating_agent_path===null});
 }return verified.length?result(verified):{status:pending?'pending':'unavailable'};
}
export function proveClaudeAction(rows:any[],r:ActionRequest,launchers:string[]):ActionEvidence{
 if(rows.length>100000)return {status:'limit'};const verified:ActionEvidence[]=[];let pending=false;
 const valid=(x:any)=>x.sessionId===r.actor.sessionId&&x.isSidechain===false&&!x.agentId;
 const byId=new Map<string,any[]>();for(const x of rows)if(typeof x.uuid==='string')byId.set(x.uuid,[...(byId.get(x.uuid)??[]),x]);
 for(const call of rows){if(!valid(call)||call.type!=='assistant'||!Array.isArray(call.message?.content))continue;
 for(const tool of call.message.content){if(tool.type!=='tool_use'||tool.name!=='Bash'||!matches(tool.input?.command,r,launchers))continue;
 const outputs=rows.filter(x=>x.type==='user'&&Array.isArray(x.message?.content)&&x.message.content.some((b:any)=>b.type==='tool_result'&&b.tool_use_id===tool.id));
 if(!outputs.length){pending=true;continue;}if(outputs.length!==1)continue;const out=outputs[0];if(!valid(out)||out.parentUuid!==call.uuid||out.sourceToolAssistantUUID!==call.uuid)continue;
 let cursor=call,root:any,seen=new Set<string>();for(let n=0;n<10000;n++){if(!valid(cursor)||seen.has(cursor.uuid))break;seen.add(cursor.uuid);
 if(cursor.type==='user'&&!Array.isArray(cursor.message?.content)){root=cursor;break;}
 if(cursor.type==='user'&&cursor.origin){root=cursor;break;}
 const p=byId.get(cursor.parentUuid);if(p?.length!==1)break;cursor=p[0];}
 if(!root||typeof root.promptId!=='string'||out.promptId!==root.promptId)continue;
 const blocks=out.message.content.filter((b:any)=>b.type==='tool_result'&&b.tool_use_id===tool.id);if(blocks.length!==1||!receipt(blocks[0].content,r))continue;
 verified.push({status:'verified',ref:{...r.actor,nativeExecutionId:root.promptId},requestSha256:actionDigest(r),evidenceRef:'claude:'+r.actor.sessionId+':'+out.uuid,human:root.origin?.kind==='human'});
 }}return verified.length?result(verified):{status:pending?'pending':'unavailable'};
}
export function verifyActionOwnership(task:TaskRecord,r:ActionRequest,e:ActionEvidence,inputs:DispatchIntent[]){
 const executor=['question','deliver'].includes(r.kind),actor=executor?task.executor:task.initiator;
 if(!sameActor(r.actor,actor))throw Error('collaboration_role_mismatch');
 if(e.status!=='verified'||e.requestSha256!==actionDigest(r)||!sameActor(e.ref,r.actor))throw Error('collaboration_action_unverified');
 const matches=inputs.filter(i=>['mapped','terminal','reply_committed','delivered'].includes(i.phase)&&i.provider===r.actor.provider&&i.targetSessionId===r.actor.sessionId&&i.nativeExecutionId===e.ref.nativeExecutionId&&i.messageId===task.currentMessageId);
 if(matches.length!==1&&!(matches.length===0&&!executor&&e.human===true))throw Error('collaboration_execution_mismatch');return e.ref;
}
