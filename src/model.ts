import { isDeepStrictEqual } from 'node:util';
export type AgentBinding={agentId:string;kind:'codex'|'claude';sessionId:string;workspaceRoot:string};
export type MessageInput={messageId:string;kind:'task'|'reply'|'followup';from:string;to?:string;replyTo?:string;body:string;returnMode?:'manual'|'auto'};
type MessageFields={messageId:string;taskId:string;replyTo?:string;kind:MessageInput['kind'];from:string;to:string;targetSessionId:string;body:string;createdAt:string;expiresAt:string;executionIndex:number;returnMode?:'auto'};
export type AgentMessage=MessageFields & ({schemaVersion:1;wireVersion?:never;sourceSessionId?:never}|{schemaVersion:2;wireVersion:'clean-v1';sourceSessionId:string});
export const wireVersion=(m:AgentMessage):'legacy'|'clean-v1'=>m.schemaVersion===2?'clean-v1':'legacy';
export type MessageState='pending'|'submitting'|'submitted'|'completed'|'delivered'|'needs_check'|'failed'|'expired'|'stopped';
export type SubmitResult={status:'accepted'|'rejected'|'unknown';nativeId?:string;evidenceRef?:string;errorCode?:string;retryable?:boolean};
export type ProbeResult={status:'available'|'offline'|'unsupported'|'unknown';details:string[]};
export type ReconcileResult={status:'submitted'|'completed'|'not_found'|'unknown';evidenceRef?:string;nativeId?:string};
export type MessageRecord={activeAttemptId?:string;message:AgentMessage;state:MessageState;attempts:number;updatedAt:string;receipt?:SubmitResult;submittedAt?:string;resultDeadlineAt?:string;resultRef?:string;late?:boolean;lastError?:string;nextAttemptAt?:string;stoppedAt?:string;returnMode?:'manual'|'auto';dispatchNonce?:string;completion?:{nativeOutcome:'response_ended'|'error'|'interrupted';businessVerdict:'unverified';eventKey:string;artifactRef?:string;sha256?:string;truncated:boolean};reminder?:{messageId:string;attemptedAt:string;receipt:SubmitResult}};
export type SubmitOptions={wireVersion?:'legacy'|'clean-v1';transportId?:string;reminderFor?:string;returnMode?:'manual'|'auto';dispatchNonce?:string};
export type RecoveryReport={needsCheckIds:string[];quarantinedFiles:string[];repairedTaskIds:string[];orphanTemporaryFiles?:string[]};
export type Clock={now():Date};
export type ChildRunner=(exe:string,args:readonly string[],options:{timeoutMs:number})=>Promise<{exitCode:number|null;stdout:string;stderr:string;timedOut:boolean}>;
export interface AgentAdapter {
  readonly kind:string;
  probe(binding:AgentBinding):Promise<ProbeResult>;
  submit(binding:AgentBinding,message:AgentMessage,options?:SubmitOptions):Promise<SubmitResult>;
  reconcile(binding:AgentBinding,record:MessageRecord):Promise<ReconcileResult>;
}
export interface MessageStore {
  putNew(message:AgentMessage):Promise<{record:MessageRecord;duplicate:boolean}>;
  get(id:string):Promise<MessageRecord|undefined>;
  replace(record:MessageRecord):Promise<void>;
  list():Promise<MessageRecord[]>;
  recover(now:Date):Promise<RecoveryReport>;
}
export const defaultPolicy={maxExecutions:6,taskTtlMs:1800000,resultTimeoutMs:600000,maxAttempts:3,retryDelaysMs:[1000,5000],reminderAfterMs:300000};
export const realClock:Clock={now:()=>new Date()};
export function assertId(id:string){if(typeof id!=='string'||! /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('invalid message/session id');}
export function assertAgent(id:string){if(typeof id!=='string'||! /^[a-z][a-z0-9_-]{0,39}$/.test(id))throw new Error('invalid agent id');}
export function validateMessage(m:AgentMessage){
  if(!m||![1,2].includes(m.schemaVersion))throw new Error('invalid message schema');
  if(m.schemaVersion===2){if(m.wireVersion!=='clean-v1')throw Error('invalid_wire_version');assertId(m.sourceSessionId);}else if(m.wireVersion!==undefined||m.sourceSessionId!==undefined)throw Error('invalid_legacy_fields');
  if(m.returnMode!==undefined&&m.returnMode!=='auto')throw new Error('invalid return mode');
  assertId(m.messageId);assertId(m.taskId);assertId(m.targetSessionId);if(m.replyTo)assertId(m.replyTo);
  assertAgent(m.from);assertAgent(m.to);if(m.from===m.to)throw new Error('invalid same sender/target');
  if(!['task','reply','followup'].includes(m.kind))throw new Error('invalid message kind');
  if(typeof m.body!=='string'||!m.body.trim()||Buffer.byteLength(m.body)>65536)throw new Error('invalid message body (1..65536 UTF-8 bytes)');
  if(!Number.isInteger(m.executionIndex)||m.executionIndex<1||!Number.isFinite(Date.parse(m.createdAt))||!Number.isFinite(Date.parse(m.expiresAt)))throw new Error('invalid message metadata');
}
export const sameMessage=(a:AgentMessage,b:AgentMessage)=>isDeepStrictEqual(a,b);
export function createTask(input:{messageId:string;from:string;to:string;targetSessionId:string;body:string},clock:Clock):AgentMessage{
  const m:AgentMessage={schemaVersion:1,...input,kind:'task',taskId:input.messageId,executionIndex:1,createdAt:clock.now().toISOString(),expiresAt:new Date(+clock.now()+defaultPolicy.taskTtlMs).toISOString()};
  validateMessage(m);return m;
}
