import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import {temp} from '../helpers.ts';
import {previewConfiguration,applyConfiguration,rollbackConfiguration,configurationRollbackOrder} from '../../src/installation/configuration.ts';
import {hash} from '../../src/installation/paths.ts';

async function legacyHooks(t:any,claudeOnly=false){
 const f=await fixture(t),p=await previewConfiguration(f.c,{pathStore:f.pathStore}),file=path.join(f.c.installRoot,'install','configuration',p.operationId,'operation.json'),op=JSON.parse(await readFile(file,'utf8'));
 for(const entry of op.entries.filter((e:any)=>e.kind==='hook')){
  const config=JSON.parse(await readFile(entry.stagedFile,'utf8'));for(const groups of Object.values(config.hooks) as any[])for(const group of groups)for(const h of group.hooks||[])h.timeout=5;
  const bytes=Buffer.from(JSON.stringify(config,null,2)+'\n');await writeFile(entry.stagedFile,bytes);entry.after=hash(bytes);for(const groups of Object.values(entry.groups) as any[])for(const group of groups)for(const h of group.hooks)h.timeout=5;
  op.changes.find((x:any)=>x.target===entry.target).afterSha256=entry.after;
 }
 if(claudeOnly){const target=path.join(f.c.home,'.claude','settings.json');op.entries=op.entries.filter((e:any)=>e.target===target);op.changes=op.changes.filter((e:any)=>e.target===target);}
 await writeFile(file,JSON.stringify(op));await applyConfiguration(f.c,p.operationId,{pathStore:f.pathStore});return f;
}

test('Claude prompt Hook gets startup headroom without changing other events or permissions',async t=>{
 const f=await fixture(t),p=await previewConfiguration(f.c,{pathStore:f.pathStore});await applyConfiguration(f.c,p.operationId,{pathStore:f.pathStore});
 const config=JSON.parse(await readFile(path.join(f.c.home,'.claude','settings.json'),'utf8')),codex=JSON.parse(await readFile(path.join(f.c.home,'.codex','hooks.json'),'utf8'));
 assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].timeout,15);assert.equal(config.hooks.Stop[0].hooks[0].timeout,5);assert.equal(codex.hooks.UserPromptSubmit[0].hooks[0].timeout,5);assert.deepEqual(config.permissions,{test:true});
});

test('owned five-second Hook upgrades in place, preserves unrelated Hooks, and rolls back after unrelated edits',async t=>{
 const f=await legacyHooks(t),file=path.join(f.c.home,'.claude','settings.json'),before=JSON.parse(await readFile(file,'utf8')),foreign={hooks:[{type:'command',command:'echo unrelated',timeout:2}]};before.hooks.UserPromptSubmit.unshift(foreign);await writeFile(file,JSON.stringify(before));
 const plan=await previewConfiguration(f.c,{pathStore:f.pathStore});await applyConfiguration(f.c,plan.operationId,{pathStore:f.pathStore});const actual=JSON.parse(await readFile(file,'utf8'));
 assert.equal(actual.hooks.UserPromptSubmit.length,2,'replace the owned definition, never run both');assert.deepEqual(actual.hooks.UserPromptSubmit[0],foreign);assert.equal(actual.hooks.UserPromptSubmit[1].hooks[0].timeout,15);assert.deepEqual(actual.permissions,before.permissions);assert.equal((await previewConfiguration(f.c,{pathStore:f.pathStore})).changes.length,0);
 actual.extra='later edit';await writeFile(file,JSON.stringify(actual));await rollbackConfiguration(f.c,plan.operationId,{pathStore:f.pathStore});const restored=JSON.parse(await readFile(file,'utf8'));assert.equal(restored.extra,'later edit');assert.deepEqual(restored.hooks,before.hooks);assert.deepEqual(restored.permissions,before.permissions);
 const again=await previewConfiguration(f.c,{pathStore:f.pathStore});await applyConfiguration(f.c,again.operationId,{pathStore:f.pathStore});const upgraded=JSON.parse(await readFile(file,'utf8'));assert.equal(upgraded.hooks.UserPromptSubmit.length,2);assert.equal(upgraded.hooks.UserPromptSubmit[1].hooks[0].timeout,15);assert.equal(upgraded.extra,'later edit');
 const {runLabus}=await import('../../src/labus.ts');let result='';assert.equal(await runLabus(['uninstall','--apply'],{stdout:{write:s=>{result+=s;}},stderr:{write:()=>{}}},{context:f.c,pathStore:f.pathStore}),0,result);const removed=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(removed.hooks.UserPromptSubmit,[foreign],'uninstall removes all owned versions, retaining the unrelated Hook');assert.equal(removed.extra,'later edit');
});

