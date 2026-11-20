import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {temp} from '../helpers.ts';
import {startIpc} from '../../src/ipc.ts';
const entry=fileURLToPath(new URL('../../src/installation/hook-router.ts',import.meta.url));
async function fixture(t:any,provider='codex'){
 const root=await temp(t),sessionId=randomUUID(),connectionId=randomUUID(),executionId=randomUUID();
 const state=path.join(root,'connections',connectionId,'state');
 await writeFile(path.join(root,'routes.json'),JSON.stringify({schemaVersion:1,routes:[{provider,sessionId,connectionId}]}));
 const event={session_id:sessionId,...(provider==='codex'?{turn_id:executionId}:{prompt_id:executionId}),hook_event_name:'UserPromptSubmit',prompt:'PRIVATE_BODY_NEVER_IN_TIMING',token:'PRIVATE_TOKEN_NEVER_IN_TIMING'};
 const enable=(extra={})=>writeFile(path.join(root,'hook-timing.json'),JSON.stringify({schemaVersion:1,provider,sessionId,expiresAt:new Date(Date.now()+60000).toISOString(),...extra}));
 const run=(input:any=event)=>new Promise<any>((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-strip-types',entry,'--root',root,'--provider',provider],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',reject);p.once('close',code=>resolve({code,stdout,stderr}));p.stdin.end(JSON.stringify(input));});
 const rows=async()=> (await readFile(path.join(root,'hook-timing.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 return {root,state,sessionId,executionId,event,enable,run,rows};
}
function assertTrace(row:any,provider:string,sessionId:string,executionId:string){
 assert.deepEqual(Object.keys(row).sort(),['at','event','nativeExecutionId','nodeUptimeAtRouterReadyMs','provider','schemaVersion','sessionId','stagesMs'].sort());
 assert.equal(row.provider,provider);assert.equal(row.sessionId,sessionId);assert.equal(row.nativeExecutionId,executionId);
 const stages=['router_ready','stdin_ready','timing_ready','lifecycle_import_started','lifecycle_import_ready','route_ready','normalized','capture_persisted','wake_started','wake_finished','router_finished'];
 for(const s of stages)assert.ok(Number.isFinite(row.stagesMs[s]),'missing '+s);
 for(let i=1;i<stages.length;i++)assert.ok(row.stagesMs[stages[i]]>=row.stagesMs[stages[i-1]],'nonmonotonic '+stages[i]);
 assert.ok(row.nodeUptimeAtRouterReadyMs>=0);
}
test('opt-in timing measures real router stages without collecting prompt or unknown fields',async t=>{
 const s=await fixture(t);await s.enable({body:'FLAG_SECRET',destination:'DO_NOT_USE'});assert.deepEqual(await s.run(),{code:0,stdout:'',stderr:''});
 const rows=await s.rows();assert.equal(rows.length,1);assertTrace(rows[0],'codex',s.sessionId,s.executionId);assert.equal(rows[0].event,'UserPromptSubmit');
 const text=JSON.stringify(rows);for(const secret of ['PRIVATE_BODY_NEVER_IN_TIMING','PRIVATE_TOKEN_NEVER_IN_TIMING','FLAG_SECRET','DO_NOT_USE',s.root])assert.ok(!text.includes(secret));
 assert.equal((await readdir(path.join(s.state,'lifecycle','inbox'))).length,1);
});
test('Claude terminal timing preserves durable clean hint and drops unregistered private output',async t=>{
 const s=await fixture(t,'claude');await s.enable();assert.deepEqual(await s.run({...s.event,hook_event_name:'Stop',last_assistant_message:'PRIVATE_OUTPUT_NEVER_COLLECT'}),{code:0,stdout:'',stderr:''});
 const [row]=await s.rows();assertTrace(row,'claude',s.sessionId,s.executionId);assert.equal(row.event,'Stop');
 assert.equal((await readdir(path.join(s.state,'lifecycle','clean-hints'))).length,1);
 const inbox=path.join(s.state,'lifecycle','inbox');for(const f of await readdir(inbox))assert.ok(!(await readFile(path.join(inbox,f),'utf8')).includes('PRIVATE_OUTPUT_NEVER_COLLECT'));
});
test('wake timing includes delayed authenticated ACK after lifecycle persistence',async t=>{
 const s=await fixture(t);await s.enable();let observed=false;
 const server=await startIpc(s.state,async request=>{assert.equal(request.op,'wake');assert.equal((await readdir(path.join(s.state,'lifecycle','inbox'))).length,1);observed=true;await new Promise(r=>setTimeout(r,45));return {requestId:request.requestId,ok:true};});t.after(()=>server.close());
 assert.deepEqual(await s.run(),{code:0,stdout:'',stderr:''});const [row]=await s.rows();assert.ok(observed);assert.ok(row.stagesMs.wake_finished-row.stagesMs.wake_started>=35);
});
test('absent expired malformed oversized or different-session timing opt-in never writes diagnostics',async t=>{
 for(const mode of ['absent','expired','malformed','oversized','other_session','too_long']){
  const s=await fixture(t);if(mode==='expired')await s.enable({expiresAt:new Date(Date.now()-1000).toISOString()});
  if(mode==='other_session')await s.enable({sessionId:randomUUID()});if(mode==='too_long')await s.enable({expiresAt:new Date(Date.now()+172800000).toISOString()});
  if(mode==='malformed')await writeFile(path.join(s.root,'hook-timing.json'),'{');if(mode==='oversized')await writeFile(path.join(s.root,'hook-timing.json'),'x'.repeat(8192));
  assert.deepEqual(await s.run(),{code:0,stdout:'',stderr:''});await assert.rejects(stat(path.join(s.root,'hook-timing.jsonl')),/ENOENT/);
  assert.equal((await readdir(path.join(s.state,'lifecycle','inbox'))).length,1);
 }
});
test('unwritable or capped timing output cannot fail lifecycle capture',async t=>{
 for(const mode of ['directory','full']){
  const s=await fixture(t);await s.enable();const file=path.join(s.root,'hook-timing.jsonl');
  if(mode==='directory')await mkdir(file);else await writeFile(file,Buffer.alloc(1024*1024,120));
  assert.deepEqual(await s.run(),{code:0,stdout:'',stderr:''});assert.equal((await readdir(path.join(s.state,'lifecycle','inbox'))).length,1);
  if(mode==='full')assert.equal((await stat(file)).size,1024*1024);
 }
});