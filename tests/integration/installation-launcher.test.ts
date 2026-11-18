import test from 'node:test';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import path from 'node:path';import {fileURLToPath} from 'node:url';import {temp} from '../helpers.ts';import {previewSetup,applySetup} from '../../src/installation/setup.ts';
import {readFile,stat} from 'node:fs/promises';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
test('actual cmd launcher handles UTF8 Chinese spaces without corrupting runtime path',async t=>{const root=await temp(t),home=path.join(root,'home'),local=path.join(root,'中文 空格');await mkdir(home);const c={home,installRoot:path.join(local,'LocalAgentBus'),sourceRoot:fileURLToPath(new URL('../../',import.meta.url)),nodeExe:process.execPath};const p=await previewSetup(c);await applySetup(c,p.operationId);const command='""'+path.join(c.installRoot,'bin','labus.cmd')+'" status"';const r=await promisify(execFile)('cmd.exe',['/d','/s','/c',command],{windowsHide:true,windowsVerbatimArguments:true,env:{...process.env,USERPROFILE:home,LOCALAPPDATA:local},timeout:10000});assert.equal(JSON.parse(r.stdout.trim()).phase,'disconnected');});

test('installed launcher consumes its own native ticket despite sandbox LOCALAPPDATA and an inherited foreign root',async t=>{
 for(const provider of ['codex','claude'] as const){
  const f=await pairingFixture(t);f.clock.value=Date.now();f.c.sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
  const source=f.peers.find(p=>p.provider===provider)!,ticket=await stageNativeCommand(f,source,'生成连接码');assert.ok(ticket);
  const plan=await previewSetup(f.c);await applySetup(f.c,plan.operationId);
  const decoy=path.join(f.root,'sandbox 未安装'),foreign=path.join(f.root,'foreign'),cwd=path.join(f.root,'另一个 工作目录');await mkdir(cwd);
  const command='""'+path.join(f.c.installRoot,'bin','labus.cmd')+'" pair issue --intent '+ticket+'"';
  const r=await promisify(execFile)('cmd.exe',['/d','/s','/c',command],{cwd,windowsHide:true,windowsVerbatimArguments:true,env:{...process.env,USERPROFILE:f.c.home,LOCALAPPDATA:decoy,AGENTWIRE_INSTALL_ROOT:foreign},timeout:10000});
  const result=JSON.parse(r.stdout.trim());assert.equal(result.ok,true);assert.equal(result.phase,'code_issued');assert.equal(result.data.issuer.sessionId,source.sessionId);assert.equal(result.data.issuer.workspaceRoot,source.workspaceRoot);
  const state=JSON.parse(await readFile(f.file,'utf8'));assert.ok(state.requests.find((r:any)=>r.requestId===ticket)?.intentId);assert.ok(state.invitations.some((i:any)=>i.code===result.data.code));
  await assert.rejects(()=>stat(decoy),{code:'ENOENT'});await assert.rejects(()=>stat(foreign),{code:'ENOENT'});
 }
});
