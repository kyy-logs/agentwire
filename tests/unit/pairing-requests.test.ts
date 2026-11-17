import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {temp} from '../helpers.ts';
import {stagePairRequest,resolvePairRequest} from '../../src/pairing/requests.ts';
import {issueCode} from '../../src/pairing/store.ts';
import {routeHook} from '../../src/installation/hook-router.ts';

const epoch=Date.parse('2026-11-17T10:00:00Z');
async function fixture(t:any,provider:'codex'|'claude'='codex'){
 const root=await temp(t),home=path.join(root,'home'),cwd=path.join(root,'project'),sessionId=randomUUID(),inputId=randomUUID(),clock={value:epoch};
 const file=path.join(home,provider==='codex'?'.codex':'.claude',provider==='codex'?'sessions':'projects',sessionId+'.jsonl');
 const c={home,installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath},deps={now:()=>new Date(clock.value)};
 const event={hook_event_name:'UserPromptSubmit',session_id:sessionId,turn_id:inputId,prompt_id:inputId,prompt:'生成连接码',cwd,transcript_path:file};
 const rows:any[]=provider==='codex'?[{type:'session_meta',payload:{id:sessionId,cwd,source:'vscode'}},{type:'event_msg',payload:{type:'task_started',turn_id:inputId,turn_attribution:{turn_id:inputId,turn_trigger:'composer',parent_turn_id:null,initiating_agent_path:null,root_turn_id:inputId}}},{type:'turn_context',payload:{turn_id:inputId,cwd}},{type:'response_item',timestamp:new Date(epoch).toISOString(),payload:{type:'message',role:'user',content:[{type:'input_text',text:event.prompt}]}}]:[{type:'user',sessionId,promptId:inputId,isSidechain:false,origin:{kind:'human'},cwd,timestamp:new Date(epoch).toISOString(),message:{content:event.prompt}}];
 const save=async()=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');};
 return {root,c,provider,event,rows,file,save,clock,deps,state:path.join(c.installRoot,'pairing','state.json')};
}

test('Hook can stage before Codex native input exists but cannot issue until exact proof appears',async t=>{
 const f=await fixture(t),ticket=await stagePairRequest(f.c,f.provider,f.event,f.deps);assert.ok(ticket);
 const state=JSON.parse(await readFile(f.state,'utf8'));assert.equal(state.requests.length,1);assert.equal(state.intents.length,0);assert.equal(state.invitations.length,0);
 await assert.rejects(()=>issueCode(f.c,ticket,f.deps),/pairing_identity_unconfirmed/);await assert.rejects(()=>resolvePairRequest(f.c,ticket,f.deps),/pairing_identity_unconfirmed/);
 await f.save();const intent=await resolvePairRequest(f.c,ticket,f.deps);assert.equal(intent.source.sessionId,f.event.session_id);assert.equal(intent.nativeInputId,f.event.turn_id);assert.ok(await issueCode(f.c,intent.intentId,f.deps));
});

test('both providers resolve only the exact staged request and repeated Hook events keep their ticket',async t=>{
 for(const provider of ['codex','claude'] as const){const f=await fixture(t,provider);await f.save();const ticket=await stagePairRequest(f.c,provider,f.event,f.deps);assert.ok(ticket);assert.equal(await stagePairRequest(f.c,provider,f.event,f.deps),ticket);
 const before=await readFile(f.state);await assert.rejects(()=>resolvePairRequest(f.c,randomUUID(),f.deps),/pairing_identity_unconfirmed/);assert.deepEqual(await readFile(f.state),before);
 const intent=await resolvePairRequest(f.c,ticket,f.deps),r=await issueCode(f.c,intent.intentId,f.deps);f.clock.value+=120000;assert.deepEqual(await resolvePairRequest(f.c,ticket,f.deps),intent);assert.deepEqual(await issueCode(f.c,intent.intentId,f.deps),r);}
});

