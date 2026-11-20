import path from 'node:path';
import {appendFile,stat} from 'node:fs/promises';
import {assertId} from './model.ts';
const stages=['admission_committed','submission_settled','automatic_result_committed','delivery_confirmed','pair_result_committed','pair_notification_settled'] as const;
export type Timing={stage:typeof stages[number];messageId?:string;taskId?:string;requestId?:string;state?:string;durationsMs:Partial<Record<'admissionMs'|'queueAgeMs'|'submissionMs'|'captureMs'|'executionMs'|'notificationMs'|'deliveryAgeMs',number>>};
/** Diagnostic only. Explicit allowlist: never persist bodies, codes, paths or tokens.
 * Stop appending at 4 MiB rather than letting diagnostics grow without bound.
 * Missing/unwritable/full diagnostics never alter a committed business result. */
export async function recordTiming(root:string,event:Timing){
 try{
  if(!stages.includes(event.stage))return;
  const row:any={at:new Date().toISOString(),stage:event.stage};
  for(const key of ['messageId','taskId','requestId'] as const)if(event[key]!==undefined){assertId(event[key]!);row[key]=event[key];}
  if(event.state&&/^[a-z_]{1,40}$/.test(event.state))row.state=event.state;
  row.durationsMs={};
  for(const key of ['admissionMs','queueAgeMs','submissionMs','captureMs','executionMs','notificationMs','deliveryAgeMs'] as const){const n=event.durationsMs[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0)row.durationsMs[key]=Math.round(n*1000)/1000;}
  const file=path.join(root,'latency.jsonl');try{if((await stat(file)).size>=4*1024*1024)return;}catch(e:any){if(e.code!=='ENOENT')return;}
  await appendFile(file,JSON.stringify(row)+'\n',{mode:0o600});
 }catch{}
}
