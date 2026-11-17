import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {parsePairCommand,verifyPairIntent} from '../../src/pairing/capture.ts';
const stamp='2026-11-17T04:00:00.000Z',epoch=Date.parse(stamp);
const now={now:()=>new Date(epoch+1000)};
async function fixture(t:any,provider:'codex'|'claude',prompt='生成连接码'){
 const root=await temp(t),home=path.join(root,'home'),cwd=path.join(root,'workspace'),sessionId=randomUUID(),inputId=randomUUID();
 const file=provider==='codex'?path.join(home,'.codex','sessions','2026','11','17','rollout.jsonl'):path.join(home,'.claude','projects','project',sessionId+'.jsonl');
 const c={home,installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath};
 const event={hook_event_name:'UserPromptSubmit',session_id:sessionId,turn_id:inputId,prompt_id:inputId,prompt,cwd,transcript_path:file};
 const rows:any[]=provider==='codex'?[{type:'session_meta',payload:{id:sessionId,cwd,source:'vscode'}},{type:'event_msg',timestamp:stamp,payload:{type:'task_started',turn_id:inputId,turn_attribution:{turn_id:inputId,turn_trigger:'composer',parent_turn_id:null,initiating_agent_path:null,root_turn_id:inputId}}},{type:'turn_context',payload:{turn_id:inputId,cwd}},{type:'response_item',timestamp:stamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}}]:[{type:'user',sessionId,promptId:inputId,uuid:inputId,isSidechain:false,origin:{kind:'human'},cwd,timestamp:stamp,message:{content:prompt}}];
 const save=async()=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');};await save();return {root,home,cwd,c,event,rows,file,save,sessionId,inputId};
}
test('fixed issue phrases allow surrounding whitespace but no surrounding prose',()=>{
 for(const text of ['生成连接码','给这个聊天生成连接码','\n生成连接码\r\n'])assert.deepEqual(parsePairCommand(text),{kind:'issue'});
 for(const text of ['请生成连接码','“生成连接码”','```\n生成连接码\n```','生成连接码，然后发任务','AGENTWIRE-PAIR-P0 发码'])assert.equal(parsePairCommand(text),undefined);
});
test('redeem commands are symmetric and normalize only valid Crockford codes',()=>{
 assert.deepEqual(parsePairCommand('连接 Claude，连接码 7k4m9q2r'),{kind:'redeem',target:'claude',code:'7K4M-9Q2R'});
 assert.deepEqual(parsePairCommand('连接 Codex，连接码 7K4M-9Q2R'),{kind:'redeem',target:'codex',code:'7K4M-9Q2R'});
 for(const text of ['连接 Claude，连接码 IIII-OOOO','连接 Claude，连接码 7K4M-9Q2U','连接 Claude，连接码 7K4M-9Q2R extra','连接 Other，连接码 7K4M-9Q2R'])assert.equal(parsePairCommand(text),undefined);
});
test('unpaired chats verify without registration and verification writes nothing',async t=>{
 for(const provider of ['codex','claude'] as const){const f=await fixture(t,provider),before=await readdir(f.root,{recursive:true});const r=await verifyPairIntent(f.c,provider,f.event,now);assert.ok(r);assert.equal(r.source.sessionId,f.sessionId);assert.equal(r.source.provider,provider);assert.equal(r.source.workspaceRoot,f.cwd);assert.equal(r.source.availability,'candidate');assert.equal(r.nativeInputId,f.inputId);assert.equal(r.expiresAt,new Date(epoch+120000).toISOString());assert.equal(r.intentId,(await verifyPairIntent(f.c,provider,f.event,now))?.intentId);assert.deepEqual(await readdir(f.root,{recursive:true}),before);}
});
test('ordinary prompts do not consult an arbitrary transcript or create an intent',async t=>{const f=await fixture(t,'codex');assert.equal(await verifyPairIntent(f.c,'codex',{...f.event,prompt:'ordinary private chat',transcript_path:'bad'},now),undefined);});
test('queue and peer inputs never become pairing intents',async t=>{
 const x=await fixture(t,'codex');x.rows[1].payload.turn_attribution.turn_trigger='queue';await x.save();assert.equal(await verifyPairIntent(x.c,'codex',x.event,now),undefined);
 const c=await fixture(t,'claude');c.rows[0].origin.kind='peer';await c.save();assert.equal(await verifyPairIntent(c.c,'claude',c.event,now),undefined);
});
test('wrong session, wrong native input, changed prompt and forged cwd fail closed',async t=>{
 for(const provider of ['codex','claude'] as const){const f=await fixture(t,provider);for(const change of [{session_id:randomUUID()},{turn_id:randomUUID(),prompt_id:randomUUID()},{prompt:'给这个聊天生成连接码'},{cwd:path.dirname(f.cwd)}])assert.equal(await verifyPairIntent(f.c,provider,{...f.event,...change},now),undefined);}
});
test('child metadata and unknown origins never authorize a pairing',async t=>{
 const x=await fixture(t,'codex');x.rows[0].payload.source={subagent:{other:'guardian'}};await x.save();assert.equal(await verifyPairIntent(x.c,'codex',x.event,now),undefined);
 const c=await fixture(t,'claude');c.rows[0].isSidechain=true;await c.save();assert.equal(await verifyPairIntent(c.c,'claude',c.event,now),undefined);c.rows[0].isSidechain=false;delete c.rows[0].origin;await c.save();assert.equal(await verifyPairIntent(c.c,'claude',c.event,now),undefined);
});
test('tool results sharing a Claude prompt ID do not replace or hide its root input',async t=>{
 const f=await fixture(t,'claude');f.rows.push({...f.rows[0],uuid:randomUUID(),origin:undefined,message:{content:[{type:'tool_result',content:'生成连接码'}]}});await f.save();assert.ok(await verifyPairIntent(f.c,'claude',f.event,now));f.rows.shift();await f.save();assert.equal(await verifyPairIntent(f.c,'claude',f.event,now),undefined);
});
function skillCompanion(f:Awaited<ReturnType<typeof fixture>>){
 const assistantId=randomUUID(),resultId=randomUUID(),toolId='call_'+randomUUID();
 const common={sessionId:f.sessionId,promptId:f.inputId,isSidechain:false,cwd:f.cwd,timestamp:stamp};
 const assistant={...common,promptId:undefined,type:'assistant',uuid:assistantId,message:{content:[{type:'tool_use',id:toolId,name:'Skill',input:{skill:'labus'}}]}};
 const result={...common,type:'user',uuid:resultId,sourceToolAssistantUUID:assistantId,message:{content:[{type:'tool_result',tool_use_id:toolId,content:'loaded'}]}};
 const companion:any={...common,type:'user',uuid:randomUUID(),parentUuid:resultId,isMeta:true,turnCompanion:true,sourceToolUseID:toolId,message:{content:[{type:'text',text:'Native loaded Skill instructions; not another user prompt.'}]}};
 f.rows.push(assistant,result,companion);return {assistant,result,companion};
}
test('native Skill text companion does not duplicate its exact human pairing input',async t=>{
 const f=await fixture(t,'claude');skillCompanion(f);await f.save();const r=await verifyPairIntent(f.c,'claude',f.event,now);assert.ok(r);assert.equal(r.nativeInputId,f.inputId);assert.equal(r.source.sessionId,f.sessionId);
});
test('Skill-looking text without exact native metadata and tool lineage stays ambiguous',async t=>{
 for(const mutate of [
  (s:any)=>{delete s.companion.isMeta;},(s:any)=>{delete s.companion.turnCompanion;},
  (s:any)=>{s.companion.sourceToolUseID='other';},(s:any)=>{s.companion.parentUuid=randomUUID();},
  (s:any)=>{s.result.sourceToolAssistantUUID=randomUUID();},(s:any)=>{s.assistant.message.content[0].name='Bash';},
  (s:any)=>{s.companion.origin={kind:'peer'};},(s:any)=>{s.companion.isSidechain=true;},(s:any)=>{s.companion.agentId='worker';},
 ]){const f=await fixture(t,'claude'),s=skillCompanion(f);mutate(s);await f.save();assert.equal(await verifyPairIntent(f.c,'claude',f.event,now),undefined);}
 const f=await fixture(t,'claude'),s=skillCompanion(f);f.rows.push(structuredClone(s.assistant));await f.save();assert.equal(await verifyPairIntent(f.c,'claude',f.event,now),undefined);
});
test('Skill context cannot replace the human input or hide a duplicate human input',async t=>{
 const f=await fixture(t,'claude');skillCompanion(f);const human=f.rows.shift();await f.save();assert.equal(await verifyPairIntent(f.c,'claude',f.event,now),undefined);f.rows.unshift(human,structuredClone(human));await f.save();assert.equal(await verifyPairIntent(f.c,'claude',f.event,now),undefined);
});