test('externally edited owned Hook cannot be silently replaced or duplicated',async t=>{
 const f=await legacyHooks(t),file=path.join(f.c.home,'.claude','settings.json'),config=JSON.parse(await readFile(file,'utf8'));config.hooks.UserPromptSubmit[0].hooks[0].timeout=9;await writeFile(file,JSON.stringify(config));const before=await readFile(file);
 await assert.rejects(previewConfiguration(f.c,{pathStore:f.pathStore}),/hook_changed_requires_review/);assert.deepEqual(await readFile(file),before);
});

test('additional same-command variants block upgrade even when an exact old or desired Hook exists',async t=>{
 for(const variant of ['old','desired']){const f=await legacyHooks(t);if(variant==='desired'){const p=await previewConfiguration(f.c,{pathStore:f.pathStore});await applyConfiguration(f.c,p.operationId,{pathStore:f.pathStore});}
  const file=path.join(f.c.home,'.claude','settings.json'),config=JSON.parse(await readFile(file,'utf8')),extra=structuredClone(config.hooks.UserPromptSubmit[0]);extra.hooks[0].timeout=9;config.hooks.UserPromptSubmit.push(extra);await writeFile(file,JSON.stringify(config));const before=await readFile(file);
  await assert.rejects(previewConfiguration(f.c,{pathStore:f.pathStore}),/hook_changed_requires_review/);assert.deepEqual(await readFile(file),before);
 }
});

test('uninstall follows an upgrade predecessor even after its last owned target is superseded',async t=>{
 const f=await legacyHooks(t,true),plan=await previewConfiguration(f.c,{pathStore:f.pathStore});await applyConfiguration(f.c,plan.operationId,{pathStore:f.pathStore});const {runLabus}=await import('../../src/labus.ts');let result='';
 assert.equal(await runLabus(['uninstall','--apply'],{stdout:{write:s=>{result+=s;}},stderr:{write:()=>{}}},{context:f.c,pathStore:f.pathStore}),0,result);
 const settings=JSON.parse(await readFile(path.join(f.c.home,'.claude','settings.json'),'utf8'));assert.equal(settings.hooks.UserPromptSubmit,undefined);assert.deepEqual(settings.permissions,{test:true});
});

