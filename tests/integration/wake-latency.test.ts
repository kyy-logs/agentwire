import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {startMain} from '../../src/main.ts';
import {requestBus,startIpc} from '../../src/ipc.ts';
import {writeHookEvent,runHook} from '../../src/lifecycle/hook.ts';
import {normalizeHook} from '../../src/lifecycle/normalize.ts';
import {FileLifecycleStore} from '../../src/lifecycle/store.ts';
import {temp} from '../helpers.ts';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+1800;while(!await check()){if(Date.now()>end)assert.fail('work was not woken before fallback poll');await pause(10);}}
async function fixture(t:any,submit?:any){let runtime:any;const root=await temp({after:(f:any)=>t.after(async()=>{await runtime?.close();await f();})}),sent:any[]=[];
 const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available' as const,details:[]}),submit:submit||(async(_b:any,m:any)=>{sent.push(m);return {status:'accepted' as const};}),reconcile:async()=>({status:'unknown' as const})}));
 runtime=await startMain(root,{adapters,intervalMs:60000,signals:false,quiet:true});
 for(const agentId of ['codex','claude'])await runtime.bus.bind({agentId,kind:agentId,sessionId:randomUUID(),workspaceRoot:root});
 return {root,runtime,sent,call:(op:string,payload?:any)=>requestBus(root,{requestId:randomUUID(),op,payload})};
}
test('durable IPC admission dispatches before the fallback poll without duplicate delivery',async t=>{
 const f=await fixture(t),id=randomUUID();const input={messageId:id,kind:'task',from:'codex',to:'claude',body:'PRIVATE_BODY'};
 assert.equal((await f.call('accept',input)).ok,true);await until(()=>f.sent.length===1);
 for(let i=0;i<4;i++)assert.equal((await f.call('wake')).ok,true);
 await f.call('accept',input);await pause(80);assert.equal(f.sent.length,1);
});
test('wake during a running drain is retained and never starts concurrent adapter calls',async t=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let active=0,max=0;const sent:string[]=[];
 const f=await fixture(t,async(_b:any,m:any)=>{active++;max=Math.max(max,active);sent.push(m.messageId);if(sent.length===1){entered();await gate;}active--;return {status:'accepted'};});
 try{
  const first=randomUUID();await f.call('accept',{messageId:first,kind:'task',from:'codex',to:'claude',body:'first'});
  await Promise.race([started,pause(1800).then(()=>assert.fail('first admission was not woken'))]);
  // Commit directly while a drain holds bus.serial, as an offline durable writer would.
  const second={schemaVersion:1 as const,messageId:randomUUID(),taskId:randomUUID(),kind:'task' as const,from:'claude',to:'codex',targetSessionId:f.runtime.bus.binding('codex').sessionId,body:'second',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),executionIndex:1};second.taskId=second.messageId;
  await f.runtime.bus.store.putNew(second);
  for(let i=0;i<5;i++)assert.equal((await f.call('wake')).ok,true);
  release();await until(()=>sent.length===2);assert.equal(max,1);await pause(50);assert.equal(sent.length,2);
 }finally{release();}
});
test('Hook wake occurs after durable inbox commit; unavailable wake preserves success',async t=>{
 const root=await temp(t),session=randomUUID(),store=new FileLifecycleStore(root);let wakes=0;
 const server=await startIpc(root,async r=>{assert.equal(r.op,'wake');assert.equal(Object.keys(r).sort().join(','),'op,requestId');assert.equal((await store.readInbox()).length,1);wakes++;return {requestId:r.requestId,ok:true};});
 const args=['--state',root,'--provider','claude','--session',session];const bytes=Buffer.from(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:session,prompt_id:randomUUID(),prompt:'private ordinary chat'}));
 try{assert.equal(await runHook(args,[bytes]),0);assert.equal(wakes,1);}finally{await server.close();}
 assert.equal(await runHook(args,[bytes]),0);assert.equal((await store.readInbox()).length,2);
});
test('periodic fallback drains a committed event when no wake arrives',async t=>{
 const f=await fixture(t);await f.runtime.close();
 const runtime=await startMain(f.root,{adapters:[],intervalMs:40,signals:false,quiet:true});
 try{const id=randomUUID();await writeHookEvent(f.root,normalizeHook('claude',{hook_event_name:'UserPromptSubmit',session_id:id,prompt_id:randomUUID(),prompt:'ordinary'})!);await until(async()=>!(await new FileLifecycleStore(f.root).readInbox()).length);}finally{await runtime.close();}
});


