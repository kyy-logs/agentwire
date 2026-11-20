import {createHash} from 'node:crypto';
import {assertId} from '../model.ts';
import type {Provider} from '../native/model.ts';
import type {ExecutionRef,CapturedResult} from '../lifecycle/model.ts';
import type {MessageInput} from '../model.ts';
export type Actor={provider:Provider;sessionId:string};
export type Phase='working'|'question_pending'|'waiting_answer'|'delivery_pending'|'waiting_acceptance'|'completed'|'needs_check'|'expired'|'stopped';
export type ActionKind='question'|'answer'|'deliver'|'accept'|'revise';
export type ActionRequest={operationId:string;taskId:string;actor:Actor;kind:ActionKind;expectedRevision:number;questionId?:string;deliveryId?:string;body?:string};
export type ActionEvidence={status:'verified';ref:ExecutionRef;evidenceRef:string;requestSha256:string;human?:boolean}|{status:'pending'|'unavailable'|'conflict'|'limit';errorCode?:string};
export interface ActionEvidenceReader{proveAction(request:ActionRequest):Promise<ActionEvidence>}
export type TaskRecord={schemaVersion:1;taskId:string;connectionId:string;initiator:Actor;executor:Actor;phase:Phase;revision:number;deadline:string;executions:number;questions:number;currentMessageId:string;questionId?:string;deliveryId?:string;businessVerdict:'unverified';initialMessage:MessageInput;initialDispatch:'prepared'|'committed';lastError?:string;delivery?:CapturedResult};
export type Checkpoint={expectedRevision:number;nextTask:TaskRecord;phase:'prepared'|'committed'};
export type ActionRecord={schemaVersion:1;request:ActionRequest;requestSha256:string;phase:'pending_verification'|'verified'|'waiting_stop'|'prepared'|'committed'|'needs_check';evidence?:ActionEvidence;outbox?:MessageInput;terminalEventKey?:string;result?:CapturedResult;checkpoints?:{intent?:Checkpoint;terminal?:Checkpoint};errorCode?:string};
export const sameActor=(a:Actor,b:Actor)=>a.provider===b.provider&&a.sessionId===b.sessionId;
export function validateActor(a:Actor){if(!a||!['codex','claude'].includes(a.provider))throw Error('invalid_collaboration_actor');assertId(a.sessionId);}
export function validateAction(r:ActionRequest){if(!r||Object.keys(r).some(k=>!['operationId','taskId','actor','kind','expectedRevision','questionId','deliveryId','body'].includes(k)))throw Error('invalid_collaboration_action');assertId(r.operationId);assertId(r.taskId);validateActor(r.actor);
if(!['question','answer','deliver','accept','revise'].includes(r.kind)||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0)throw Error('invalid_collaboration_action');
if(r.actor&&Object.keys(r.actor).some(k=>!['provider','sessionId'].includes(k)))throw Error('invalid_collaboration_actor');
if(['question','answer','revise'].includes(r.kind)){if(typeof r.body!=='string'||!r.body.trim()||Buffer.byteLength(r.body)>65536)throw Error('invalid_collaboration_body');}else if(r.body!==undefined)throw Error('invalid_collaboration_body');
if(r.kind==='answer'){assertId(r.questionId!);}else if(r.questionId!==undefined)throw Error('invalid_collaboration_question');
if(['accept','revise'].includes(r.kind)){assertId(r.deliveryId!);}else if(r.deliveryId!==undefined)throw Error('invalid_collaboration_delivery');}
export function actionDigest(r:ActionRequest){validateAction(r);return createHash('sha256').update(JSON.stringify([r.operationId,r.taskId,r.actor.provider,r.actor.sessionId,r.kind,r.expectedRevision,r.questionId??null,r.deliveryId??null,r.body??null])).digest('hex');}
export function derivedId(s:string){const h=createHash('sha256').update('agentwire:collaboration:'+s).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