for(const partial of ['apply','rollback'])test('uninstall recovers an interrupted Hook upgrade '+partial+' without a false ownership cycle',async t=>{
 const f=await legacyHooks(t);for(const provider of ['codex','claude'])await writeFile(path.join(f.c.sourceRoot,'assets','skills',provider,'labus','SKILL.md'),'---\nname: labus\ndescription: updated\n---\n{{LAUNCHER}}');
 const plan=await previewConfiguration(f.c,{pathStore:f.pathStore});
 if(partial==='apply')await assert.rejects(applyConfiguration(f.c,plan.operationId,{pathStore:f.pathStore,afterWrite:async()=>{throw Error('fixture_interrupted');}}),/fixture_interrupted/);
 else{await applyConfiguration(f.c,plan.operationId,{pathStore:f.pathStore});const opFile=path.join(f.c.installRoot,'install','configuration',plan.operationId,'operation.json'),op=JSON.parse(await readFile(opFile,'utf8')),entry=op.entries[0],ownerFile=path.join(f.c.installRoot,'install','configuration-owner.json'),owner=JSON.parse(await readFile(ownerFile,'utf8'));await writeFile(entry.target,await readFile(entry.originalFile));owner.targets[entry.target]=op.previousOwners[entry.target];op.rolledBackTargets.push(entry.target);await writeFile(ownerFile,JSON.stringify(owner));await writeFile(opFile,JSON.stringify(op));}
 assert.equal((await configurationRollbackOrder(f.c))[0],plan.operationId);
 const {runLabus}=await import('../../src/labus.ts');let result='';assert.equal(await runLabus(['uninstall','--apply'],{stdout:{write:s=>{result+=s;}},stderr:{write:()=>{}}},{context:f.c,pathStore:f.pathStore}),0,result);
 const settings=JSON.parse(await readFile(path.join(f.c.home,'.claude','settings.json'),'utf8'));assert.equal(settings.hooks.UserPromptSubmit,undefined);assert.deepEqual(settings.permissions,{test:true});
});
test('PATH write committed before timeout finishes install ownership and uninstall restores original',async t=>{
 const {c,pathStore}=await fixture(t);const original=await pathStore.get(),set=pathStore.set;
 pathStore.set=async value=>{await set(value);throw Object.assign(Error('setter timed out after committing'),{code:null,signal:'SIGTERM',killed:true});};
 const plan=await previewConfiguration(c,{pathStore});await applyConfiguration(c,plan.operationId,{pathStore});
 const owner=JSON.parse(await readFile(path.join(c.installRoot,'install','configuration-owner.json'),'utf8'));
 assert.equal(owner.targets['user:PATH'].operationId,plan.operationId);
 assert.equal(JSON.parse(await readFile(path.join(c.installRoot,'install','configuration',plan.operationId,'operation.json'),'utf8')).status,'applied');
 await rollbackConfiguration(c,plan.operationId,{pathStore});assert.equal(await pathStore.get(),original);
 assert.equal(JSON.parse(await readFile(path.join(c.installRoot,'install','configuration',plan.operationId,'operation.json'),'utf8')).status,'rolled_back');
});
test('PATH setter timeout without a committed value remains a failure and cannot claim ownership',async t=>{
 const {c,pathStore}=await fixture(t),error=Error('setter did not write'),original=await pathStore.get();pathStore.set=async()=>{throw error;};
 const plan=await previewConfiguration(c,{pathStore});await assert.rejects(applyConfiguration(c,plan.operationId,{pathStore}),e=>e===error);
 assert.equal(await pathStore.get(),original);const owner=JSON.parse(await readFile(path.join(c.installRoot,'install','configuration-owner.json'),'utf8'));assert.equal(owner.targets['user:PATH'],undefined);
});
test('PATH write cannot be confirmed when another value is observed after a timeout',async t=>{
 const {c,pathStore}=await fixture(t),set=pathStore.set,error=Error('setter result uncertain');pathStore.set=async()=>{await set('C:\\other-writer');throw error;};
 const plan=await previewConfiguration(c,{pathStore});await assert.rejects(applyConfiguration(c,plan.operationId,{pathStore}),e=>e===error);assert.equal(await pathStore.get(),'C:\\other-writer');
 const owner=JSON.parse(await readFile(path.join(c.installRoot,'install','configuration-owner.json'),'utf8'));assert.equal(owner.targets['user:PATH'],undefined);
});
test('PATH setter success without the desired persisted value must not complete installation',async t=>{
 const {c,pathStore}=await fixture(t);pathStore.set=async()=>{};const plan=await previewConfiguration(c,{pathStore});
 await assert.rejects(applyConfiguration(c,plan.operationId,{pathStore}),/path_write_unconfirmed/);
 const owner=JSON.parse(await readFile(path.join(c.installRoot,'install','configuration-owner.json'),'utf8'));assert.equal(owner.targets['user:PATH'],undefined);
});
async function fixture(t:any){const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'产品'),sourceRoot:path.join(root,'source'),nodeExe:process.execPath};for(const p of ['codex','claude']){const d=path.join(c.sourceRoot,'assets','skills',p,'labus');await mkdir(d,{recursive:true});await writeFile(path.join(d,'SKILL.md'),'---\nname: labus\ndescription: test\n---\n{{LAUNCHER}}');}await mkdir(path.join(c.home,'.claude'),{recursive:true});const original='{"permissions":{"test":true},"hooks":{"PreToolUse":[]}}\n';await writeFile(path.join(c.home,'.claude','settings.json'),original);let value='C:\\existing';const pathStore={get:async()=>value,set:async(v:string)=>{value=v;}};return {c,original,pathStore};}
test('preserves_original_hooks_permissions; preview does not change configs; second_apply does not duplicate',async t=>{const {c,original,pathStore}=await fixture(t);const p=await previewConfiguration(c,{pathStore});assert.equal(await readFile(path.join(c.home,'.claude','settings.json'),'utf8'),original);await applyConfiguration(c,p.operationId,{pathStore});const saved=JSON.parse(await readFile(path.join(c.home,'.claude','settings.json'),'utf8'));assert.deepEqual(saved.permissions,{test:true});assert.equal(saved.hooks.Stop.length,1);await applyConfiguration(c,p.operationId,{pathStore});assert.equal((await previewConfiguration(c,{pathStore})).changes.length,0);});
test('concurrent_edit_rejected_before_apply; skill_name_conflict_preserved',async t=>{const {c,pathStore}=await fixture(t);const p=await previewConfiguration(c,{pathStore});await writeFile(path.join(c.home,'.claude','settings.json'),'{}');await assert.rejects(applyConfiguration(c,p.operationId,{pathStore}),/configuration_changed/);const d=path.join(c.home,'.agents','skills','labus');await mkdir(d,{recursive:true});await writeFile(path.join(d,'SKILL.md'),'foreign');await assert.rejects(previewConfiguration(c,{pathStore}),/skill_name_conflict/);});
test('rollback_restores_original_bytes_when_unchanged; preserves unrelated new edits and PATH',async t=>{const {c,original,pathStore}=await fixture(t);const p=await previewConfiguration(c,{pathStore});await applyConfiguration(c,p.operationId,{pathStore});const cf=path.join(c.home,'.claude','settings.json');const edited=JSON.parse(await readFile(cf,'utf8'));edited.extra='new';await writeFile(cf,JSON.stringify(edited));await pathStore.set((await pathStore.get())+';C:\\new');await rollbackConfiguration(c,p.operationId,{pathStore});const restored=JSON.parse(await readFile(cf,'utf8'));assert.equal(restored.extra,'new');assert.deepEqual(restored.permissions,{test:true});assert.equal(restored.hooks.Stop,undefined);assert.equal(await pathStore.get(),'C:\\existing;C:\\new');const before=await readFile(cf);const next=await previewConfiguration(c,{pathStore});await applyConfiguration(c,next.operationId,{pathStore});await rollbackConfiguration(c,next.operationId,{pathStore});assert.deepEqual(await readFile(cf),before);});
test('partial_apply_resumes; modified owned group blocks rollback',async t=>{const {c,pathStore}=await fixture(t);const p=await previewConfiguration(c,{pathStore});let called=false;await assert.rejects(applyConfiguration(c,p.operationId,{pathStore,afterWrite:async()=>{if(!called){called=true;throw Error('injected');}}}),/injected/);await applyConfiguration(c,p.operationId,{pathStore});const file=path.join(c.home,'.codex','hooks.json');const edited=JSON.parse(await readFile(file,'utf8'));edited.hooks.Stop[0].hooks[0].command='changed';await writeFile(file,JSON.stringify(edited));await assert.rejects(rollbackConfiguration(c,p.operationId,{pathStore}),/hook_changed_requires_review/);});

