import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID} from 'node:crypto';import {temp} from '../helpers.ts';import {runLabus} from '../../src/labus.ts';
import {selectConnection,disconnect} from '../../src/installation/connections.ts';
import {readFile} from 'node:fs/promises';
test('unknown command rejected; json connect never waits readline; missing source reported',async t=>{const root=await temp(t),context={home:root,installRoot:path.join(root,'i'),sourceRoot:root,nodeExe:process.execPath};let out='';const io={stdout:{write:(s:string)=>{out+=s;}},stderr:{write:()=>{}}};assert.equal(await runLabus(['wat'],io,{context,env:{}}),2);assert.equal(JSON.parse(out).errorCode,'invalid_command');out='';assert.equal(await runLabus(['connect','discover','--provider','codex'],io,{context,env:{}}),3);assert.equal(JSON.parse(out).errorCode,'source_session_missing');out='';assert.equal(await runLabus(['connect','discover','--provider','codex'],io,{context,env:{CODEX_THREAD_ID:randomUUID()}}),0);assert.equal(JSON.parse(out).data.candidates.length,0);});
test('status offline and doctor read only provide next action',async t=>{const root=await temp(t),context={home:root,installRoot:path.join(root,'i'),sourceRoot:root,nodeExe:process.execPath};let out='';const io={stdout:{write:(s:string)=>{out+=s;}},stderr:{write:()=>{}}};await runLabus(['status'],io,{context,env:{}});assert.equal(JSON.parse(out).phase,'disconnected');assert.ok(JSON.parse(out).nextAction.includes('connect'));});

test('archived connection stays disconnected in status and doctor when its service is offline',async t=>{
 const root=await temp(t),context={home:root,installRoot:path.join(root,'i'),sourceRoot:root,nodeExe:process.execPath},self={provider:'codex' as const,sessionId:randomUUID(),workspaceRoot:root,availability:'candidate' as const},peer={provider:'claude' as const,sessionId:randomUUID(),workspaceRoot:root,availability:'candidate' as const};
 const selected=await selectConnection(context,self,peer,{self});await disconnect(context,selected.connectionId);const file=path.join(context.installRoot,'connections',selected.connectionId,'connection.json'),before=await readFile(file);
 for(const op of ['status','doctor']){let out='';const exit=await runLabus([op],{stdout:{write(s:string){out+=s;}},stderr:{write(){}}},{context,env:{}});assert.equal(exit,0);const r=JSON.parse(out);assert.equal(r.phase,'disconnected');assert.equal(r.data.connection.phase,'disconnected');assert.ok(r.nextAction.includes('connect'));assert.deepEqual(await readFile(file),before);}
});


test('include-archived is a read-only list option and cannot affect other operations',async t=>{
 const root=await temp(t),context={home:root,installRoot:path.join(root,'i'),sourceRoot:root,nodeExe:process.execPath};for(const args of [['ask'],['doctor'],['connect','switch'],['connect','discover']]){let out='';const exit=await runLabus([...args,'--include-archived'],{stdout:{write:s=>out+=s},stderr:{write:()=>{}}},{context,env:{}});assert.equal(exit,2);assert.equal(JSON.parse(out).errorCode,'unexpected_option');}
});
