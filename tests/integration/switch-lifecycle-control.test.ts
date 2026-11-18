import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {startMain} from '../../src/main.ts';
import {routeHook} from '../../src/installation/hook-router.ts';
import {normalizeHook} from '../../src/lifecycle/normalize.ts';
import {eventKey,digest} from '../../src/lifecycle/model.ts';
import {FileLifecycleStore} from '../../src/lifecycle/store.ts';
import {previewConnectionSwitch,applyConnectionSwitch,inspectConnectionWork} from '../../src/installation/connection-management.ts';
import type {Provider,PairedConnectionRecord} from '../../src/installation/model.ts';

async function fixture(t:any,provider:Provider='codex'){
 const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath};
 const peers=(['codex','claude'] as const).map(p=>({provider:p,sessionId:randomUUID(),workspaceRoot:path.join(root,p),availability:p==='claude'?'live_endpoint' as const:'candidate' as const}));
 const records=([0,1] as const).map(n=>({schemaVersion:2,admissionMode:'identity-pair-v1',connectionId:randomUUID(),phase:n?'disconnected':'paired',codex:peers[0],claude:peers[1],createdAt:new Date().toISOString(),pairing:{activationId:randomUUID(),identity:'confirmed'}} as PairedConnectionRecord));
 const state=(id:string)=>path.join(c.installRoot,'connections',id,'state');
 for(const r of records){await mkdir(state(r.connectionId),{recursive:true});await writeFile(path.join(path.dirname(state(r.connectionId)),'connection.json'),JSON.stringify(r));await writeFile(path.join(state(r.connectionId),'bindings.json'),JSON.stringify({schemaVersion:1,bindings:peers.map(p=>({agentId:p.provider,kind:p.provider,sessionId:p.sessionId,workspaceRoot:p.workspaceRoot}))}));}
 await writeFile(path.join(c.installRoot,'active-connection.json'),JSON.stringify({connectionId:records[0].connectionId}));await writeFile(path.join(c.installRoot,'routes.json'),JSON.stringify({schemaVersion:1,routes:peers.map(p=>({provider:p.provider,sessionId:p.sessionId,connectionId:records[0].connectionId}))}));
 const ref={provider,sessionId:records[0][provider].sessionId,nativeExecutionId:randomUUID()},raw={session_id:ref.sessionId,turn_id:ref.nativeExecutionId,prompt_id:ref.nativeExecutionId,prompt:'恢复原配对',hook_event_name:'UserPromptSubmit'};
 await routeHook(c,provider,[Buffer.from(JSON.stringify(raw))]);
 const before=await startMain(state(records[0].connectionId),{adapters:[],quiet:true,intervalMs:0,signals:false});t.after(()=>before.close());
 const source={provider,sessionId:ref.sessionId},deps={discover:async(_c:any,p:string)=>peers.filter(x=>x.provider===p),shutdown:async()=>{await before.close();return {status:'closed' as const};}};
 const preview=await previewConnectionSwitch(c,source,records[1].connectionId,deps);await applyConnectionSwitch(c,source,records[1].connectionId,preview.operationId,deps);
 const after=await startMain(state(records[1].connectionId),{adapters:[],quiet:true,intervalMs:0,signals:false});t.after(()=>after.close());
 const stop=normalizeHook(provider,{...raw,hook_event_name:'Stop'})!,sourceLife=new FileLifecycleStore(state(records[0].connectionId));
 return {c,records,state,ref,raw,preview,stop,after,sourceLife,plan:path.join(c.installRoot,'install','connection-switches',preview.operationId+'.json')};
}

test('switch mid-turn retains the original input and handles its Stop in the restored route, in either direction',async t=>{
 for(const provider of ['codex','claude'] as const){const f=await fixture(t,provider),key=eventKey(f.ref,'input'),bytes=await readFile(f.sourceLife.file('events',key));
  await routeHook(f.c,provider,[Buffer.from(JSON.stringify({...f.raw,hook_event_name:'Stop'}))]);await f.after.lifecycle.drain();
  assert.equal(await f.after.lifecycle.store.isApplied(f.stop.eventKey),true,provider);
  assert.equal((await inspectConnectionWork(f.c,f.records[1].connectionId)).artifactsPending,0);
  assert.equal(await f.after.lifecycle.store.getEvent(key),undefined,'no synthetic input');assert.equal(await f.after.lifecycle.store.getExecution(f.ref),undefined,'no auto task binding');assert.deepEqual(await readFile(f.sourceLife.file('events',key)),bytes,'source history immutable');
 }
});

