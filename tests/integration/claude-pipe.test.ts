import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {postClaude} from '../../src/adapters/claude.ts';
test('auth_is_first_frame; unicode_pipe_payload_roundtrip; transport write is unknown',async t=>{
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\claude-test-${randomUUID()}`:path.join(os.tmpdir(),randomUUID()+'.sock');
  let finish:(x:any)=>void;const received=new Promise<any>(r=>finish=r);
  const server=net.createServer(s=>{let data='';s.setEncoding('utf8');s.on('data',d=>data+=d);s.on('end',()=>finish(data.trim().split('\n').map(x=>JSON.parse(x))));});
  await new Promise<void>(r=>server.listen(pipe,r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const text='中文 🌊\n" ` $(echo)';const result=await postClaude({pid:1,sessionId:randomUUID(),socketPath:pipe,token:'secret'},text);
  const frames=await received;assert.deepEqual(frames[0],{type:'auth',token:'secret'});assert.equal(frames[1].message.content,text);assert.equal(result.status,'unknown');assert.ok(!JSON.stringify(result).includes('secret'));
});
test('hold_is_not_success; no native ack means unknown',async t=>{
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\claude-hold-${randomUUID()}`:path.join(os.tmpdir(),randomUUID()+'.sock');
  const server=net.createServer(s=>{s.on('error',()=>{});s.on('data',()=>s.write('{"type":"hold"}\n'));s.on('end',()=>s.end());});
  await new Promise<void>(r=>server.listen(pipe,r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const result=await postClaude({pid:1,sessionId:randomUUID(),socketPath:pipe,token:'secret'},'test');assert.equal(result.status,'unknown');
});
