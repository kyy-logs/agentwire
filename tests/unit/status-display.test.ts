import test from 'node:test';
import assert from 'node:assert/strict';
import {createTask} from '../../src/model.ts';
import type {MessageRecord} from '../../src/model.ts';
import {randomUUID} from 'node:crypto';
import {statusPage} from '../../src/status.ts';
const message=createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:randomUUID(),body:'private task body'},{now:()=>new Date('2026-11-20T00:00:00Z')});
function record(state:MessageRecord['state'],extra:Partial<MessageRecord>={}):MessageRecord{return {message,state,attempts:1,updatedAt:message.createdAt,...extra};}

test('message status distinguishes submitted work from a captured result without claiming business success',()=>{
 const rows=[record('pending'),record('submitted'),record('completed',{resultRef:randomUUID()}),record('needs_check',{lastError:'result_timeout_no_native_cancel'})];
 const before=JSON.stringify(rows),items=rows.flatMap(r=>statusPage([r],{},new Date(message.createdAt)).items);
 assert.match(items[0].display.summary,/排队/);assert.match(items[1].display.summary,/已提交/);assert.doesNotMatch(items[1].display.summary,/已完成/);assert.match(items[2].display.summary,/已记录.*结果.*未验证/);assert.match(items[3].display.nextStep,/不.*重复/);assert.doesNotMatch(items[3].display.summary,/审批/);assert.equal(JSON.stringify(rows),before);assert.ok(!JSON.stringify(items).includes('private task body'));
});

test('delivered reply is only displayed as proven when an accepted evidence receipt exists',()=>{
 const reply={...message,kind:'reply' as const,replyTo:randomUUID()},rows=[record('delivered',{message:reply}),record('delivered',{message:reply,receipt:{status:'accepted',evidenceRef:'fixture:exact'}})];
 const items=statusPage(rows,{},new Date(message.createdAt)).items;assert.equal(items[0].display.status,'needs_check');assert.equal(items[1].display.status,'delivered');assert.match(items[1].display.summary,/回复已送达/);
});

const now=new Date('2026-11-20T00:00:00Z');
const task=(state:MessageRecord['state'],extra:Partial<MessageRecord>={})=>record(state,{message:{...message,messageId:randomUUID(),taskId:randomUUID()},...extra});

test('waiting explains last offline rejection and scheduled retry without claiming current endpoint state',()=>{
 const r=task('pending',{receipt:{status:'rejected',retryable:true,errorCode:'session_offline'},nextAttemptAt:'2026-11-20T00:00:05Z'}),before=JSON.stringify(r);
 const d=statusPage([r],{},now).items[0].display;
 assert.equal(d.waiting?.reason,'target_offline');assert.match(d.summary,/上次投递/);assert.match(d.nextStep,/原.*聊天/);assert.equal(d.waiting?.nextAttemptAt,r.nextAttemptAt);assert.equal(JSON.stringify(r),before);
});

test('retry wait ends when its time arrives and arbitrary diagnostics are never treated as approvals',()=>{
 const r=task('pending',{receipt:{status:'rejected',retryable:true,errorCode:'pipe_error'},nextAttemptAt:'2026-11-20T00:00:05Z'});
 assert.equal(statusPage([r],{},now).items[0].display.waiting?.reason,'retry_backoff');
 assert.equal(statusPage([r],{},new Date('2026-11-20T00:00:06Z')).items[0].display.waiting?.reason,'bus_queue');
 for(const state of ['submitting','submitted','needs_check'] as const){const d=statusPage([task(state,{lastError:'permission_prompt'})],{},now).items[0].display;assert.doesNotMatch(d.summary,/正在审批|等待审批/);assert.notEqual(d.waiting?.reason,'approval');}
});

test('family pause remains visible across pagination and task filtering but unrelated tasks do not block it',()=>{
 const blocker=task('needs_check'),waiting=task('pending');waiting.message.taskId=blocker.message.taskId;
 const d=statusPage([blocker,waiting],{taskId:waiting.message.taskId,after:blocker.message.messageId,limit:1},now).items[0].display;
 assert.equal(d.waiting?.reason,'family_paused');assert.equal(d.waiting?.blockedBy,blocker.message.messageId);
 const other=task('needs_check',{message:{...blocker.message,taskId:randomUUID(),targetSessionId:randomUUID()}});
 assert.equal(statusPage([other,waiting],{taskId:waiting.message.taskId},now).items[0].display.waiting?.reason,'bus_queue');
});

test('target serialization uses full record set even when only another task is requested',()=>{
 const blocker=task('submitted'),waiting=task('pending'),before=JSON.stringify([blocker,waiting]);
 const page=statusPage([blocker,waiting],{taskId:waiting.message.taskId},now);
 assert.equal(page.total,1);assert.equal(page.items.length,1);assert.equal(page.items[0].display.waiting?.reason,'target_task_unresolved');assert.equal(page.items[0].display.waiting?.blockedBy,blocker.message.messageId);
 assert.equal(JSON.stringify([blocker,waiting]),before);
 const reply=task('pending',{message:{...waiting.message,kind:'reply',replyTo:randomUUID()}});
 assert.equal(statusPage([blocker,reply],{},now).items[1].display.waiting?.reason,'bus_queue');
 for(const state of ['completed','delivered','failed','expired','stopped'] as const)assert.equal(statusPage([task(state)],{},now).items[0].display.waiting,undefined);
});

test('deadline passed is not explained as normal retry or queue waiting before next scheduler tick',()=>{
 const r=task('pending',{receipt:{status:'rejected',retryable:true,errorCode:'session_offline'},nextAttemptAt:'2026-11-20T01:00:00Z'});
 const d=statusPage([r],{},new Date('2026-11-20T00:31:00Z')).items[0].display;
 assert.equal(d.waiting?.reason,'deadline_elapsed');assert.match(d.summary,/期限已到/);assert.match(d.nextStep,/不.*重复/);assert.equal(r.state,'pending');
});



test('family pause takes precedence over an already scheduled offline retry',()=>{
 const blocker=task('needs_check'),waiting=task('pending',{receipt:{status:'rejected',retryable:true,errorCode:'session_offline'},nextAttemptAt:'2026-11-20T00:00:05Z'});waiting.message.taskId=blocker.message.taskId;
 const d=statusPage([blocker,waiting],{},now).items[1].display;
 assert.equal(d.waiting?.reason,'family_paused');assert.match(d.nextStep,/核对原任务/);assert.doesNotMatch(d.nextStep,/等待程序.*重试/);
});