test('queue, peer and child staged requests never turn into verified authority',async t=>{
 for(const provider of ['codex','claude'] as const)for(const child of [false,true]){const f=await fixture(t,provider);
 if(provider==='codex'){if(child)f.rows[0].payload.source={subagent:{other:'worker'}};else f.rows[1].payload.turn_attribution.turn_trigger='queue';}
 else if(child)f.rows[0].isSidechain=true;else f.rows[0].origin.kind='peer';await f.save();const ticket=await stagePairRequest(f.c,provider,f.event,f.deps);assert.ok(ticket);await assert.rejects(()=>resolvePairRequest(f.c,ticket,f.deps),/pairing_identity_unconfirmed/);
 const state=JSON.parse(await readFile(f.state,'utf8'));assert.equal(state.intents.length,0);assert.equal(state.invitations.length,0);}
});

test('ordinary, malformed and explicit child inputs stage nothing and do not create the installation root',async t=>{
 const f=await fixture(t);for(const change of [{prompt:'ordinary private text'},{prompt:'```\n生成连接码\n```'},{agent_id:'worker'},{transcript_path:path.join(f.root,'outside.jsonl')},{session_id:'bad'},{hook_event_name:'Stop'}])assert.equal(await stagePairRequest(f.c,f.provider,{...f.event,...change},f.deps),undefined);
 assert.deepEqual(await readdir(f.root),[]);
});

test('staging stores only whitelisted control fields and rejects mutation of the same native input',async t=>{
 const f=await fixture(t),ticket=await stagePairRequest(f.c,f.provider,{...f.event,unrelated_secret:'MUST_NOT_STORE'},f.deps);assert.ok(ticket);const before=await readFile(f.state);assert.ok(!before.toString().includes('MUST_NOT_STORE'));
 await assert.rejects(()=>stagePairRequest(f.c,f.provider,{...f.event,prompt:'给这个聊天生成连接码'},f.deps),/pairing_identity_unconfirmed/);assert.deepEqual(await readFile(f.state),before);
});

test('unresolved request expires at 120 seconds and native clock still independently rejects stale evidence',async t=>{
 const f=await fixture(t),ticket=await stagePairRequest(f.c,f.provider,f.event,f.deps);assert.ok(ticket);await f.save();f.clock.value+=120000;await assert.rejects(()=>resolvePairRequest(f.c,ticket,f.deps),/pairing_intent_expired/);
 const g=await fixture(t);g.rows.at(-1).timestamp=new Date(epoch-120000).toISOString();await g.save();const other=await stagePairRequest(g.c,g.provider,g.event,g.deps);assert.ok(other);await assert.rejects(()=>resolvePairRequest(g.c,other,g.deps),/pairing_identity_unconfirmed/);
});

test('unpaired router returns the exact request ticket in native context before any route exists',async t=>{
 for(const provider of ['codex','claude'] as const){const f=await fixture(t,provider);let output='';const deps={...f.deps,stdout:{write(s:string){output+=s;}}};
 assert.equal(await routeHook(f.c,provider,[Buffer.from(JSON.stringify(f.event))],deps),0);const context=JSON.parse(output).hookSpecificOutput;assert.equal(context.hookEventName,'UserPromptSubmit');
 const ticket=/AGENTWIRE_PAIR_REQUEST=([a-f0-9-]{36})/.exec(context.additionalContext)?.[1];assert.ok(ticket);assert.ok(context.additionalContext.includes('尚未核验'));assert.ok(context.additionalContext.includes('pair issue --intent '+ticket));
 assert.equal(JSON.parse(await readFile(f.state,'utf8')).intents.length,0);await f.save();assert.equal((await resolvePairRequest(f.c,ticket,f.deps)).source.sessionId,f.event.session_id);
 output='';await routeHook(f.c,provider,[Buffer.from(JSON.stringify(f.event))],deps);assert.ok(output.includes(ticket));}
});
