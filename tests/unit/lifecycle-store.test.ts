import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {temp} from '../helpers.ts';
test('same_event_is_idempotent; same_key_different_payload_conflicts; inbox_replayed_after_bus_restart',async t=>{
  const {FileLifecycleStore}=await import('../../src/lifecycle/store.ts');const {normalizeHook}=await import('../../src/lifecycle/normalize.ts');
  const root=await temp(t),store=new FileLifecycleStore(root),e=normalizeHook('claude',{session_id:randomUUID(),prompt_id:randomUUID(),hook_event_name:'Stop',last_assistant_message:'original'})!;
  await store.enqueue(e);const restarted=new FileLifecycleStore(root);assert.equal((await restarted.readInbox()).length,1);
  assert.equal((await restarted.putEvent(e)).duplicate,false);assert.equal((await restarted.putEvent({...e,observedAt:new Date(0).toISOString()})).duplicate,true);
  await assert.rejects(restarted.putEvent({...e,output:'different'}),/lifecycle_event_conflict/);
  assert.equal((await restarted.getEvent(e.eventKey))!.output,'original');
});
test('bad_id_cannot_escape_root; partial_tmp_is_not_event; rename_failure_retains_unconfirmed',async t=>{
  const {FileLifecycleStore}=await import('../../src/lifecycle/store.ts');const {normalizeHook}=await import('../../src/lifecycle/normalize.ts');
  const root=await temp(t),store=new FileLifecycleStore(root),e=normalizeHook('codex',{session_id:randomUUID(),turn_id:randomUUID(),hook_event_name:'Stop',last_assistant_message:'ok'})!;
  await assert.rejects(store.getEvent('../escape'),/invalid/);await assert.rejects(store.putEvent({...e,nativeExecutionId:'../../escape'}),/invalid/);
  await store.enqueue(e);await writeFile(path.join(root,'lifecycle','inbox','partial.tmp'),'{broken');assert.equal((await store.readInbox()).length,1);
  const failing=new FileLifecycleStore(root,{beforeRename:async()=>{throw new Error('injected_commit_failure');}});
  await assert.rejects(failing.putEvent(e),/injected_commit_failure/);assert.equal(await store.getEvent(e.eventKey),undefined);assert.equal((await store.readInbox()).length,1);
  assert.ok((await readdir(path.join(root,'lifecycle','inbox'))).includes('partial.tmp'));
});
