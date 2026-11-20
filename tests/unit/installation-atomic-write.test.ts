import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import path from 'node:path';import {temp} from '../helpers.ts';import {atomicBytes} from '../../src/installation/paths.ts';
async function intercept(t:any,handler:(from:string,to:string,rename:typeof fs.rename)=>Promise<void>){const original=fs.rename;t.mock.method(fs,'rename',(from:string,to:string)=>handler(from,to,original));syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});}
test('transient Windows rename denial commits one unchanged payload without replacing the old file early',{skip:process.platform!=='win32'},async t=>{
 const root=await temp(t),target=path.join(root,'state.json');await fs.writeFile(target,'previous');let calls=0,staged:string|undefined;
 await intercept(t,async(from,to,rename)=>{calls++;staged??=from;assert.equal(from,staged);assert.equal(to,target);assert.equal(await fs.readFile(from,'utf8'),'new exact payload');assert.equal(await fs.readFile(target,'utf8'),'previous');if(calls<3)throw Object.assign(Error('temporary sharing denial'),{code:calls===1?'EPERM':'EACCES'});await rename(from,to);});
 await atomicBytes(target,'new exact payload');assert.equal(calls,3);assert.equal(await fs.readFile(target,'utf8'),'new exact payload');assert.deepEqual(await fs.readdir(root),['state.json']);
});
test('permanent rename denial remains bounded and preserves old state while removing only its own temp',async t=>{
 const root=await temp(t),target=path.join(root,'state.json');await fs.writeFile(target,'previous');let calls=0;const failure=Object.assign(Error('denied'),{code:'EPERM'});
 await intercept(t,async()=>{calls++;throw failure;});await assert.rejects(atomicBytes(target,'new'),error=>error===failure);assert.ok(calls>=1&&calls<=4);assert.equal(await fs.readFile(target,'utf8'),'previous');assert.deepEqual(await fs.readdir(root),['state.json']);
});
test('non-sharing rename error is never retried and cannot acknowledge a commit',async t=>{
 const root=await temp(t),target=path.join(root,'state.json');await fs.writeFile(target,'previous');let calls=0;const failure=Object.assign(Error('IO failure'),{code:'EIO'});
 await intercept(t,async()=>{calls++;throw failure;});await assert.rejects(atomicBytes(target,'new'),error=>error===failure);assert.equal(calls,1);assert.equal(await fs.readFile(target,'utf8'),'previous');assert.deepEqual(await fs.readdir(root),['state.json']);
});