test('generated Codex Hook executes through Windows PowerShell and cmd with Chinese paths', {skip:process.platform!=='win32'}, async t=>{const {spawnSync}=await import('node:child_process');const {c,pathStore}=await fixture(t);const router=path.join(c.installRoot,'runtime','src','installation','hook-router.ts');await mkdir(path.dirname(router),{recursive:true});await writeFile(router,"let text='';for await(const b of process.stdin)text+=b;process.stdout.write(JSON.stringify({executed:true,input:JSON.parse(text)}));");const plan=await previewConfiguration(c,{pathStore});await applyConfiguration(c,plan.operationId,{pathStore});const config=JSON.parse(await readFile(path.join(c.home,'.codex','hooks.json'),'utf8'));const hook=config.hooks.UserPromptSubmit[0].hooks[0],command=hook.commandWindows||hook.command;for(const [shell,args] of [['powershell.exe',['-NoProfile','-NonInteractive','-Command',command]],['cmd.exe',['/d','/s','/c',command]]] as const){const r=spawnSync(shell,args as unknown as string[],{encoding:'utf8',windowsHide:true,input:'{"marker":"test"}'});assert.equal(r.status,0,shell+': '+r.stderr);assert.deepEqual(JSON.parse(r.stdout),{executed:true,input:{marker:'test'}});}});

test('uninstall rolls newest owning operation before an older overlapping operation then reinstalls',async t=>{const {runLabus}=await import('../../src/labus.ts');const {c,pathStore}=await fixture(t);await mkdir(path.join(c.home,'.codex'),{recursive:true});await writeFile(path.join(c.home,'.codex','hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[],Stop:[],Interrupt:[]}},null,2)+'\n');const first=await previewConfiguration({...c,nodeExe:c.nodeExe+'.old'},{pathStore});await applyConfiguration(c,first.operationId,{pathStore});const target=path.join(c.home,'.codex','hooks.json');const config=JSON.parse(await readFile(target,'utf8'));for(const event of ['UserPromptSubmit','Stop','Interrupt'])config.hooks[event]=[];await writeFile(target,JSON.stringify(config,null,2)+'\n');const second=await previewConfiguration(c,{pathStore});assert.equal(second.changes.length,2);await applyConfiguration(c,second.operationId,{pathStore});let output='';const io={stdout:{write:(s:string)=>{output+=s;}},stderr:{write:()=>{}}};assert.equal(await runLabus(['uninstall','--apply'],io,{context:c,pathStore}),0,output);const after=JSON.parse(await readFile(target,'utf8'));assert.ok(Object.values(after.hooks||{}).every((x:any)=>x.length===0));assert.deepEqual(JSON.parse(await readFile(path.join(c.home,'.claude','settings.json'),'utf8')).permissions,{test:true});assert.equal(await pathStore.get(),'C:\\existing');const third=await previewConfiguration(c,{pathStore});await applyConfiguration(c,third.operationId,{pathStore});assert.equal(JSON.parse(await readFile(target,'utf8')).hooks.Stop.length,1);});
