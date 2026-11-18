import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {temp} from '../helpers.ts';
import {hash} from '../../src/installation/paths.ts';
import {startMain} from '../../src/main.ts';

const api:any=await import('../../src/installation/doctor.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const guidance:any=await import('../../src/installation/guidance.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
async function fixture(t:any){const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath};return {root,c};}
const check=(report:any,id:string)=>{const row=report.checks.find((x:any)=>x.id===id);assert.ok(row,'check exists: '+id);return row;};

test('doctor missing installation stays read-only and reports independent failures and actual paths',async t=>{
 assert.equal(typeof api.diagnoseInstallation,'function');const f=await fixture(t),before=await readdir(f.root),r=await api.diagnoseInstallation(f.c,{env:{}});
 assert.equal(check(r,'install_root').status,'error');assert.equal(check(r,'codex_hook').status,'error');assert.equal(check(r,'claude_skill').status,'error');assert.equal(check(r,'write_access').status,'unverified');assert.equal(check(r,'native_trust').status,'unverified');
 assert.equal(r.paths.installRoot,f.c.installRoot);assert.equal(r.paths.nodeExe,process.execPath);assert.deepEqual(await readdir(f.root),before);
});

test('doctor verifies installed bytes rather than merely checking the runtime file exists',async t=>{
 assert.equal(typeof api.diagnoseInstallation,'function');const f=await fixture(t),file=path.join(f.c.installRoot,'runtime','src','labus.ts');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'installed');await mkdir(path.join(f.c.installRoot,'install'));await writeFile(path.join(f.c.installRoot,'install','manifest.json'),JSON.stringify({schemaVersion:1,files:{[file]:hash('installed')}}));
 assert.equal(check(await api.diagnoseInstallation(f.c,{env:{}}),'runtime_artifacts').status,'ok');await writeFile(file,'changed');assert.equal(check(await api.diagnoseInstallation(f.c,{env:{}}),'runtime_artifacts').code,'runtime_artifact_changed');
});

test('write probe is explicit, cleaned up, and denial points to native approval without altering permissions',async t=>{
 assert.equal(typeof api.diagnoseInstallation,'function');const f=await fixture(t);await mkdir(f.c.installRoot);const before=await readdir(f.c.installRoot);
 assert.equal(check(await api.diagnoseInstallation(f.c,{env:{},checkWrite:true}),'write_access').status,'ok');assert.deepEqual(await readdir(f.c.installRoot),before);
 const r=await api.diagnoseInstallation(f.c,{env:{},checkWrite:true,probeWrite:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}});assert.equal(check(r,'write_access').code,'storage_access_denied');assert.match(check(r,'write_access').nextAction,/native_execution_approval/);assert.deepEqual(await readdir(f.c.installRoot),before);
});

test('redirected environment exposes pinned-root mismatch and incomplete switch without revealing ticket contents',async t=>{
 assert.equal(typeof api.diagnoseInstallation,'function');const f=await fixture(t);await mkdir(f.c.installRoot);await writeFile(path.join(f.c.installRoot,'connection-transition.json'),JSON.stringify({secret:'do-not-print'}));
 const r=await api.diagnoseInstallation(f.c,{env:{AGENTWIRE_INSTALL_ROOT:path.join(f.root,'other'),LOCALAPPDATA:path.join(f.root,'sandbox')}});
 assert.equal(check(r,'install_root_pin').code,'install_root_mismatch');assert.equal(check(r,'connection_transition').code,'connection_switch_requires_check');assert.ok(!JSON.stringify(r).includes('do-not-print'));
});

test('doctor distinguishes saved identity from broken routes, missing bindings and absent Bus',async t=>{
 assert.equal(typeof api.diagnoseInstallation,'function');const f=await fixture(t),id=randomUUID(),candidate=(provider:string)=>({provider,sessionId:randomUUID(),workspaceRoot:f.root,availability:'candidate'}),r={schemaVersion:2,admissionMode:'identity-pair-v1',connectionId:id,phase:'paired',codex:candidate('codex'),claude:candidate('claude'),createdAt:new Date().toISOString(),pairing:{activationId:randomUUID(),identity:'confirmed'}};
 const dir=path.join(f.c.installRoot,'connections',id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'connection.json'),JSON.stringify(r));await writeFile(path.join(f.c.installRoot,'active-connection.json'),JSON.stringify({connectionId:id}));
 const report=await api.diagnoseInstallation(f.c,{env:{},connectionDeps:{discover:async()=>[]}});
 assert.equal(check(report,'connection_routes').code,'connection_routes_require_check');assert.equal(check(report,'connection_bindings').code,'connection_bindings_require_check');assert.equal(check(report,'bus_service').code,'bus_offline');assert.equal(check(report,'claude_endpoint').status,'warning');assert.equal(check(report,'codex_endpoint').status,'unverified');
});

test('operational errors have specific guidance while unknown errors stay conservative',()=>{
 assert.equal(typeof guidance.errorGuidance,'function');for(const code of ['pairing_identity_unconfirmed','pairing_activation_requires_check','active_connection_exists','connection_switch_requires_check','storage_access_denied']){const r=guidance.errorGuidance(code);assert.ok(r.summary);assert.ok(r.nextAction);}
 assert.match(guidance.errorGuidance('storage_access_denied').nextAction,/native_execution_approval/);assert.match(guidance.errorGuidance('unknown_new_code').nextAction,/doctor/);
});

test('doctor observes a real local test Bus without starting a vendor agent or creating missing message storage',async t=>{
 assert.equal(typeof api.diagnoseInstallation,'function');const f=await fixture(t),id=randomUUID(),candidate=(provider:string)=>({provider,sessionId:randomUUID(),workspaceRoot:f.root,availability:'candidate'}),r={schemaVersion:2,admissionMode:'identity-pair-v1',connectionId:id,phase:'paired',codex:candidate('codex'),claude:candidate('claude'),createdAt:new Date().toISOString(),pairing:{activationId:randomUUID(),identity:'confirmed'}};
 const dir=path.join(f.c.installRoot,'connections',id),state=path.join(dir,'state');await mkdir(state,{recursive:true});await writeFile(path.join(dir,'connection.json'),JSON.stringify(r));await writeFile(path.join(f.c.installRoot,'active-connection.json'),JSON.stringify({connectionId:id}));
 await api.diagnoseInstallation(f.c,{env:{},connectionDeps:{discover:async()=>[]}});assert.deepEqual(await readdir(state),[]);
 const main=await startMain(state,{adapters:[],quiet:true,intervalMs:0});t.after(()=>main.close());const report=await api.diagnoseInstallation(f.c,{env:{},connectionDeps:{discover:async()=>[]}});assert.equal(check(report,'bus_service').code,'bus_running');assert.equal(report.pairHealth.identity,'confirmed');assert.equal(report.pairHealth.roundtrip.codex_to_claude.status,'untested');
});
