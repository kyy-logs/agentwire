import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {normalizeHook} from '../../src/lifecycle/normalize.ts';
import {LifecycleProcessor} from '../../src/lifecycle/processor.ts';
import {inspectConnectionWork} from '../../src/installation/connection-management.ts';
import {createTask,realClock} from '../../src/model.ts';
const api:any=await import('../../src/installation/non-task-evidence.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

async function fixture(t:any,provider:'codex'|'claude'='codex',interrupted=false){
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps),main=[...f.services.values()][0],peer=r[provider],turn=randomUUID(),stamp=new Date(f.clock.value).toISOString();
 const e=normalizeHook(provider,{session_id:peer.sessionId,turn_id:turn,prompt_id:turn,hook_event_name:interrupted?'Interrupt':'Stop'})!;
 const file=path.join(f.c.home,provider==='codex'?'.codex':'.claude',provider==='codex'?'sessions':'projects',peer.sessionId+'.jsonl');
 const rows:any[]=provider==='codex'?[
  {type:'session_meta',payload:{id:peer.sessionId,source:'vscode',cwd:peer.workspaceRoot}},
  {type:'event_msg',timestamp:stamp,payload:{type:'task_started',turn_id:turn,turn_attribution:{turn_id:turn,turn_trigger:'composer',parent_turn_id:null,initiating_agent_path:null,root_turn_id:turn}}},
  ...(!interrupted?[{type:'response_item',timestamp:stamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:'ordinary chat'}],internal_chat_message_metadata_passthrough:{turn_id:turn,content_item_kinds:['user.text'],content_item_metadata:[{provenance:{type:'user'}}]}}}]:[]),
  {type:'event_msg',timestamp:stamp,payload:{type:interrupted?'turn_aborted':'task_complete',turn_id:turn}}
 ]:[{type:'user',sessionId:peer.sessionId,promptId:turn,uuid:randomUUID(),isSidechain:false,origin:{kind:'human'},cwd:peer.workspaceRoot,timestamp:stamp,message:{content:'ordinary chat'}}];
 const save=async()=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');};await save();
 await main.lifecycle.store.enqueueCleanHint({schemaVersion:1,provider,sessionId:peer.sessionId,nativeExecutionId:turn,phase:e.phase as any,observedAt:e.observedAt,backgroundPending:false,continuation:false,incomplete:false,...(e.errorCode?{errorCode:e.errorCode}:{})});
 const verifier=api.createNonTaskVerifier?.(f.c,r.connectionId),processor=new LifecycleProcessor(main.bus,main.lifecycle.store,undefined,verifier);
 return {...f,r,main,peer,turn,e,file,rows,save,processor};
}

for(const provider of ['codex','claude'] as const)test('verified '+provider+' human orphan Stop preserves evidence and clears only non-task blocker',async t=>{
 const f=await fixture(t,provider),nativeBefore=await readFile(f.file);await f.main.lifecycle.store.putEvent(f.e);const eventBefore=await readFile(f.main.lifecycle.store.file('events',f.e.eventKey));
 assert.deepEqual(await f.processor.process(f.e),{status:'ignored',reason:'verified_native_non_task'});
 const mark=await f.main.lifecycle.store.read(f.main.lifecycle.store.file('applied',f.e.eventKey));assert.equal(mark.reason,'verified_native_non_task');assert.ok(mark.proof.evidenceRef.includes(f.turn));assert.equal(mark.proof.inputCount,1);
 assert.deepEqual(await readFile(f.file),nativeBefore);assert.deepEqual(await readFile(f.main.lifecycle.store.file('events',f.e.eventKey)),eventBefore);assert.equal(await f.main.lifecycle.store.getExecution(f.e),undefined);assert.equal((await inspectConnectionWork(f.c,f.r.connectionId)).artifactsPending,0);assert.equal(f.sent.length,0);
});

test('composer aborted before input persistence is non-task only with exact native abort and complete hint',async t=>{
 const f=await fixture(t,'codex',true);assert.deepEqual(await f.processor.process(f.e),{status:'ignored',reason:'verified_native_non_task'});const mark=await f.main.lifecycle.store.read(f.main.lifecycle.store.file('applied',f.e.eventKey));assert.equal(mark.proof.inputCount,0);assert.equal(mark.proof.nativeOutcome,'interrupted');assert.equal(f.sent.length,0);
});

test('failed historical pairing input is classifiable from native provenance without claiming or replaying code',async t=>{
 const f=await fixture(t);f.rows[2].payload.content[0].text='连接 Claude，连接码 DEMO-ONLY';await f.save();const before=await readFile(f.c.installRoot+'/pairing/state.json');
 assert.equal((await f.processor.process(f.e)).reason,'verified_native_non_task');assert.deepEqual(await readFile(f.c.installRoot+'/pairing/state.json'),before);assert.equal(f.sent.length,0);
});

