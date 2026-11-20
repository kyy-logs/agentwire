import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {temp,clock,taskInput} from '../helpers.ts';
import {createTask} from '../../src/model.ts';
import {readCallerSource,readSwitchCallerSource} from '../../src/installation/source.ts';
import {normalizeHook} from '../../src/lifecycle/normalize.ts';

async function registry(){
 const entry=await import('../../src/agents/registry.ts').catch((e:any)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return undefined;throw e;});
 assert.ok(entry,'the unified Agent integration registry must exist');return entry;
}
test('registry rejects unsupported and prototype names without a fallback',async()=>{
 const {getAgent,agents}=await registry();assert.deepEqual(agents.map((a:any)=>a.provider),['codex','claude']);
 for(const name of ['other','__proto__','constructor',undefined])assert.throws(()=>getAgent(name),/invalid_provider/);
 assert.ok(Object.isFrozen(agents));assert.ok(agents.every(Object.isFrozen));
});
test('registered discovery uses the requested native chat, never the latest chat',async t=>{
 const {getAgent}=await registry(),root=await temp(t),id=randomUUID(),other=randomUUID();
 const c={home:root,installRoot:path.join(root,'i'),sourceRoot:root,nodeExe:process.execPath};
 await mkdir(path.join(root,'.codex'));await writeFile(path.join(root,'.codex','session_index.jsonl'),[{id,cwd:root,updated_at:'2000-01-01'},{id:other,cwd:root,updated_at:'2099-01-01'}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 assert.deepEqual((await getAgent('codex').discover(c,id)).map((x:any)=>x.sessionId),[id]);
 assert.deepEqual(await getAgent('claude').discover(c,id),[]);
});
test('registered source policies keep Codex native-only and Claude compatibility explicit',async()=>{
 const {getAgent}=await registry();assert.equal(getAgent('codex').sessionEnv,'CODEX_THREAD_ID');assert.equal(getAgent('codex').allowSkillSession,false);
 assert.equal(getAgent('claude').sessionEnv,'CLAUDE_SESSION_ID');assert.equal(getAgent('claude').allowSkillSession,true);
 assert.equal(getAgent('codex').executionIdField,'turn_id');assert.equal(getAgent('claude').executionIdField,'prompt_id');
});
test('registered human proof rejects peer, missing root and duplicate roots',async()=>{
 const {getAgent}=await registry(),session=randomUUID(),promptId=randomUUID(),cwd=path.resolve('.');
 const e={session_id:session,prompt_id:promptId,prompt:'生成连接码',cwd};
 const row={type:'user',sessionId:session,promptId,isSidechain:false,origin:{kind:'human'},cwd,timestamp:'2026-11-20T00:00:00Z',message:{content:e.prompt}};
 const prove=getAgent('claude').provePairInput;
 assert.equal(prove([row],e)?.cwd,cwd);assert.equal(prove([],e),undefined);assert.equal(prove([row,row],e),undefined);
 assert.equal(prove([{...row,origin:{kind:'peer'}}],e),undefined);assert.equal(getAgent('codex').provePairInput([row],e),undefined);
});
test('runtime assembly shares registered adapters and readers without sending or probing',async()=>{
 const {createAgentRuntime}=await registry();let calls=0;
 const client={async call(){calls++;throw Error('unexpected native call');},async close(){}};
 const runtime=await createAgentRuntime({client,exe:'unused',home:path.resolve('.'),observe:async()=>({status:'unknown'})});
 assert.deepEqual(runtime.adapters.map((a:any)=>a.kind),['codex','claude']);assert.deepEqual(Object.keys(runtime.readers),['codex','claude']);assert.equal(calls,0);
 const b={agentId:'codex',kind:'codex',sessionId:randomUUID(),workspaceRoot:path.resolve('.')};
 const message=createTask({...taskInput(),from:'claude',to:'codex',targetSessionId:randomUUID()},clock());
 assert.equal((await runtime.adapters[0].submit(b,message)).errorCode,'binding_mismatch');assert.equal(calls,0);
});

test('public caller wrappers retain missing, conflict and cross-provider rejection',async()=>{
 const id=randomUUID();
 await assert.rejects(readCallerSource('codex',{},id),/source_session_missing/);
 await assert.rejects(readCallerSource('codex',{CODEX_THREAD_ID:id},randomUUID()),/source_session_conflict/);
 assert.equal((await readCallerSource('claude',{},id)).sessionId,id);
 await assert.rejects(readSwitchCallerSource('claude',{},id),/source_native_identity_required/);
 for(const provider of ['codex','claude'] as const)await assert.rejects(readSwitchCallerSource(provider,{CODEX_THREAD_ID:id,CLAUDE_SESSION_ID:id}),/source_provider_conflict/);
});
test('lifecycle normalization keeps each native execution field and rejects wrong Claude agent type',()=>{
 const session=randomUUID(),turn=randomUUID(),prompt=randomUUID();
 const event={hook_event_name:'Stop',session_id:session,turn_id:turn,prompt_id:prompt,last_assistant_message:'result'};
 assert.equal(normalizeHook('codex',event)?.nativeExecutionId,turn);
 assert.equal(normalizeHook('claude',event)?.nativeExecutionId,prompt);
 assert.equal(normalizeHook('claude',{...event,agent_type:'worker'}),undefined);
 assert.equal(normalizeHook('codex',{...event,turn_id:undefined}),undefined);
 assert.equal(normalizeHook('claude',{...event,prompt_id:undefined}),undefined);
});
