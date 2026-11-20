import {findAgent} from '../agents/registry.ts';
import {assertId,assertAgent} from '../model.ts';
import {eventKey,clipUtf8,outputLimit} from './model.ts';
import type {LifecycleEvent,ExecutionRef} from './model.ts';
// Parse only the OUTERMOST first line; peer body cannot register another task.
export function parsePacket(prompt:unknown){
  if(typeof prompt!=='string')return undefined;
  const line=prompt.split(/\r?\n/,1)[0];
  const match=/^LOCAL_AGENT_BUS messageId=(\S+) taskId=(\S+) kind=(task|followup|reply|reminder) from=(\S+) to=(\S+)(?: returnMode=auto dispatchNonce=(\S+))?(?: reminderFor=(\S+))?$/.exec(line);
  if(!match)return undefined;
  try{assertId(match[1]);assertId(match[2]);assertAgent(match[4]);assertAgent(match[5]);if(match[6])assertId(match[6]);if(match[7])assertId(match[7]);}catch{return undefined;}
  return {messageId:match[1],taskId:match[2],kind:match[3] as LifecycleEvent['inputKind'],from:match[4],to:match[5],dispatchNonce:match[6]};
}
export function normalizeHook(provider:ExecutionRef['provider'],raw:any):LifecycleEvent|undefined{
  const agent=findAgent(provider);
  if(!agent||!raw||typeof raw!=='object'||raw.agent_id||raw.is_sidechain===true)return;
  if(!agent.acceptsLifecycleAgentType(raw.agent_type))return;
  const phases:Record<string,LifecycleEvent['phase']>={UserPromptSubmit:'input',Stop:'stop',StopFailure:'failure',Interrupt:'interrupt'};
  const phase=phases[raw.hook_event_name];if(!phase)return;
  const ref={provider,sessionId:raw.session_id,nativeExecutionId:raw[agent.executionIdField]};
  try{assertId(ref.sessionId);assertId(ref.nativeExecutionId);}catch{return;}
  const e:LifecycleEvent={schemaVersion:1,...ref,phase,eventKey:eventKey(ref,phase),observedAt:new Date().toISOString()};
  if(phase==='input'){
    const packet=parsePacket(raw.prompt);e.inputKind=packet?.kind||'ordinary';
    if(packet){e.messageId=packet.messageId;if(packet.dispatchNonce)e.dispatchNonce=packet.dispatchNonce;}
  }else{
    if(typeof raw.last_assistant_message==='string'){e.output=clipUtf8(raw.last_assistant_message,outputLimit);if(Buffer.byteLength(raw.last_assistant_message)>outputLimit)e.incomplete=true;}
    if(raw.stop_hook_active===true)e.continuation=true;
    if(['background_tasks','session_crons'].some(k=>Array.isArray(raw[k])?raw[k].length>0:!!raw[k]))e.backgroundPending=true;
    if(phase!=='stop')e.errorCode=phase==='failure'?'native_failure':'native_interrupt';
  }
  return e;
}