for(const mode of ['duplicate_file','append_conflicting_end'] as const)test('prefetched proof is invalidated before use after '+mode,async t=>{
 const f=await fixture(t);await f.main.lifecycle.store.putEvent(f.e);const verify=api.createNonTaskVerifier(f.c,f.r.connectionId);assert.ok(await verify(f.e));
 if(mode==='duplicate_file')await writeFile(path.join(path.dirname(f.file),'copy-'+f.peer.sessionId+'.jsonl'),await readFile(f.file));
 else await writeFile(f.file,JSON.stringify(f.rows.at(-1))+'\n',{flag:'a'});
 assert.equal(await verify(f.e),undefined,'same verifier cannot reuse evidence after its snapshot or enumeration changed');const processor=new LifecycleProcessor(f.main.bus,f.main.lifecycle.store,undefined,verify);assert.equal((await processor.process(f.e)).status,'deferred');assert.equal(await f.main.lifecycle.store.isApplied(f.e.eventKey),false);
});

for(const mode of ['peer','client_id','duplicate_input','duplicate_end','missing_end','wrong_session','wrong_cwd','flagged','missing_hint','conflict','output','bound_attempt','unmapped_write','duplicate_file','invalid_json','unfinished_task','legacy_outstanding','duplicate_peer_file'] as const)test('orphan proof refuses '+mode+' and preserves unresolved blocker',async t=>{
 const f=await fixture(t);
 if(mode==='peer')f.rows[1].payload.turn_attribution.turn_trigger='queue';
 if(mode==='client_id')f.rows[2].payload.clientId=randomUUID();
 if(mode==='duplicate_input')f.rows.splice(3,0,structuredClone(f.rows[2]));
 if(mode==='duplicate_end')f.rows.push(structuredClone(f.rows.at(-1)));
 if(mode==='missing_end')f.rows.pop();
 if(mode==='wrong_session')f.rows[0].payload.id=randomUUID();
 if(mode==='wrong_cwd')f.rows[0].payload.cwd=path.join(f.root,'other');
 if(mode==='flagged')f.e.backgroundPending=true;
 if(mode==='output')f.e.output='must not be discarded';
 if(mode==='conflict')await f.main.lifecycle.store.markConflict(f.e,'fixture_conflict');
 if(mode==='missing_hint'){const {readdir,unlink}=await import('node:fs/promises');const d=path.join(f.main.lifecycle.store.root,'clean-hints');for(const n of await readdir(d))await unlink(path.join(d,n));}
 if(mode==='bound_attempt'||mode==='unmapped_write'){
  const id=randomUUID(),dir=path.join(f.main.bus.store.root,'native','attempts');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,id+'.json'),JSON.stringify({schemaVersion:1,wireVersion:'clean-v1',connectionId:f.r.connectionId,provider:'codex',targetSessionId:f.peer.sessionId,sourceSessionId:f.r.claude.sessionId,messageId:randomUUID(),attemptId:id,transportId:randomUUID(),bodySha256:'a'.repeat(64),createdAt:f.e.observedAt,updatedAt:f.e.observedAt,phase:mode==='bound_attempt'?'mapped':'write_started',...(mode==='bound_attempt'?{nativeExecutionId:f.turn}:{})}));
 }
 if(mode==='unfinished_task'||mode==='legacy_outstanding'){const r=(await f.main.bus.store.putNew(createTask({messageId:randomUUID(),from:'claude',to:'codex',targetSessionId:f.peer.sessionId,body:'real unresolved task'},realClock))).record;if(mode==='legacy_outstanding')await f.main.bus.store.replace({...r,state:'expired',attempts:1,receipt:{status:'accepted'}});}
 await f.save();if(mode==='duplicate_file'||mode==='duplicate_peer_file'){const copy=structuredClone(f.rows);if(mode==='duplicate_peer_file')copy[1].payload.turn_attribution.turn_trigger='queue';await writeFile(path.join(path.dirname(f.file),'copy-'+f.peer.sessionId+'.jsonl'),copy.map(x=>JSON.stringify(x)).join('\n')+'\n');}if(mode==='invalid_json')await writeFile(f.file,'not json\n',{flag:'a'});
 const result=await f.processor.process(f.e);assert.ok(['deferred','needs_check'].includes(result.status));assert.equal(await f.main.lifecycle.store.isApplied(f.e.eventKey),false);assert.equal(await f.main.lifecycle.store.getExecution(f.e),undefined);assert.equal(f.sent.length,0);
});
