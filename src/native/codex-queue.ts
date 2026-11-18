import type {LocalBus} from '../bus.ts';
import type {AppServerClient} from './app-server.ts';
import {assertId} from '../model.ts';
import {digest} from '../lifecycle/model.ts';

/** Queue admission is not execution. Start only our already accepted head,
 * through the native queue API, preserving its original hidden client identity.
 * An uncertain start is never replayed, even after process restart. */
export class CodexQueuePump{
 private bus:LocalBus;private client:AppServerClient;private guard:()=>Promise<void>;
 constructor(bus:LocalBus,client:AppServerClient,guard:()=>Promise<void>=async()=>{}){this.bus=bus;this.client=client;this.guard=guard;}
 async runtimeIdle(threadId:string){
  try{
   let cursor:string|undefined,found=0,complete=false;const seen=new Set<string>();
   for(let n=0;n<5;n++){
    const page:any=await this.client.call('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});
    if(!Array.isArray(page.data)||page.data.length>100)return false;
    for(const id of page.data){assertId(id);if(seen.has(id))return false;seen.add(id);if(id===threadId)found++;}
    if(!page.nextCursor){complete=true;break;}
    if(typeof page.nextCursor!=='string'||page.nextCursor===cursor)return false;cursor=page.nextCursor;
   }
   if(!complete||found!==1)return false;
   const read:any=await this.client.call('thread/read',{threadId,includeTurns:false});
   return read.thread?.id===threadId&&read.thread?.status?.type==='idle';
  }catch{return false;}
 }
 drain(){return this.bus.serial(async()=>{
  if(this.bus.dispatchStopped||!this.bus.nativeDispatcher)return;
  const records=await this.bus.store.list(),ids=this.bus.nativeDispatcher.store;
  for(const r of records){
   if(this.bus.dispatchStopped)break;
   const m=r.message;
   const deadlinePassed=()=>Date.parse(m.expiresAt)<=+this.bus.clock.now()||r.resultDeadlineAt!==undefined&&!(Date.parse(r.resultDeadlineAt)>+this.bus.clock.now());
   if(m.schemaVersion!==2||r.state!=='submitted'||r.receipt?.status!=='accepted'||!r.activeAttemptId||deadlinePassed())continue;
   const b=this.bus.bindings.get(m.to);if(b?.kind!=='codex'||b.sessionId!==m.targetSessionId)continue;
   if(records.some(x=>x.message.taskId===m.taskId&&(x.stoppedAt||['needs_check','stopped','expired'].includes(x.state))))continue;
   const i=await ids.get(r.activeAttemptId);
   if(!i||i.phase!=='queued'||i.provider!=='codex'||i.connectionId!==this.bus.connectionId||i.messageId!==m.messageId||i.targetSessionId!==m.targetSessionId||i.sourceSessionId!==m.sourceSessionId||i.bodySha256!==digest(m.body))continue;
   if(i.queueStart&&i.queueStart.status!=='not_started'){
    if(['attempted','unknown'].includes(i.queueStart.status)){r.state='needs_check';r.lastError='native_queue_start_unconfirmed';await this.bus.update(r);}continue;
   }
   let head:any;
   try{
    if(!await this.runtimeIdle(b.sessionId))continue;
    const turns:any=await this.client.call('thread/turns/list',{threadId:b.sessionId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
    if(!Array.isArray(turns.data)||turns.data.length>1||turns.data.length&&!['completed','failed','interrupted'].includes(turns.data[0]?.status))continue;
    const queue:any=await this.client.call('thread/queue/list',{threadId:b.sessionId,limit:100});
    if(!Array.isArray(queue.data)||queue.nextCursor||queue.data.length>100)continue;
    const matches=queue.data.filter((q:any)=>q.clientUserMessageId===i.transportId);
    if(matches.length!==1||queue.data[0]!==matches[0])continue;head=matches[0];assertId(head.id);
   }catch{continue;} // Unreadable/missing queue is never proof of non-delivery.
   await this.guard();if(this.bus.dispatchStopped||deadlinePassed())continue;
   const start={submissionId:head.id,status:'attempted' as const,attemptedAt:this.bus.now()};
   await ids.advance(i.attemptId,'queued',{queueStart:start});
   await this.guard();
   let ready=await this.runtimeIdle(b.sessionId);
   if(ready)try{const q:any=await this.client.call('thread/queue/list',{threadId:b.sessionId,limit:100});ready=Array.isArray(q.data)&&!q.nextCursor&&q.data.length<=100&&q.data[0]?.id===head.id&&q.data[0]?.clientUserMessageId===i.transportId&&q.data.filter((x:any)=>x.clientUserMessageId===i.transportId).length===1;}catch{ready=false;}
   await this.guard();
   if(this.bus.dispatchStopped||deadlinePassed()||!ready){await ids.advance(i.attemptId,'queued',{queueStart:{...start,status:'not_started'}});continue;}
   let started=false;
   try{const response:any=await this.client.call('thread/queue/start',{threadId:b.sessionId,queuedSubmissionId:head.id});assertId(response.turn?.id);started=true;}catch{/* The write may already have succeeded. Never restart it. */}
   await ids.advance(i.attemptId,'queued',{queueStart:{...start,status:started?'started':'unknown'}});
   if(!started){r.state='needs_check';r.lastError='native_queue_start_unconfirmed';await this.bus.update(r);}
  }
 });}
}
