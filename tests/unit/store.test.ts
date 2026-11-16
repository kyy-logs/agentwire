import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileMessageStore } from '../../src/store.ts';
import { createTask } from '../../src/model.ts';
import { temp, clock } from '../helpers.ts';

const message=(c:any)=>createTask({messageId:randomUUID(),from:'codex',to:'claude',targetSessionId:randomUUID(),body:'hello'},c);
test('disk_path_write_failure_never_acknowledges_commit; orphan temps are only reported',async t=>{
  const c=clock(),dir=await temp(t);await writeFile(path.join(dir,'messages'),'blocked');const broken=new FileMessageStore(dir,c);await assert.rejects(broken.putNew(message(c)));
  const other=await temp(t);await mkdir(path.join(other,'messages'));await writeFile(path.join(other,'messages','orphan.tmp'),'uncommitted');const store=new FileMessageStore(other,c),report=await store.recover(c.now());assert.equal(report.orphanTemporaryFiles?.length,1);assert.equal((await store.list()).length,0);
});
test('same_id_same_payload_is_duplicate; conflict preserves original',async t=>{
  const c=clock(),s=new FileMessageStore(await temp(t),c),m=message(c);
  assert.equal((await s.putNew(m)).duplicate,false);
  assert.equal((await s.putNew(m)).duplicate,true);
  await assert.rejects(s.putNew({...m,body:'changed'}),/conflict/);
  assert.equal((await s.list()).length,1);
  assert.equal((await s.get(m.messageId))?.message.body,'hello');
});
test('ack_requires_committed_record; rename_failure_preserves_previous_record',async t=>{
  let fail=false;const c=clock(),dir=await temp(t);
  const s=new FileMessageStore(dir,c,{beforeRename:async()=>{if(fail)throw new Error('disk fault');}}),m=message(c);
  const {record}=await s.putNew(m);fail=true;
  await assert.rejects(s.replace({...record,state:'submitted'}),/disk fault/);
  assert.equal((await s.get(m.messageId))?.state,'pending');
  const other=message(c);await assert.rejects(s.putNew(other),/disk fault/);
  assert.equal(await s.get(other.messageId),undefined);
});
test('restart_submitting_needs_check; submitted is not reset; deadline is preserved',async t=>{
  const c=clock(),dir=await temp(t),s=new FileMessageStore(dir,c);
  const a=(await s.putNew(message(c))).record,b=(await s.putNew(message(c))).record;
  await s.replace({...a,state:'submitting'});
  await s.replace({...b,state:'submitted',resultDeadlineAt:'2026-11-15T14:10:00.000Z'});
  const next=new FileMessageStore(dir,c),report=await next.recover(c.now());
  assert.deepEqual(report.needsCheckIds,[a.message.messageId]);
  assert.equal((await next.get(a.message.messageId))?.state,'needs_check');
  assert.equal((await next.get(b.message.messageId))?.state,'submitted');
  assert.equal((await next.get(b.message.messageId))?.resultDeadlineAt,'2026-11-15T14:10:00.000Z');
});
test('reply_saved_parent_projection_repaired',async t=>{
  const c=clock(),s=new FileMessageStore(await temp(t),c),m=message(c);
  const parent=(await s.putNew(m)).record;await s.replace({...parent,state:'submitted'});
  const reply={...m,messageId:randomUUID(),kind:'reply' as const,replyTo:m.messageId,from:m.to,to:m.from,body:'done'};
  await s.putNew(reply);
  const report=await s.recover(c.now());
  assert.ok(report.repairedTaskIds.includes(m.messageId));
  assert.equal((await s.get(m.messageId))?.state,'completed');
  assert.equal((await s.get(m.messageId))?.resultRef,reply.messageId);
});
test('corrupt_json_is_visible; invalid IDs cannot escape storage',async t=>{
  const c=clock(),dir=await temp(t),s=new FileMessageStore(dir,c),id=randomUUID();
  await mkdir(path.join(dir,'messages'),{recursive:true});await writeFile(path.join(dir,'messages',id+'.json'),'{broken');
  const report=await s.recover(c.now());assert.equal(report.quarantinedFiles.length,1);
  assert.equal(await readFile(report.quarantinedFiles[0],'utf8'),'{broken');
  await assert.rejects(s.get('../bindings'),/invalid.*id/i);
});
