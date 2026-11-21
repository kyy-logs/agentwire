import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {proveCodexAction,proveClaudeAction,verifyActionOwnership} from '../../src/collaboration/native-actions.ts';
import {actionDigest} from '../../src/collaboration/model.ts';
const launcher='C:/fixture/labus.cmd';
function fixture(provider:'codex'|'claude'='codex'){
 const actor={provider,sessionId:randomUUID()},turn=randomUUID();
 const request:any={operationId:randomUUID(),taskId:randomUUID(),actor,kind:'question',expectedRevision:0,body:'Which behavior?'};
 const command='"'+launcher+'" question --provider '+provider+' --source-session '+actor.sessionId+' --task '+request.taskId+' --operation '+request.operationId+' --revision 0 --text-file "C:/fixture/question.txt"';
 const receipt={ok:true,operation:'question',phase:'pending_verification',data:{operationId:request.operationId,requestSha256:actionDigest(request)}};
 return {actor,turn,request,command,receipt};
}
function codexRows(f:ReturnType<typeof fixture>){
 const id=randomUUID(),meta={turn_id:f.turn,create_time:'2026-11-20T00:00:00Z'};
 return [{type:'session_meta',payload:{id:f.actor.sessionId,source:'vscode'}},
 {type:'event_msg',payload:{type:'task_started',turn_id:f.turn}},
 {type:'custom_tool_call',payload:{name:'exec',call_id:id,input:'text((await tools.exec_command('+JSON.stringify({cmd:f.command})+')).output);',internal_chat_message_metadata_passthrough:meta}},
 {type:'custom_tool_call_output',payload:{call_id:id,output:[{type:'input_text',text:JSON.stringify(f.receipt)}],internal_chat_message_metadata_passthrough:meta}}];
}
function claudeRows(f:ReturnType<typeof fixture>){
 const root=randomUUID(),call=randomUUID(),tool=randomUUID(),base={sessionId:f.actor.sessionId,isSidechain:false};
 return [{...base,type:'user',uuid:root,promptId:f.turn,origin:{kind:'peer'},message:{content:'task'}},
 {...base,type:'assistant',uuid:call,parentUuid:root,message:{content:[{type:'tool_use',id:tool,name:'Bash',input:{command:f.command}}]}},
 {...base,type:'user',uuid:randomUUID(),parentUuid:call,promptId:f.turn,sourceToolAssistantUUID:call,message:{content:[{type:'tool_result',tool_use_id:tool,content:JSON.stringify(f.receipt)}]}}];
}
test('Codex tool call and exact result prove one native execution',()=>{
 const f=fixture();const r=proveCodexAction(codexRows(f),f.request,[launcher]);assert.equal(r.status,'verified');if(r.status==='verified'){assert.equal(r.ref.nativeExecutionId,f.turn);assert.equal(r.requestSha256,actionDigest(f.request));}
});
test('Claude tool result must belong to its exact tool-use and parent lineage',()=>{
 const f=fixture('claude');const r=proveClaudeAction(claudeRows(f),f.request,[launcher]);assert.equal(r.status,'verified');if(r.status==='verified')assert.equal(r.ref.nativeExecutionId,f.turn);
});
test('operation in ordinary text or unsupported orchestration is not proof',()=>{
 const f=fixture(),rows=codexRows(f);rows[2].payload.input='text('+JSON.stringify(f.command)+');';assert.notEqual(proveCodexAction(rows,f.request,[launcher]).status,'verified');
});
test('tool result missing is pending and a mismatched digest never verifies',()=>{
 for(const provider of ['codex','claude'] as const){const f=fixture(provider),rows=provider==='codex'?codexRows(f):claudeRows(f),prove=provider==='codex'?proveCodexAction:proveClaudeAction;
 assert.equal(prove(rows.slice(0,-1),f.request,[launcher]).status,'pending');
 const broken=JSON.parse(JSON.stringify(rows).replaceAll(actionDigest(f.request),'0'.repeat(64)));assert.notEqual(prove(broken,f.request,[launcher]).status,'verified');}
});
test('two executions for the same operation are a conflict rather than latest wins',()=>{
 const f=fixture(),a=codexRows(f),b=codexRows({...f,turn:randomUUID()}).slice(1);assert.equal(proveCodexAction([...a,...b],f.request,[launcher]).status,'conflict');
});
test('wrong session, sidechain and wrong parent are rejected',()=>{
 const f=fixture('claude'),rows=claudeRows(f);
 for(const mutate of [(r:any[])=>r[1].sessionId=randomUUID(),(r:any[])=>r[1].isSidechain=true,(r:any[])=>r[2].parentUuid=randomUUID(),(r:any[])=>r[2].sourceToolAssistantUUID=randomUUID(),(r:any[])=>r[2].promptId=randomUUID()]){
 const copy=structuredClone(rows);mutate(copy);assert.notEqual(proveClaudeAction(copy,f.request,[launcher]).status,'verified');}
});
test('Codex output from another turn or another call cannot prove the action',()=>{
 const f=fixture();for(const field of ['turn','call']){const rows=codexRows(f);if(field==='turn')rows[3].payload.internal_chat_message_metadata_passthrough.turn_id=randomUUID();else rows[3].payload.call_id=randomUUID();assert.notEqual(proveCodexAction(rows,f.request,[launcher]).status,'verified');}
});
test('shell chaining, another launcher and another task cannot borrow a receipt',()=>{
 const f=fixture();for(const command of [f.command+'; echo done',f.command.replace('C:/fixture/labus.cmd','C:/other/labus.cmd'),f.command.replace(f.request.taskId,randomUUID())]){
 assert.notEqual(proveCodexAction(codexRows({...f,command}),f.request,[launcher]).status,'verified');}
});
test('ordinary human input breaks Claude ancestry even if prompt id is reused',()=>{
 const f=fixture('claude'),rows=claudeRows(f),ordinary={...rows[0],uuid:randomUUID(),origin:{kind:'human'}};
 rows[1].parentUuid=ordinary.uuid;rows.splice(1,0,ordinary);
 // tool still belongs to the new human turn, not to the peer task; ownership checks must reject it.
 const r=proveClaudeAction(rows,f.request,[launcher]);const task:any={taskId:f.request.taskId,initiator:{provider:'codex',sessionId:randomUUID()},executor:f.actor,currentMessageId:randomUUID()};
 const mapped:any=[{phase:'mapped',provider:'claude',targetSessionId:f.actor.sessionId,nativeExecutionId:randomUUID(),messageId:task.currentMessageId}];
 assert.throws(()=>verifyActionOwnership(task,f.request,r,mapped),/collaboration_execution_mismatch/);
});
test('executor proof must match this exact task input, not another task in same session',()=>{
 const f=fixture(),e=proveCodexAction(codexRows(f),f.request,[launcher]),message=randomUUID(),task:any={taskId:f.request.taskId,executor:f.actor,initiator:{provider:'claude',sessionId:randomUUID()},currentMessageId:message};
 const good:any={phase:'mapped',provider:'codex',targetSessionId:f.actor.sessionId,nativeExecutionId:f.turn,messageId:message};
 assert.equal(verifyActionOwnership(task,f.request,e,[good]).nativeExecutionId,f.turn);
 assert.throws(()=>verifyActionOwnership(task,f.request,e,[{...good,messageId:randomUUID()}]),/collaboration_execution_mismatch/);
 assert.throws(()=>verifyActionOwnership(task,f.request,{status:'pending'},[good]),/collaboration_action_unverified/);
});
test('ambiguous native input mapping and wrong actor role fail closed',()=>{
 const f=fixture(),e=proveCodexAction(codexRows(f),f.request,[launcher]),task:any={taskId:f.request.taskId,executor:f.actor,initiator:{provider:'claude',sessionId:randomUUID()},currentMessageId:randomUUID()};
 const row:any={phase:'mapped',provider:'codex',targetSessionId:f.actor.sessionId,nativeExecutionId:f.turn,messageId:task.currentMessageId};
 assert.throws(()=>verifyActionOwnership(task,f.request,e,[row,{...row}]),/collaboration_execution_mismatch/);
 assert.throws(()=>verifyActionOwnership(task,{...f.request,kind:'answer'},e,[row]),/collaboration_role_mismatch/);
});

