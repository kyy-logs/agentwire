import {assertId} from './model.ts';
import type {MessageRecord} from './model.ts';
// Status is an operational summary. Full body remains available via check(id).
// Bounded text fields prevent adapter diagnostics from inflating IPC frames.
export function statusPage(records:MessageRecord[],options:{after?:string;limit?:number}={}){
  const limit=options.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('invalid_status_limit');
  let start=0;if(options.after!==undefined){assertId(options.after);const at=records.findIndex(r=>r.message.messageId===options.after);if(at<0)throw new Error('invalid_status_cursor');start=at+1;}
  const selected=records.slice(start,start+limit);
  const trim=(s:unknown,n:number)=>typeof s==='string'?s.slice(0,n):undefined;
  const items=selected.map(r=>{
    const {body,...message}=r.message;const {receipt,lastError,completion,...rest}=r;
    return {...rest,message,lastError:trim(lastError,256),completion:completion?{nativeOutcome:trim(completion.nativeOutcome,32),businessVerdict:trim(completion.businessVerdict,32),eventKey:trim(completion.eventKey,64),artifactRef:trim(completion.artifactRef,256),sha256:trim(completion.sha256,64),truncated:!!completion.truncated}:undefined,receipt:receipt?{status:receipt.status,nativeId:trim(receipt.nativeId,128),evidenceRef:trim(receipt.evidenceRef,512),errorCode:trim(receipt.errorCode,128),retryable:receipt.retryable}:undefined};
  });
  return {items,nextCursor:start+selected.length<records.length?selected.at(-1)!.message.messageId:null,total:records.length};
}
