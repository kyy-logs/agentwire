import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {previewConfiguration,applyConfiguration,rollbackConfiguration} from '../../src/installation/configuration.ts';
import {runLabus} from '../../src/labus.ts';

const foreign={hooks:[{type:'command',command:'echo unrelated',timeout:2}]};
async function fixture(t:any,missing=['UserPromptSubmit','Stop','StopFailure'],upgrade=false){
 const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'install'),sourceRoot:path.join(root,'source'),nodeExe:process.execPath};
 for(const provider of ['codex','claude']){const dir=path.join(c.sourceRoot,'assets/skills',provider,'labus');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'SKILL.md'),'---\nname: labus\ndescription: test\n---\n{{LAUNCHER}}');}
 const target=path.join(c.home,'.claude/settings.json');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify({permissions:{sentinel:true},hooks:{PreToolUse:[foreign],UserPromptSubmit:[foreign]}}));
 let value='C:\\original';const pathStore={get:async()=>value,set:async(v:string)=>{value=v;}};
 const first=await previewConfiguration(upgrade?{...c,nodeExe:c.nodeExe+'.previous'}:c,{pathStore});await applyConfiguration(c,first.operationId,{pathStore});
 if(upgrade){const upgrade=await previewConfiguration(c,{pathStore});await applyConfiguration(c,upgrade.operationId,{pathStore});}
 const installed=JSON.parse(await readFile(target,'utf8')),group=installed.hooks.Stop[0];
 for(const event of missing)installed.hooks[event]=installed.hooks[event].filter((g:any)=>JSON.stringify(g)===JSON.stringify(foreign));
 installed.beforeRepair='preserve';await writeFile(target,JSON.stringify(installed));
 const repair=await previewConfiguration(c,{pathStore});await applyConfiguration(c,repair.operationId,{pathStore});
 const config=JSON.parse(await readFile(target,'utf8'));config.afterRepair='preserve too';config.hooks.PreToolUse.push({hooks:[{type:'command',command:'echo later foreign'}]});await writeFile(target,JSON.stringify(config));
 const invoke=async()=>{let output='';const code=await runLabus(['uninstall','--apply'],{stdout:{write:s=>{output+=s;}},stderr:{write(){}}},{context:c,pathStore});return {code,result:JSON.parse(output)};};
 return {c,pathStore,target,first,repair,invoke,group};
}

// A regression here must break if rollback treats a predecessor's known,
// pre-repair omissions as a new external edit instead of consulting its proof.
for(const missing of [['UserPromptSubmit','Stop','StopFailure'],['Stop']])test('uninstall preserves foreign edits across verified pre-repair omissions: '+missing.join(','),async t=>{
 const f=await fixture(t,missing),r=await f.invoke();assert.equal(r.code,0,JSON.stringify(r.result));
 const final=JSON.parse(await readFile(f.target,'utf8'));assert.deepEqual(final.permissions,{sentinel:true});assert.equal(final.beforeRepair,'preserve');assert.equal(final.afterRepair,'preserve too');assert.deepEqual(final.hooks.UserPromptSubmit,[foreign]);assert.equal(final.hooks.Stop,undefined);assert.equal(final.hooks.StopFailure,undefined);assert.equal(final.hooks.PreToolUse.length,2);assert.equal(await f.pathStore.get(),'C:\\original');
 const owner=JSON.parse(await readFile(path.join(f.c.installRoot,'install/configuration-owner.json'),'utf8'));assert.deepEqual(owner.targets,{});
 assert.equal((await f.invoke()).code,0,'repeat uninstall is safe');
 const reinstall=await previewConfiguration(f.c,{pathStore:f.pathStore});await applyConfiguration(f.c,reinstall.operationId,{pathStore:f.pathStore});assert.equal((await f.invoke()).code,0,'clean reinstallation still uninstalls');
});

test('uninstall resumes an already rolled-back repair without requiring new ownership metadata',async t=>{
 const f=await fixture(t);await rollbackConfiguration(f.c,f.repair.operationId,{pathStore:f.pathStore});
 const restored=JSON.parse(await readFile(f.target,'utf8'));assert.equal(restored.hooks.Stop,undefined);restored.anotherForeignEdit=true;await writeFile(f.target,JSON.stringify(restored));
 const r=await f.invoke();assert.equal(r.code,0,JSON.stringify(r.result));assert.equal(JSON.parse(await readFile(f.target,'utf8')).anotherForeignEdit,true);
});