test('initiator human proof cannot borrow a native execution already mapped to another task',()=>{const f=fixture(),r:any={...f.request,kind:'accept',body:undefined,deliveryId:randomUUID()},e:any={status:'verified',ref:{...f.actor,nativeExecutionId:f.turn},human:true,requestSha256:actionDigest(r),evidenceRef:'fixture'},task:any={initiator:f.actor,executor:{provider:'claude',sessionId:randomUUID()},currentMessageId:randomUUID()};const other:any={phase:'mapped',provider:f.actor.provider,targetSessionId:f.actor.sessionId,nativeExecutionId:f.turn,messageId:randomUUID()};assert.throws(()=>verifyActionOwnership(task,r,e,[other]),/collaboration_execution_mismatch/);assert.equal(verifyActionOwnership(task,r,e,[]).nativeExecutionId,f.turn);const own={...other,messageId:task.currentMessageId};assert.throws(()=>verifyActionOwnership(task,r,e,[own,other]),/collaboration_execution_mismatch/);});
test('a single PowerShell call operator is supported but shell chaining still cannot prove an action',()=>{const f=fixture();assert.equal(proveCodexAction(codexRows({...f,command:'& '+f.command}),f.request,[launcher]).status,'verified');for(const command of ['&& '+f.command,'& '+f.command+' & echo unsafe'])assert.notEqual(proveCodexAction(codexRows({...f,command}),f.request,[launcher]).status,'verified');});

