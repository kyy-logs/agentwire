import path from 'node:path';
import {appendFile,lstat,readFile} from 'node:fs/promises';
import {safePath} from './paths.ts';
const stages=['router_ready','stdin_ready','timing_ready','lifecycle_import_started','lifecycle_import_ready','route_ready','normalized','capture_persisted','wake_started','wake_finished','router_finished'] as const;
type Stage=typeof stages[number];
export type HookTrace={mark(stage:Stage):void;finish():Promise<void>};
const id=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const round=(n:number)=>Math.round(n*1000)/1000;
/** Opt-in diagnostics only. No authority, payload capture, or control-flow effects. */
export async function openHookTiming(root:string,provider:string,raw:any,boot:{ready:number;stdin:number;uptimeMs:number}):Promise<HookTrace|undefined>{
 try{
  const file=path.join(root,'hook-timing.json');const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096)return;
  await safePath(root,file);const config=JSON.parse(await readFile(file,'utf8')),now=Date.now(),expires=Date.parse(config.expiresAt);
  const executionId=provider==='codex'?raw.turn_id:raw.prompt_id;
  if(config.schemaVersion!==1||!['codex','claude'].includes(provider)||config.provider!==provider||config.sessionId!==raw.session_id||!id(raw.session_id)||!id(executionId)||!Number.isFinite(expires)||expires<=now||expires-now>86400000||!['UserPromptSubmit','Stop','StopFailure','Interrupt'].includes(raw.hook_event_name))return;
  const values:Partial<Record<Stage,number>>={router_ready:0,stdin_ready:round(Math.max(0,boot.stdin-boot.ready))};
  const mark=(stage:Stage)=>{if(stages.includes(stage)&&values[stage]===undefined)values[stage]=round(Math.max(0,performance.now()-boot.ready));};
  mark('timing_ready');let finished=false;
  return {mark,async finish(){
   if(finished)return;finished=true;mark('router_finished');
   try{
    if(Date.now()>=expires)return;const output=await safePath(root,path.join(root,'hook-timing.jsonl'));
    try{const s=await lstat(output);if(!s.isFile()||s.isSymbolicLink()||s.size>=1024*1024)return;}catch(e:any){if(e.code!=='ENOENT')return;}
    const row={schemaVersion:1,at:new Date().toISOString(),provider,sessionId:raw.session_id,nativeExecutionId:executionId,event:raw.hook_event_name,nodeUptimeAtRouterReadyMs:round(boot.uptimeMs),stagesMs:values};
    await appendFile(output,JSON.stringify(row)+'\n',{mode:0o600});
   }catch{} // Timing failures cannot change a captured lifecycle result.
  }};
 }catch{return;}
}