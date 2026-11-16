import {createHash} from 'node:crypto';
import {assertId} from '../model.ts';
export type ExecutionRef={provider:'codex'|'claude';sessionId:string;nativeExecutionId:string};
export type LifecycleEvent=ExecutionRef&{schemaVersion:1;eventKey:string;phase:'input'|'stop'|'failure'|'interrupt';observedAt:string;messageId?:string;dispatchNonce?:string;inputKind?:'task'|'followup'|'reply'|'reminder'|'ordinary';output?:string;errorCode?:string;backgroundPending?:boolean;continuation?:boolean;incomplete?:boolean};
export type ExecutionRecord=ExecutionRef&{messageId:string;dispatchNonce:string;phase:'bound'|'waiting'|'result_saved'|'applied'|'needs_check';terminalEventKey?:string;replyMessageId?:string;reason?:string};
export type CapturedResult={messageId:string;ref:ExecutionRef;terminalEventKey:string;nativeOutcome:'response_ended'|'error'|'interrupted';businessVerdict:'unverified';body:string;artifactRef?:string;sha256?:string;truncated:boolean};
export type EventApplyResult={status:'applied'|'deferred'|'ignored'|'needs_check';reason?:string};
export const outputLimit=512*1024;
export const resultHeading=(outcome:CapturedResult['nativeOutcome'])=>`[自动采集：${outcome}；业务结论未验证]\n`;
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function assertKey(key:string){if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Error('invalid_lifecycle_key');}
export function validateRef(ref:ExecutionRef){if(!ref||!['codex','claude'].includes(ref.provider))throw new Error('invalid_lifecycle_provider');assertId(ref.sessionId);assertId(ref.nativeExecutionId);}
export function executionKey(ref:ExecutionRef){validateRef(ref);return digest(JSON.stringify([ref.provider,ref.sessionId,ref.nativeExecutionId]));}
export function eventKey(ref:ExecutionRef,phase:LifecycleEvent['phase']){return digest(executionKey(ref)+':'+phase);}
export function clipUtf8(text:string,max:number){const bytes=Buffer.from(text);let end=Math.min(bytes.length,max);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;return bytes.subarray(0,end).toString('utf8');}
export function validateEvent(e:LifecycleEvent){
  validateRef(e);assertKey(e.eventKey);
  if(e.schemaVersion!==1||!['input','stop','failure','interrupt'].includes(e.phase)||e.eventKey!==eventKey(e,e.phase)||!Number.isFinite(Date.parse(e.observedAt)))throw new Error('invalid_lifecycle_event');
  const allowed=['provider','sessionId','nativeExecutionId','schemaVersion','eventKey','phase','observedAt','messageId','dispatchNonce','inputKind','output','errorCode','backgroundPending','continuation','incomplete'];
  if(Object.keys(e).some(k=>!allowed.includes(k)))throw new Error('invalid_lifecycle_fields');
  if(e.messageId)assertId(e.messageId);if(e.dispatchNonce)assertId(e.dispatchNonce);
  if(e.inputKind!==undefined&&!['task','followup','reply','reminder','ordinary'].includes(e.inputKind))throw new Error('invalid_input_kind');
  if(e.output!==undefined&&(typeof e.output!=='string'||Buffer.byteLength(e.output)>outputLimit))throw new Error('invalid_lifecycle_output');
  if(e.errorCode!==undefined&&(typeof e.errorCode!=='string'||!/^[a-z_]{1,80}$/.test(e.errorCode)))throw new Error('invalid_lifecycle_error');
  for(const k of ['backgroundPending','continuation','incomplete'] as const)if(e[k]!==undefined&&typeof e[k]!=='boolean')throw new Error('invalid_lifecycle_flag');
}
export function semanticEvent(e:LifecycleEvent){const {observedAt,...payload}=e;return payload;}
export function validateExecution(e:ExecutionRecord){validateRef(e);assertId(e.messageId);assertId(e.dispatchNonce);if(!['bound','waiting','result_saved','applied','needs_check'].includes(e.phase))throw new Error('invalid_execution_phase');if(e.terminalEventKey)assertKey(e.terminalEventKey);if(e.replyMessageId)assertId(e.replyMessageId);}
export function validateResult(r:CapturedResult){validateRef(r.ref);assertId(r.messageId);assertKey(r.terminalEventKey);if(!['response_ended','error','interrupted'].includes(r.nativeOutcome)||r.businessVerdict!=='unverified'||typeof r.body!=='string'||Buffer.byteLength(r.body)>outputLimit||typeof r.truncated!=='boolean')throw new Error('invalid_captured_result');}