test('switch proof rejects preview, changed identities, wrong input, conflicts, bindings and future input',async t=>{
 for(const mode of ['preview','activation','source','input_missing','input_foreign','task','binding','conflict','unapplied','future','native','native_unmapped','native_unknown','native_prepared','ambiguous','corrupt']){
  const f=await fixture(t),input=await f.sourceLife.getEvent(eventKey(f.ref,'input'));assert.ok(input);
  const plan=JSON.parse(await readFile(f.plan,'utf8'));
  if(mode==='preview'){plan.status='preview';await writeFile(f.plan,JSON.stringify(plan));}
  if(mode==='activation'){plan.to.pairing.activationId=randomUUID();await writeFile(f.plan,JSON.stringify(plan));}
  if(mode==='source'){plan.source.sessionId=randomUUID();await writeFile(f.plan,JSON.stringify(plan));}
  if(mode==='input_missing')await unlink(f.sourceLife.file('events',input.eventKey));
  if(mode==='input_foreign')input.sessionId=randomUUID();
  if(mode==='task'){input.inputKind='task';input.messageId=randomUUID();input.dispatchNonce=randomUUID();}
  if(mode==='future')input.observedAt=new Date(Date.parse(f.preview.expiresAt)+1000).toISOString();
  if(['input_foreign','task','future'].includes(mode))await writeFile(f.sourceLife.file('events',input.eventKey),JSON.stringify(input));
  if(mode==='binding')await f.sourceLife.bindExecution({...f.ref,messageId:randomUUID(),dispatchNonce:randomUUID(),phase:'bound'});
  if(mode==='conflict')await f.sourceLife.markConflict(f.ref,'fixture_conflict');
  if(mode==='unapplied')await unlink(f.sourceLife.file('applied',input.eventKey));
  if(mode.startsWith('native')){const dir=path.join(f.state(f.records[0].connectionId),'native','attempts');await mkdir(dir,{recursive:true});const attemptId=randomUUID();await writeFile(path.join(dir,attemptId+'.json'),JSON.stringify({schemaVersion:1,connectionId:f.records[0].connectionId,provider:f.ref.provider,targetSessionId:f.ref.sessionId,sourceSessionId:f.records[0].claude.sessionId,messageId:randomUUID(),attemptId,transportId:randomUUID(),wireVersion:'clean-v1',bodySha256:'a'.repeat(64),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),phase:mode==='native'?'mapped':mode==='native_unmapped'?'queued':mode==='native_unknown'?'needs_check':'prepared',...(mode==='native'?{nativeExecutionId:f.ref.nativeExecutionId}:{})}));}
  if(mode==='ambiguous'){const operationId=randomUUID();await writeFile(path.join(path.dirname(f.plan),operationId+'.json'),JSON.stringify({...plan,operationId}));}
  if(mode==='corrupt')await writeFile(f.plan,'{bad');
  assert.equal((await f.after.lifecycle.process(f.stop)).status,'deferred',mode);assert.equal(await f.after.lifecycle.store.isApplied(f.stop.eventKey),false,mode);
 }
});

test('verified switch never swallows failure, interruption, output or flagged Stop',async t=>{
 for(const mode of ['failure','interrupt','output','error','background','continuation','incomplete']){const f=await fixture(t);const event={...f.stop};
  if(mode==='failure'||mode==='interrupt'){event.phase=mode;event.eventKey=eventKey(event,mode);}else if(mode==='output')event.output='must retain';else if(mode==='error')event.errorCode='fixture_error';else event[mode==='background'?'backgroundPending':mode as 'continuation'|'incomplete']=true;
  assert.equal((await f.after.lifecycle.process(event)).status,'deferred',mode);assert.equal(await f.after.lifecycle.store.isApplied(event.eventKey),false);
 }
});

test('only an exact informational reply can exclude an unmapped intent from possible auto work',async t=>{
 for(const mode of ['reply','auto','body','session','attempt','task']){
  const f=await fixture(t),state=f.state(f.records[0].connectionId),attemptId=randomUUID(),messageId=randomUUID(),stamp=new Date().toISOString();
  const message:any={schemaVersion:2,wireVersion:'clean-v1',messageId,taskId:randomUUID(),replyTo:randomUUID(),kind:mode==='task'?'task':'reply',from:'claude',to:'codex',sourceSessionId:f.records[0].claude.sessionId,targetSessionId:f.ref.sessionId,body:'informational only',createdAt:stamp,expiresAt:stamp,executionIndex:1,...(mode==='auto'?{returnMode:'auto'}:{})};
  const record={message,state:'expired',attempts:1,updatedAt:stamp,activeAttemptId:mode==='attempt'?randomUUID():attemptId,...(mode==='auto'?{returnMode:'auto'}:{})};
  const intent={schemaVersion:1,connectionId:f.records[0].connectionId,provider:'codex',targetSessionId:f.ref.sessionId,sourceSessionId:mode==='session'?randomUUID():f.records[0].claude.sessionId,messageId,attemptId,transportId:randomUUID(),wireVersion:'clean-v1',bodySha256:mode==='body'?'b'.repeat(64):digest(message.body),createdAt:stamp,updatedAt:stamp,phase:'queued'};
  for(const [dir,name,data] of [['messages',messageId,record],['native/attempts',attemptId,intent]] as const){await mkdir(path.join(state,dir),{recursive:true});await writeFile(path.join(state,dir,name+'.json'),JSON.stringify(data));}
  const result=await f.after.lifecycle.process(f.stop);assert.equal(result.status,mode==='reply'?'ignored':'deferred',mode);assert.equal(await f.after.lifecycle.store.isApplied(f.stop.eventKey),mode==='reply',mode);
 }
});
