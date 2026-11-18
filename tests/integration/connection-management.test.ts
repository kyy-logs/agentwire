import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {FileMessageStore} from '../../src/store.ts';
import {createTask,realClock} from '../../src/model.ts';
import type {Candidate,PairedConnectionRecord} from '../../src/installation/model.ts';

const api:any=await import('../../src/installation/connection-management.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
export async function savedPairs(t:any){
 const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath};
 const self:Candidate={provider:'codex',sessionId:randomUUID(),title:'Current Codex',workspaceRoot:path.join(root,'code'),availability:'candidate'};
 const candidates:Candidate[]=[self,...[1,2].map(n=>({provider:'claude' as const,sessionId:randomUUID(),title:'Claude '+n,workspaceRoot:path.join(root,'project '+n),availability:'live_endpoint' as const}))];
 const pairs:PairedConnectionRecord[]=candidates.slice(1).map((claude,i)=>({schemaVersion:2,admissionMode:'identity-pair-v1',connectionId:randomUUID(),phase:i?'disconnected':'paired',codex:self,claude,createdAt:new Date().toISOString(),pairing:{activationId:randomUUID(),identity:'confirmed'}}));
 const state=(r:any)=>path.join(c.installRoot,'connections',r.connectionId,'state');
 const save=async(r:any)=>{const dir=path.dirname(state(r));await mkdir(state(r),{recursive:true});await writeFile(path.join(dir,'connection.json'),JSON.stringify(r));await writeFile(path.join(state(r),'bindings.json'),JSON.stringify({schemaVersion:1,bindings:['codex','claude'].map(p=>({agentId:p,kind:p,sessionId:r[p].sessionId,workspaceRoot:r[p].workspaceRoot}))}));};
 for(const r of pairs)await save(r);
 const routes=(r:any)=>({schemaVersion:1,routes:['codex','claude'].map(provider=>({provider,sessionId:r[provider].sessionId,connectionId:r.connectionId}))});
 await writeFile(path.join(c.installRoot,'active-connection.json'),JSON.stringify({connectionId:pairs[0].connectionId}));await writeFile(path.join(c.installRoot,'routes.json'),JSON.stringify(routes(pairs[0])));
 const deps:any={discover:async(_c:any,p:string,id?:string)=>candidates.filter(x=>x.provider===p&&(!id||x.sessionId===id)),now:()=>new Date()};
 const source={provider:'codex' as const,sessionId:self.sessionId};
 return {root,c,self,candidates,pairs,state,save,routes,deps,source};
}

test('saved list is read-only and separates identity, endpoint observation and active selection',async t=>{
 assert.equal(typeof api.listConnections,'function','saved connection inspection is implemented');const f=await savedPairs(t),before=await readdir(f.state(f.pairs[0]));
 const r=await api.listConnections(f.c,f.source,f.deps);assert.equal(r.current.connectionId,f.pairs[0].connectionId);assert.equal(r.connections.length,2);
 const second=r.connections.find((x:any)=>x.connectionId===f.pairs[1].connectionId);assert.equal(second.active,false);assert.equal(second.claude.title,'Claude 2');assert.equal(second.endpoint.claude,'detected');assert.equal(second.endpoint.codex,'unknown');assert.equal(second.work.unfinished,0);
 assert.deepEqual(await readdir(f.state(f.pairs[0])),before);assert.equal(r.connections[0].roundtrip,undefined);
 const other=await api.listConnections(f.c,{provider:'codex',sessionId:randomUUID()},f.deps);assert.equal(other.connections.length,0);assert.equal(other.current.connectionId,f.pairs[0].connectionId);
});

test('saved work identifies pending, uncertain and stopped native work instead of assuming terminal means idle',async t=>{
 assert.equal(typeof api.inspectConnectionWork,'function');const f=await savedPairs(t),store=new FileMessageStore(f.state(f.pairs[0]),realClock);
 const task=await store.putNew(createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:f.candidates[1].sessionId,body:'work'},realClock));
 assert.equal((await api.inspectConnectionWork(f.c,f.pairs[0].connectionId)).unfinished,1);
 await store.replace({...task.record,state:'needs_check',attempts:1,receipt:{status:'unknown'}});assert.equal((await api.inspectConnectionWork(f.c,f.pairs[0].connectionId)).uncertain,1);
 await store.replace({...task.record,state:'stopped',attempts:1,receipt:{status:'accepted'}});const work=await api.inspectConnectionWork(f.c,f.pairs[0].connectionId);assert.equal(work.unfinished,0);assert.equal(work.nativeOutstanding,1);
});

test('corrupt history and saved records are reported and never become an empty safe queue',async t=>{
 assert.equal(typeof api.listConnections,'function');const f=await savedPairs(t);await mkdir(path.join(f.state(f.pairs[1]),'messages'));await writeFile(path.join(f.state(f.pairs[1]),'messages',randomUUID()+'.json'),'{bad');
 const r=await api.listConnections(f.c,f.source,f.deps);assert.equal(r.connections.find((x:any)=>x.connectionId===f.pairs[1].connectionId).errorCode,'connection_storage_requires_check');
 await writeFile(path.join(f.c.installRoot,'connections',f.pairs[1].connectionId,'connection.json'),'{}');const bad=await api.listConnections(f.c,f.source,f.deps);assert.equal(bad.errors.length,1);assert.equal(bad.errors[0].code,'invalid_connection');
});