test('unresponsive wake ACK is bounded and cannot invalidate a persisted Hook event',async t=>{
 const root=await temp(t),session=randomUUID();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const server=await startIpc(root,async r=>{await gate;return {requestId:r.requestId,ok:true};});
 try{const started=performance.now();assert.equal(await runHook(['--state',root,'--provider','claude','--session',session],[Buffer.from(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:session,prompt_id:randomUUID(),prompt:'private'}))]),0);assert.ok(performance.now()-started<1200);assert.equal((await new FileLifecycleStore(root).readInbox()).length,1);}finally{release();await server.close();}
});
test('stage timing is persisted without prompts or credentials and includes settled delivery',async t=>{
 const f=await fixture(t);const admitted=await f.call('accept',{messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'PRIVATE_BODY_NOT_TELEMETRY'});await until(()=>f.sent.length===1);
 const reply=await f.call('accept',{messageId:randomUUID(),kind:'reply',from:'claude',replyTo:admitted.data.message.messageId,body:'PRIVATE_RESULT_NOT_TELEMETRY'});await until(()=>f.sent.length===2);
 const file=path.join(f.root,'latency.jsonl');let rows:any[]=[];await until(async()=>{try{rows=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);return rows.some(r=>r.stage==='submission_settled'&&r.messageId===reply.data.message.messageId);}catch{return false;}});
 const text=await readFile(file,'utf8');assert.ok(!text.includes('PRIVATE_'));assert.ok(!text.includes((await readFile(path.join(f.root,'auth.token'),'utf8')).trim()));
 assert.ok(rows.some(r=>r.stage==='admission_committed'&&r.messageId===admitted.data.message.messageId&&r.durationsMs.admissionMs>=0));
 assert.ok(rows.some(r=>r.stage==='submission_settled'&&r.messageId===admitted.data.message.messageId&&r.durationsMs.submissionMs>=0&&r.durationsMs.queueAgeMs>=0));
 f.runtime.bus.adapters.get('codex').reconcile=async()=>({status:'submitted',evidenceRef:'fixture-native-evidence'});await f.call('wake');await until(async()=>{return (await readFile(file,'utf8')).includes('delivery_confirmed');});
 const delivery=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse).find(r=>r.stage==='delivery_confirmed');assert.equal(delivery.messageId,reply.data.message.messageId);assert.ok(delivery.durationsMs.deliveryAgeMs>=0);
});


test('unwritable diagnostic file does not prevent committed message delivery',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.root,'latency.jsonl'));
 assert.equal((await f.call('accept',{messageId:randomUUID(),kind:'task',from:'codex',to:'claude',body:'hello'})).ok,true);await until(()=>f.sent.length===1);assert.equal((await f.call('health')).data.status,'running');
});
test('automatic capture records its committed-result stage without capturing telemetry body',async t=>{
 const {lifecycleFixture}=await import('../lifecycle-helpers.ts'),{recordTiming}=await import('../../src/latency.ts');const f=await lifecycleFixture(t);f.bus.onTiming=e=>recordTiming(f.root,e);
 await f.processor.process(f.begin);await f.processor.process(f.terminal());
 const rows=(await readFile(path.join(f.root,'latency.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.stage==='automatic_result_committed'&&r.messageId===f.task.message.messageId).length,1);assert.ok(!JSON.stringify(rows).includes('computed 667'));
});
