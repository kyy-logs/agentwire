import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runCli } from '../../src/cli.ts';
test('send return-mode auto is explicit; manual is default; followup cannot override',async()=>{
 let request:any;const io={stdout:{write:()=>{}},stderr:{write:()=>{}},request:async(_root:string,r:any)=>{request=r;return {requestId:r.requestId,ok:true};}};
 const base=['send','--from','codex','--to','claude','--text','task'];assert.equal(await runCli([...base,'--return-mode','auto'],io),0);assert.equal(request.payload.returnMode,'auto');
 assert.equal(await runCli(base,io),0);assert.equal(request.payload.returnMode,undefined);
 assert.equal(await runCli([...base,'--return-mode','bad'],io),2);assert.equal(await runCli(['followup','--from','codex','--reply-to',randomUUID(),'--text','next','--return-mode','auto'],io),2);
});
test('lost_ack_reuse_same_id; body stays data; no false delivery claim',async()=>{
  const id=randomUUID(),sent:any[]=[],output:string[]=[];
  const io={stdout:{write:(s:string)=>output.push(s)},stderr:{write:(s:string)=>output.push(s)},request:async(root:string,r:any)=>{sent.push(r);throw new Error('connection lost');}};
  const args=['--state','C:/temporary-state','send','--from','codex','--to','claude','--text','中文\n` $(echo) "','--id',id];
  assert.equal(await runCli(args,io),4);assert.equal(await runCli(args,io),4);
  assert.equal(sent[0].payload.messageId,id);assert.deepEqual(sent[0].payload,sent[1].payload);
  assert.equal(sent[0].payload.body,'中文\n` $(echo) "');assert.ok(output.join('').includes('unconfirmed'));
  assert.ok(!output.join('').includes('delivered'));
});
test('bad command rejected; reply derives target on server',async()=>{
  const messages:string[]=[];let request:any;
  const io={stdout:{write:(s:string)=>messages.push(s)},stderr:{write:(s:string)=>messages.push(s)},request:async(root:string,r:any)=>{request=r;return {requestId:r.requestId,ok:true,data:{state:'pending'}};}};
  assert.equal(await runCli(['bogus'],io),2);
  assert.equal(await runCli(['reply','--from','claude','--reply-to',randomUUID(),'--text','done'],io),0);
  assert.equal(request.payload.kind,'reply');assert.equal(request.payload.to,undefined);
});
test('status forwards bounded page options and preserves response-too-large diagnostics',async()=>{
  const output:string[]=[];let request:any;const io={stdout:{write:(s:string)=>output.push(s)},stderr:{write:(s:string)=>output.push(s)},request:async(_root:string,r:any)=>{request=r;return {requestId:r.requestId,ok:true,data:{items:[],nextCursor:null,total:0}};}};
  const id=randomUUID();assert.equal(await runCli(['status','--limit','7','--after',id],io),0);assert.deepEqual(request.payload,{limit:7,after:id});assert.equal(await runCli(['status','--limit','101'],io),2);
  const broken={...io,request:async()=>{throw Error('response_too_large');}};assert.equal(await runCli(['status'],broken),4);assert.match(output.join(''),/"errorCode":"response_too_large"/);
});