test('a separate UUID preparation tool does not invalidate a literal Claude action',()=>{
 const f=fixture('claude'),rows=claudeRows(f),prepare=JSON.parse(JSON.stringify(rows[1])),output=JSON.parse(JSON.stringify(rows[2]));
 prepare.uuid=randomUUID();prepare.parentUuid=rows[0].uuid;
 prepare.message.content=[{type:'tool_use',id:randomUUID(),name:'Bash',input:{command:'powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()"'}}];
 output.uuid=randomUUID();output.parentUuid=prepare.uuid;output.sourceToolAssistantUUID=prepare.uuid;
 output.message.content=[{type:'tool_result',tool_use_id:prepare.message.content[0].id,content:f.request.operationId}];
 rows[1].parentUuid=output.uuid;rows.splice(1,0,prepare,output);
 assert.equal(proveClaudeAction(rows,f.request,[launcher]).status,'verified');
});
test('a UUID preparation chain with the exact successful CLI receipt still cannot prove a Claude action',()=>{
 const f=fixture('claude'),command='UUID=$(powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()"); echo operation; '+f.command.replace(f.request.operationId,'"$UUID"');
 assert.notEqual(proveClaudeAction(claudeRows({...f,command}),f.request,[launcher]).status,'verified');
});

function withArguments(f:ReturnType<typeof fixture>,args:string){const rows=codexRows(f);rows[2].payload.input='text((await tools.exec_command('+args+')).output);';return rows;}
const singleLiteral=(s:string)=>"'"+s.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";
test('Codex static object arguments accept unquoted keys and single-quoted command without replay',()=>{
 const f=fixture(),args='{cmd:'+singleLiteral('& '+f.command)+',sandbox_permissions:"require_escalated",justification:"exact original task",max_output_tokens:2000}';
 const proof=proveCodexAction(withArguments(f,args),f.request,[launcher]);assert.equal(proof.status,'verified');
 if(proof.status==='verified')assert.equal(proof.ref.nativeExecutionId,f.turn);
});
test('static argument strings decode escapes and permit surrounding formatting and trailing comma',()=>{
 const f=fixture(),args="{\n cmd: "+singleLiteral(f.command)+", justification: 'review\\'s \\\\ path \\u4e2d', login: false, tty: true, yield_time_ms: 1e3, max_output_tokens: 2000,\n}";
 assert.equal(proveCodexAction(withArguments(f,args),f.request,[launcher]).status,'verified');
});
test('strict JSON arguments with a documented array option remain supported',()=>{
 const f=fixture();assert.equal(proveCodexAction(withArguments(f,JSON.stringify({cmd:f.command,prefix_rule:['node']})),f.request,[launcher]).status,'verified');
});
test('a JSON call and static object call for one operation still conflict',()=>{
 const f=fixture(),second=withArguments({...f,turn:randomUUID()},'{cmd:'+singleLiteral(f.command)+'}');
 assert.equal(proveCodexAction([...codexRows(f),...second.slice(1)],f.request,[launcher]).status,'conflict');
});
test('static object proof still requires the exact receipt, actor, turn and launcher',()=>{
 const f=fixture(),args='{cmd:'+singleLiteral(f.command)+'}';
 for(const mutate of [(r:any[])=>r[0].payload.id=randomUUID(),(r:any[])=>r[3].payload.internal_chat_message_metadata_passthrough.turn_id=randomUUID(),(r:any[])=>r[3].payload.output[0].text=JSON.stringify({...f.receipt,data:{...f.receipt.data,requestSha256:'0'.repeat(64)}})]){
  const rows=withArguments(f,args);mutate(rows);assert.notEqual(proveCodexAction(rows,f.request,[launcher]).status,'verified');
 }
 assert.notEqual(proveCodexAction(withArguments(f,args),f.request,['C:/other/labus.cmd']).status,'verified');
});
test('dynamic or ambiguous JavaScript arguments cannot borrow an exact successful receipt',()=>{
 const f=fixture(),cmd=JSON.stringify(f.command);
 const invalid=[
  '{cmd: command}', '{cmd: '+cmd+' + ""}', '{cmd: (()=>'+cmd+')()}',
  '{["cmd"]: '+cmd+'}', '{get cmd(){return '+cmd+'}}', '{...options,cmd: '+cmd+'}',
  '{cmd: '+cmd+', cmd: '+cmd+'}', '{cmd: '+cmd+', "cmd": '+cmd+'}',
  '{cmd: '+cmd+', justification: sideEffect()}', '{cmd: '+cmd+', unknown: true}',
  '{cmd: '+cmd+', /* ignored */ tty: false}', '{cmd: '+cmd+', tty: undefined}',
  '{cmd: '+cmd+', max_output_tokens: Infinity}', '{cmd: '+cmd+', max_output_tokens: 1e999}',
  '{cmd: '+cmd+', max_output_tokens: 0x10}', '{cmd: '+cmd+', justification: `text`}',
  '{cmd: '+cmd+', justification: "bad\\x20escape"}', '{cmd: '+cmd+', justification: "bad\\\nline"}',
  '{cmd: '+cmd+'}; other()', '{cmd: '+cmd+', __proto__: null}',
 ];
 for(const args of invalid)assert.notEqual(proveCodexAction(withArguments(f,args),f.request,[launcher]).status,'verified',args);
});
