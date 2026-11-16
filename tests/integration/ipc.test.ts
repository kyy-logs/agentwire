import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startIpc,requestBus,pipeFor } from '../../src/ipc.ts';
import { temp } from '../helpers.ts';
const req=(payload:any)=>({requestId:'test-request',op:'echo',payload});
test('special_text_roundtrips; canonical root; singleton',async t=>{
  const dir=await temp(t);const server=await startIpc(dir,async r=>({requestId:r.requestId,ok:true,data:r.payload}));t.after(()=>server.close());
  const text='中文路径 C:\\临时\\🌊\n"quotes" `echo` $(whoami)';
  assert.equal((await requestBus(dir,req(text))).data,text);
  assert.equal(await pipeFor(dir),await pipeFor(path.join(dir,'.')));
  await assert.rejects(startIpc(path.join(dir,'.'),async()=>({requestId:'x',ok:true})),/EADDRINUSE|already/i);
});
test('wrong_token_is_rejected; fragments and multiple frames parse',async t=>{
  const dir=await temp(t);const server=await startIpc(dir,async r=>({requestId:r.requestId,ok:true,data:r.payload}));t.after(()=>server.close());
  const pipe=await pipeFor(dir),token=(await readFile(path.join(dir,'auth.token'),'utf8')).trim();
  const output=await new Promise<string>((resolve,reject)=>{
    const s=net.createConnection(pipe);let data='';s.setEncoding('utf8');s.on('error',reject);
    s.on('connect',()=>{s.write('{"requestId":"bad","token":"wrong","op":"echo"}\n');const valid=JSON.stringify({...req('valid'),token})+'\n';s.write(valid.slice(0,8));setTimeout(()=>s.write(valid.slice(8)),5);});
    s.on('data',part=>{data+=part;if(data.trim().split('\n').length===2){s.destroy();resolve(data);}});
  });
  const responses=output.trim().split('\n').map(x=>JSON.parse(x));
  assert.ok(responses.some(r=>r.errorCode==='unauthorized'));
  assert.ok(responses.some(r=>r.ok&&r.data==='valid'));
  assert.ok(!output.includes(token));
});
test('oversized_frame_is_rejected_without_dispatch',async t=>{
  const dir=await temp(t);let calls=0;const server=await startIpc(dir,async()=>{calls++;return {requestId:'x',ok:true};});t.after(()=>server.close());
  const response=await new Promise<string>(async(resolve,reject)=>{
    const s=net.createConnection(await pipeFor(dir));s.on('error',reject);s.on('connect',()=>s.write('x'.repeat(1048577)));s.on('data',d=>{s.destroy();resolve(d.toString());});
  });
  assert.match(response,/frame_too_large/);assert.equal(calls,0);
});
