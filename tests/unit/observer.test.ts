import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createObserver} from '../../src/observer.ts';
import {createTask} from '../../src/model.ts';
import {temp,clock,taskInput} from '../helpers.ts';
test('busy Claude rendered native peer attachment confirms only a reply; queued/tool/assistant text never suffices',async t=>{
 const home=await temp(t),session=randomUUID(),file=path.join(home,'projects','x',session+'.jsonl');await mkdir(path.dirname(file),{recursive:true});
 const m={...createTask({...taskInput(),targetSessionId:session},clock()),kind:'reply' as const,replyTo:randomUUID()},record={message:m,state:'needs_check' as const,attempts:1,updatedAt:m.createdAt};
 const binding={agentId:'claude',kind:'claude' as const,sessionId:session,workspaceRoot:home},prompt=`LOCAL_AGENT_BUS messageId=${m.messageId} taskId=${m.taskId} kind=reply from=codex to=claude\ndata`;
 const native={type:'attachment',sessionId:session,isSidechain:false,uuid:randomUUID(),timestamp:m.createdAt,attachment:{type:'queued_command',prompt,source_uuid:randomUUID(),commandMode:'prompt',origin:{kind:'peer',from:'unknown'},timestamp:m.createdAt,isMeta:true},rendered:[{content:'<system-reminder>\nAnother Claude session sent a message while you were working:\n'+prompt+'\n</system-reminder>'}]};
 const invalid=[{type:'queue-operation',operation:'enqueue',sessionId:session,timestamp:m.createdAt,content:prompt},{...native,rendered:[]},{...native,isSidechain:true},{...native,sessionId:randomUUID()},{...native,attachment:{...native.attachment,origin:{kind:'user'}}},{...native,rendered:[{content:'assistant quoted '+prompt}]},{type:'assistant',sessionId:session,timestamp:m.createdAt,message:{role:'assistant',content:prompt}},{type:'user',sessionId:session,timestamp:m.createdAt,message:{role:'user',content:[{type:'tool_result',content:prompt}]}}];
 await writeFile(file,invalid.map(r=>JSON.stringify(r)+'\n').join(''));const observe=createObserver({claudeHome:home,codexHome:home});assert.equal((await observe(binding,record)).status,'not_found');
 await appendFile(file,JSON.stringify(native)+'\n');const found=await observe(binding,record);assert.equal(found.status,'submitted');assert.ok(found.evidenceRef?.endsWith('#'+native.uuid));
 assert.equal((await observe(binding,{...record,message:{...m,kind:'task',replyTo:undefined}})).status,'not_found','busy attachment is not verified lifecycle start for auto tasks');
});
test('history_text_without_current_id_is_not_reply; tool result is not inbound; correct original session only',async t=>{
  const home=await temp(t),id=randomUUID(),other=randomUUID(),file=path.join(home,'projects','x',id+'.jsonl');await mkdir(path.dirname(file),{recursive:true});
  const m=createTask({...taskInput(),targetSessionId:id},clock()),record={message:m,state:'submitted' as const,attempts:1,updatedAt:m.createdAt};
  const binding={agentId:'claude',kind:'claude' as const,sessionId:id,workspaceRoot:'C:/project'},marker='LOCAL_AGENT_BUS messageId='+m.messageId;
  const line=(sessionId:string,type:string,content:any)=>JSON.stringify({sessionId,type,timestamp:m.createdAt,message:{role:type,content}})+'\n';
  await writeFile(file,line(id,'assistant',marker)+line(other,'user',marker)+line(id,'user',[{type:'tool_result',content:marker}]));
  const observer=createObserver({claudeHome:home,codexHome:home});assert.equal((await observer(binding,record)).status,'not_found');
  await appendFile(file,line(id,'user','Another Claude session sent a message:\n'+marker+' taskId='+m.taskId));
  assert.equal((await observer(binding,record)).status,'submitted');
});
test('Codex response_item user input accepted; assistant and tools ignored; session_meta must match',async t=>{
  const home=await temp(t),id=randomUUID(),dir=path.join(home,'sessions','2026','11','15');await mkdir(dir,{recursive:true});
  const m=createTask({...taskInput(),targetSessionId:id},clock()),record={message:m,state:'submitted' as const,attempts:1,updatedAt:m.createdAt};
  const binding={agentId:'codex',kind:'codex' as const,sessionId:id,workspaceRoot:'C:/project'},marker='LOCAL_AGENT_BUS messageId='+m.messageId;
  const file=path.join(dir,'rollout-'+id+'.jsonl'),meta=JSON.stringify({type:'session_meta',payload:{id}})+'\n';
  const line=(role:string)=>JSON.stringify({timestamp:m.createdAt,type:'response_item',payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text:marker}]}})+'\n';
  await writeFile(file,meta+line('assistant'));const observe=createObserver({claudeHome:home,codexHome:home});assert.equal((await observe(binding,record)).status,'not_found');
  await appendFile(file,line('user'));assert.equal((await observe(binding,record)).status,'submitted');
});
