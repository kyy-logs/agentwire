import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertId,realClock} from '../model.ts';
import {FileMessageStore} from '../store.ts';
import {FileLifecycleStore} from './store.ts';
import {normalizeHook} from './normalize.ts';
import type {LifecycleEvent} from './model.ts';
export async function writeHookEvent(root:string,event:LifecycleEvent){return new FileLifecycleStore(root).enqueue(event);}
export async function runHook(args:string[],input:AsyncIterable<Uint8Array>|Iterable<Uint8Array>=process.stdin){
  try{
    if(args.length!==6||args[0]!=='--state'||args[2]!=='--provider'||args[4]!=='--session'||!path.isAbsolute(args[1])||!['codex','claude'].includes(args[3]))throw new Error('invalid_arguments');
    assertId(args[5]);let size=0;const chunks:Buffer[]=[];
    for await(const chunk of input){size+=chunk.length;if(size>1048576)throw new Error('stdin_limit');chunks.push(Buffer.from(chunk));}
    const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(raw?.session_id!==args[5])return 0;
    const event=normalizeHook(args[3] as 'codex'|'claude',raw);
    if(!event){if(['UserPromptSubmit','Stop','StopFailure','Interrupt'].includes(raw.hook_event_name)&&!raw.agent_id&&!raw.is_sidechain)throw new Error('missing_or_unsupported_native_id');return 0;}
    if(event.phase!=='input'){
      await new FileLifecycleStore(args[1]).enqueueCleanHint({schemaVersion:1,provider:event.provider,sessionId:event.sessionId,nativeExecutionId:event.nativeExecutionId,phase:event.phase,observedAt:event.observedAt,backgroundPending:!!event.backgroundPending,continuation:!!event.continuation,incomplete:!!event.incomplete,...(event.errorCode?{errorCode:event.errorCode}:{})});
      // Read only exact local registration; never collect ordinary chat output.
      // Input hook already synced its file before the native model starts, so
      // this also works while the Bus is offline or has not drained the inbox.
      const input=await new FileLifecycleStore(args[1]).findInput(event);
      const record=input?.messageId?await new FileMessageStore(args[1],realClock).get(input.messageId):undefined;
      if(!input||!['task','followup'].includes(input.inputKind||'')||!input.dispatchNonce||record?.returnMode!=='auto'||record.dispatchNonce!==input.dispatchNonce||record.message.targetSessionId!==event.sessionId||record.message.kind!==input.inputKind||record.attempts<1)delete event.output;
    }
    await writeHookEvent(args[1],event);return 0;
  }catch(e){const code=e instanceof Error&&/^[a-z_]+$/.test(e.message)?e.message:'capture_failed';process.stderr.write('lifecycle_hook_error '+code+'\n');return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runHook(process.argv.slice(2));
