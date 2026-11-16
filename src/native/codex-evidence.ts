import type {AppServerClient} from './app-server.ts';
import type {DispatchIntent,Evidence,EvidenceReader,NativeIdentity,SearchAnchor} from './model.ts';
export function createCodexEvidence(client:AppServerClient):EvidenceReader{
 const page=async(sessionId:string,turnId?:string,cursor?:unknown)=>client.call<any>('thread/items/list',{threadId:sessionId,...(turnId?{turnId}:{}),limit:100,sortDirection:turnId?'asc':'desc',deferOutput:{commandExecution:true,mcpToolCall:true},...(cursor?{cursor}:{})});
 return {
 async checkpoint(sessionId:string):Promise<SearchAnchor>{const r:any=await client.call('thread/items/list',{threadId:sessionId,limit:1,sortDirection:'desc',deferOutput:{commandExecution:true,mcpToolCall:true}});if(!Array.isArray(r.data))throw Error('native_schema_changed');if(!r.data.length)return {empty:true};const e=r.data[0];if(typeof e.turnId!=='string'||typeof e.item?.id!=='string')throw Error('native_anchor_unavailable');return {turnId:e.turnId,itemId:e.item.id};},
 async inspect(i:DispatchIntent):Promise<Evidence>{
 if(i.provider!=='codex')return {status:'unavailable',errorCode:'provider_mismatch'};
 try{
 let turn=i.nativeExecutionId;
 if(!turn){let cursor:unknown,complete=false;const matches=new Set<string>();
 for(let n=0;n<20;n++){const r=await page(i.targetSessionId,undefined,cursor);if(!Array.isArray(r.data))return {status:'unavailable',errorCode:'native_schema_changed'};
 for(const e of r.data){const a=i.searchAnchor;if(a&&'turnId'in a&&e.turnId===a.turnId&&e.item?.id===a.itemId){complete=true;break;}if(e.item?.type==='userMessage'&&e.item.clientId===i.transportId)matches.add(e.turnId);}
 if(matches.size>1)return {status:'conflict',errorCode:'multiple_native_executions'};if(complete||!r.nextCursor){complete=true;break;}cursor=r.nextCursor;
 }
 if(!complete)return {status:'limit',errorCode:'native_identity_window_exhausted'};if(!matches.size)return {status:'missing'};turn=[...matches][0];
 }
 const identity:NativeIdentity={provider:'codex',sessionId:i.targetSessionId,nativeExecutionId:turn,transportId:i.transportId,evidenceRef:'codex:'+i.targetSessionId+':'+turn};
 let cursor:unknown,complete=false;const entries:any[]=[];
 for(let n=0;n<20;n++){const r=await page(i.targetSessionId,turn,cursor);if(!Array.isArray(r.data))return {status:'unavailable',errorCode:'native_schema_changed'};entries.push(...r.data.filter((e:any)=>e.turnId===turn));if(!r.nextCursor){complete=true;break;}cursor=r.nextCursor;}
 if(!complete)return {status:'limit',errorCode:'native_turn_window_exhausted'};
 if(!entries.some(e=>e.item?.type==='userMessage'&&e.item.clientId===i.transportId))return {status:'unavailable',errorCode:'native_bound_input_missing'};
 const finals=entries.filter(e=>e.item?.type==='agentMessage'&&e.item.phase==='final_answer'&&typeof e.item.text==='string');
 if(finals.length>1)return {status:'conflict',errorCode:'multiple_final_answers'};
 return {status:'mapped',identity,...(finals.length?{terminal:{ref:{provider:'codex' as const,sessionId:i.targetSessionId,nativeExecutionId:turn},nativeOutcome:'response_ended' as const,body:finals[0].item.text,evidenceRef:identity.evidenceRef,backgroundPending:false,continuation:false,incomplete:false}}:{})};
 }catch{return {status:'unavailable',errorCode:'native_read_failed'};}
 }
 };
}
