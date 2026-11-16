import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ClaudeAdapter,resolveClaude} from '../../src/adapters/claude.ts';
import {createTask} from '../../src/model.ts';
import {clock,taskInput,temp} from '../helpers.ts';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const binding={agentId:'claude',kind:'claude' as const,sessionId:randomUUID(),workspaceRoot:'C:/project'};
test('resolve_by_session_not_pid; offline_keeps_target_id; write_without_delivery_evidence_is_unknown',async()=>{
  let resolved='';const m=createTask({...taskInput(),targetSessionId:binding.sessionId},clock());
  const a=new ClaudeAdapter({resolve:async id=>{resolved=id;return undefined;},post:async()=>{throw Error('must not post');}});
  assert.equal((await a.submit(binding,m)).status,'rejected');assert.equal(resolved,binding.sessionId);assert.equal(m.targetSessionId,binding.sessionId);
  const b=new ClaudeAdapter({resolve:async id=>({pid:1,sessionId:id,socketPath:'pipe',token:'secret'}),post:async()=>({status:'unknown'})});
  assert.equal((await b.submit(binding,m)).status,'unknown');
});
test('restarted_pid_same_session_resolves; multiple_matches_are_ambiguous; no token in probe',async t=>{
  const dir=await temp(t);await mkdir(path.join(dir,'sessions'));
  const save=async(pid:number)=>{await writeFile(path.join(dir,'sessions',pid+'.json'),JSON.stringify({pid,sessionId:binding.sessionId,messagingSocketPath:'pipe'}));await writeFile(path.join(dir,'sessions',pid+'.test.key'),JSON.stringify({peerToken:'secret'}));};
  await save(10);assert.equal((await resolveClaude(binding.sessionId,dir,()=>true))?.pid,10);
  await save(11);assert.equal((await resolveClaude(binding.sessionId,dir,p=>p===11))?.pid,11);
  await assert.rejects(resolveClaude(binding.sessionId,dir,()=>true),/ambiguous/);
  const a=new ClaudeAdapter({resolve:async()=>({pid:11,sessionId:binding.sessionId,socketPath:'pipe',token:'secret'}),post:async()=>({status:'unknown'})});
  assert.ok(!JSON.stringify(await a.probe(binding)).includes('secret'));
});