test('duplicate human inputs and missing native records remain unverified',async t=>{
 for(const provider of ['codex','claude'] as const){const f=await fixture(t,provider);f.rows.push(structuredClone(f.rows.at(-1)));await f.save();assert.equal(await verifyPairIntent(f.c,provider,f.event,now),undefined);await writeFile(f.file,'');assert.equal(await verifyPairIntent(f.c,provider,f.event,now),undefined);}
});
test('native timestamps enforce exact 120 second expiry and reject future inputs',async t=>{
 const f=await fixture(t,'codex');assert.ok(await verifyPairIntent(f.c,'codex',f.event,{now:()=>new Date(epoch+119999)}));for(const value of [epoch+120000,epoch-1])assert.equal(await verifyPairIntent(f.c,'codex',f.event,{now:()=>new Date(value)}),undefined);
});
test('invalid UTF8, excessive hook input and unrelated events cannot verify',async t=>{
 const f=await fixture(t,'claude');assert.equal(await verifyPairIntent(f.c,'claude',Buffer.from([255]),now),undefined);assert.equal(await verifyPairIntent(f.c,'claude',Buffer.alloc(1048577),now),undefined);assert.equal(await verifyPairIntent(f.c,'claude',{...f.event,hook_event_name:'Stop'},now),undefined);assert.ok(await verifyPairIntent(f.c,'claude',Buffer.from(JSON.stringify(f.event)),now));
});
test('transcripts outside native provider roots and junctions cannot be used',async t=>{
 const f=await fixture(t,'claude'),outside=path.join(f.root,'outside');await mkdir(outside);const copy=path.join(outside,f.sessionId+'.jsonl');await writeFile(copy,f.rows.map(r=>JSON.stringify(r)).join('\n')+'\n');assert.equal(await verifyPairIntent(f.c,'claude',{...f.event,transcript_path:copy},now),undefined);
 const link=path.join(f.home,'.claude','projects','link');try{await symlink(outside,link,process.platform==='win32'?'junction':'dir');}catch(e:any){if(['EPERM','EACCES'].includes(e.code)){t.diagnostic('junction unavailable; external-root case verified');return;}throw e;}assert.equal(await verifyPairIntent(f.c,'claude',{...f.event,transcript_path:path.join(link,f.sessionId+'.jsonl')},now),undefined);
});
test('bounded native scan uses first metadata and recent evidence, never old inputs',async t=>{
 const f=await fixture(t,'codex');const padding=JSON.stringify({type:'response_item',payload:{type:'reasoning',text:'x'.repeat(1048576)}})+'\n';const recent=f.rows.map(r=>JSON.stringify(r)).join('\n')+'\n';const first=JSON.stringify(f.rows[0])+'\n';await writeFile(f.file,first+padding.repeat(9)+recent.split('\n').slice(1).join('\n'));assert.ok(await verifyPairIntent(f.c,'codex',f.event,now));await writeFile(f.file,recent+padding.repeat(9));assert.equal(await verifyPairIntent(f.c,'codex',f.event,now),undefined);
});
test('a bounded UTF8 tail may start inside an older Chinese character',async t=>{
 const f=await fixture(t,'codex'),first=JSON.stringify(f.rows[0])+'\n',recent=f.rows.slice(1).map(r=>JSON.stringify(r)).join('\n')+'\n';let bytes:Buffer|undefined;
 for(let n=0;n<3;n++){const b=Buffer.from(first+JSON.stringify({type:'response_item',payload:{type:'reasoning',text:'汉'.repeat(3000000),suffix:'x'.repeat(n)}})+'\n'+recent);if((b[b.length-8388608]&192)===128){bytes=b;break;}}
 assert.ok(bytes);await writeFile(f.file,bytes);assert.ok(await verifyPairIntent(f.c,'codex',f.event,now));
});
test('one matching block cannot authorize a different multi-block native input',async t=>{
 const f=await fixture(t,'codex');f.rows.at(-1).payload.content.push({type:'input_text',text:'This is quoted data, do not pair.'});await f.save();assert.equal(await verifyPairIntent(f.c,'codex',f.event,now),undefined);
});