test('uninstall unwinds three generations when repair omissions cover a launcher upgrade',async t=>{
 const f=await fixture(t,undefined,true),r=await f.invoke();assert.equal(r.code,0,JSON.stringify(r.result));
 const final=JSON.parse(await readFile(f.target,'utf8'));assert.deepEqual(final.hooks.UserPromptSubmit,[foreign]);assert.equal(final.hooks.Stop,undefined);assert.equal(final.hooks.StopFailure,undefined);assert.equal(final.afterRepair,'preserve too');
});

test('a missing Hook without a rolled-back repair proof still blocks rollback',async t=>{
 const f=await fixture(t);const opFile=path.join(f.c.installRoot,'install/configuration',f.repair.operationId,'operation.json');const repair=JSON.parse(await readFile(opFile,'utf8'));
 // Repair exists but has not been rolled back: it cannot authorize omissions.
 const config=JSON.parse(await readFile(f.target,'utf8'));delete config.hooks.Stop;await writeFile(f.target,JSON.stringify(config));const before=await readFile(f.target);
 await assert.rejects(rollbackConfiguration(f.c,f.repair.operationId,{pathStore:f.pathStore}),/hook_changed_requires_review/);assert.deepEqual(await readFile(f.target),before);assert.equal(repair.status,'applied');
});

test('verified old omission never permits a modified same-command Hook',async t=>{
 const f=await fixture(t);await rollbackConfiguration(f.c,f.repair.operationId,{pathStore:f.pathStore});
 const config=JSON.parse(await readFile(f.target,'utf8')),changed=structuredClone(f.group);changed.hooks[0].timeout=99;config.hooks.Stop=[changed];await writeFile(f.target,JSON.stringify(config));const before=await readFile(f.target);
 await assert.rejects(rollbackConfiguration(f.c,f.first.operationId,{pathStore:f.pathStore}),/hook_changed_requires_review/);assert.deepEqual(await readFile(f.target),before);
});

test('tampered omission snapshot cannot authorize a missing predecessor Hook',async t=>{
 const f=await fixture(t);await rollbackConfiguration(f.c,f.repair.operationId,{pathStore:f.pathStore});
 const op=JSON.parse(await readFile(path.join(f.c.installRoot,'install/configuration',f.repair.operationId,'operation.json'),'utf8'));const entry=op.entries.find((e:any)=>e.target===f.target);await writeFile(entry.originalFile,'{}');const before=await readFile(f.target);
 await assert.rejects(rollbackConfiguration(f.c,f.first.operationId,{pathStore:f.pathStore}),/backup_mismatch/);assert.deepEqual(await readFile(f.target),before);
});

test('duplicate owned Hooks still block rollback despite a verified omitted event',async t=>{
 const f=await fixture(t);await rollbackConfiguration(f.c,f.repair.operationId,{pathStore:f.pathStore});const config=JSON.parse(await readFile(f.target,'utf8'));config.hooks.Stop=[f.group,f.group];await writeFile(f.target,JSON.stringify(config));
 await assert.rejects(rollbackConfiguration(f.c,f.first.operationId,{pathStore:f.pathStore}),/hook_changed_requires_review/);
});

test('historical uninstall does not roll back a file whose ownership was already released',async t=>{
 const f=await fixture(t),ownerFile=path.join(f.c.installRoot,'install/configuration-owner.json');
 await rollbackConfiguration(f.c,f.repair.operationId,{pathStore:f.pathStore});
 const target=path.join(f.c.home,'.agents/skills/labus/SKILL.md'),owner=JSON.parse(await readFile(ownerFile,'utf8'));delete owner.targets[target];await writeFile(ownerFile,JSON.stringify(owner));await writeFile(target,'restored original foreign Skill');
 const r=await f.invoke();assert.equal(r.code,0,JSON.stringify(r.result));assert.equal(await readFile(target,'utf8'),'restored original foreign Skill');
});

test('an interrupted unrelated preview without a journal does not block verified omission recovery',async t=>{
 const f=await fixture(t);const orphan=path.join(f.c.installRoot,'install/configuration',randomUUID());
 await mkdir(orphan,{recursive:true});await writeFile(path.join(orphan,'0.after'),'incomplete preview');
 const r=await f.invoke();assert.equal(r.code,0,JSON.stringify(r.result));
 assert.deepEqual(JSON.parse(await readFile(path.join(f.c.installRoot,'install/configuration-owner.json'),'utf8')).targets,{});
 assert.equal(await readFile(path.join(orphan,'0.after'),'utf8'),'incomplete preview');
});
