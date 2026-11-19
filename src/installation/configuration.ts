import {readFile,mkdir,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {assertId} from '../model.ts';import {hash,optional,safePath,atomicBytes,jsonBytes,resolveLayout,withInstallLock} from './paths.ts';import type {InstallContext,SetupPlan,Provider} from './model.ts';
export type PathStore={get:()=>Promise<string>;set:(value:string)=>Promise<void>};
type Options={pathStore?:PathStore;afterWrite?:()=>Promise<void>};
async function setConfirmedPath(store:PathStore,value:string):Promise<void>{
 // Windows can persist PATH before its environment-change notification hangs.
 // Observe the desired state before recording ownership or finishing rollback.
 let failed=false,failure:unknown;
 try{await store.set(value);}catch(error){failed=true;failure=error;}
 let actual:string;
 try{actual=await store.get();}catch(error){if(failed)throw failure;throw error;}
 if(actual!==value){if(failed)throw failure;throw Error('path_write_unconfirmed');}
}
type Entry={target:string;kind:'hook'|'skill'|'path';before:string|null;after:string;originalFile:string;stagedFile:string;groups?:Record<string,unknown[]>};
type Operation=SetupPlan&{entries:Entry[];appliedTargets:string[];rolledBackTargets:string[];previousOwners?:Record<string,{after:string;operationId:string}>};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function registry(c:InstallContext):PathStore{if(path.resolve(c.home)!==path.resolve(os.homedir()))throw Error('test_requires_path_store');const run=async(code:string,extra={})=>(await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,...extra},timeout:5000})).stdout.trim();return {get:async()=>JSON.parse(await run("[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ConvertTo-Json -Compress ([Environment]::GetEnvironmentVariable('Path','User'))"))||'',set:async(value)=>{await run("[Environment]::SetEnvironmentVariable('Path',$env:LABUS_PATH_VALUE,'User')",{LABUS_PATH_VALUE:value});}};}
function operationDir(c:InstallContext,id:string){assertId(id);return path.join(resolveLayout(c).install,'configuration',id);}
async function save(c:InstallContext,op:Operation){await atomicBytes(path.join(operationDir(c,op.operationId),'operation.json'),jsonBytes(op));}
function targets(c:InstallContext){return {codex:path.join(c.home,'.codex','hooks.json'),claude:path.join(c.home,'.claude','settings.json'),codexSkill:path.join(c.home,'.agents','skills','labus','SKILL.md'),claudeSkill:path.join(c.home,'.claude','skills','labus','SKILL.md')};}
function shellArg(s:string){if(/["$`\r\n%]/.test(s))throw Error('unsupported_hook_path');return '"'+s.replaceAll('\\','/')+'"';}
function hookGroups(c:InstallContext,provider:Provider){const l=resolveLayout(c);let command=shellArg(c.nodeExe)+' --experimental-strip-types '+shellArg(path.join(l.runtime,'src','installation','hook-router.ts'))+' --root '+shellArg(l.root)+' --provider '+provider;if(provider==='codex'&&process.platform==='win32'){const psArg=(s:string)=>"'"+s.replaceAll("'","''")+"'";const script='& '+[c.nodeExe,'--experimental-strip-types',path.join(l.runtime,'src','installation','hook-router.ts'),'--root',l.root,'--provider',provider].map(psArg).join(' ')+'; exit $LASTEXITCODE';command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(script,'utf16le').toString('base64');}return Object.fromEntries((provider==='codex'?['UserPromptSubmit','Stop','Interrupt']:['UserPromptSubmit','Stop','StopFailure']).map(event=>[event,[{hooks:[{type:'command',command,timeout:event==='UserPromptSubmit'?15:5}]}]]));}
const commands=(group:any)=>JSON.stringify((group?.hooks||[]).map((h:any)=>[h.type,h.command,h.commandWindows]));
function mergeHook(actual:any[],group:any,prior:any[],hasOwner:boolean){
 let changed=false;const matches=actual.filter(x=>same(x,group));if(matches.length>1||matches.length&&!hasOwner)throw Error('foreign_hook_group');
 const relevant=new Set([group,...prior].map(commands));if(actual.some(x=>relevant.has(commands(x))&&!same(x,group)&&!prior.some(old=>same(x,old))))throw Error('hook_changed_requires_review');
 for(const old of prior){
  const indexes=actual.map((x,i)=>same(x,old)?i:-1).filter(i=>i>=0);if(indexes.length>1)throw Error('hook_changed_requires_review');
  if(indexes.length&&!same(old,group)){if(actual.some(x=>same(x,group)))actual.splice(indexes[0],1);else actual.splice(indexes[0],1,group);changed=true;}
  else if(!indexes.length&&!actual.some(x=>same(x,group))&&actual.some(x=>commands(x)===commands(old)))throw Error('hook_changed_requires_review');
 }
 if(!actual.some(x=>same(x,group))){if(actual.some(x=>commands(x)===commands(group)))throw Error('foreign_hook_group');actual.push(group);changed=true;}
 return changed;
}
async function owned(c:InstallContext){const b=await optional(path.join(resolveLayout(c).install,'configuration-owner.json'));return b?JSON.parse(b.toString()):{targets:{}};}
/** Read-only disk diagnosis; file presence never proves native loading/trust. */
export async function inspectChatInstallation(c:InstallContext){
 const t=targets(c),result:any={nodeRuntime:Number(process.versions.node.split('.')[0])>=24?'supported':'unsupported'};
 for(const provider of ['codex','claude'] as const){const r:any={hookFile:'missing',skillFile:'missing',runtimeEntry:'missing',nativeVersionSupport:'unverified',nativeTrust:'unverified',currentChatObservation:'unverified'};result[provider]=r;
  try{const b=await optional(await safePath(c.home,t[provider]));if(b){if(b.length>1048576)throw Error('configuration_limit');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));const wanted=hookGroups(c,provider);r.hookFile=Object.entries(wanted).every(([event,groups])=>Array.isArray(value.hooks?.[event])&&groups.every(group=>value.hooks[event].filter((actual:unknown)=>same(actual,group)).length===1))?'configured':'changed';}}catch{r.hookFile='invalid';}
  try{const b=await optional(await safePath(c.home,provider==='codex'?t.codexSkill:t.claudeSkill));if(b)r.skillFile=b.includes(Buffer.from('pair issue --intent'))&&b.includes(Buffer.from('pair redeem --intent'))?'present':'outdated';}catch{r.skillFile='invalid';}
  try{r.runtimeEntry=await optional(await safePath(c.installRoot,path.join(resolveLayout(c).runtime,'src','pairing','cli.ts')))?'present':'missing';}catch{r.runtimeEntry='invalid';}
 }
 return result;
}
export async function previewConfiguration(c:InstallContext,options:Options={}):Promise<SetupPlan>{
 const pathStore=options.pathStore||registry(c),l=resolveLayout(c),t=targets(c),owner=await owned(c),id=randomUUID();const op:Operation={schemaVersion:1,operationId:id,status:'preview',changes:[],entries:[],appliedTargets:[],rolledBackTargets:[],previousOwners:{}};
 const desired:{target:string;kind:Entry['kind'];bytes:Buffer;groups?:Entry['groups']}[]=[];
 for(const provider of ['codex','claude'] as const){const target=t[provider];await safePath(c.home,target);const current=await optional(target),config=current?JSON.parse(current.toString('utf8')):{};if(!config||typeof config!=='object'||Array.isArray(config))throw Error('invalid_configuration');config.hooks??={};if(typeof config.hooks!=='object'||Array.isArray(config.hooks))throw Error('invalid_configuration');for(const groups of Object.values(config.hooks)){if(Array.isArray(groups))for(const group of groups)for(const h of group?.hooks||[]){if(typeof h.command==='string'&&/\/src\/lifecycle\/hook\.ts(?:\s|["'])/.test(h.command.replaceAll('\\','/')))throw Error('legacy_bus_hook_requires_retirement');}}const groups=hookGroups(c,provider);let changed=false;
 const previousHookOperation=owner.targets[target]?await load(c,owner.targets[target].operationId):undefined,prior=previousHookOperation?.entries.find(e=>e.target===target)?.groups||{};
 for(const [event,list] of Object.entries(groups)){const actual=config.hooks[event]??=[];if(!Array.isArray(actual))throw Error('invalid_configuration');for(const g of list)if(mergeHook(actual,g,prior[event]||[],!!owner.targets[target]))changed=true;config.hooks[event]=actual;}
 desired.push({target,kind:'hook',bytes:!changed&&current?current:jsonBytes(config),groups});
 const skillTarget=provider==='codex'?t.codexSkill:t.claudeSkill;await safePath(c.home,skillTarget);const template=await readFile(path.join(c.sourceRoot,'assets','skills',provider,'labus','SKILL.md'),'utf8');const bytes=Buffer.from(template.replaceAll('{{LAUNCHER}}',path.join(l.bin,'labus.cmd').replaceAll('\\','/')));const previous=await optional(skillTarget);if(previous&&!owner.targets[skillTarget])throw Error('skill_name_conflict');if(previous&&hash(previous)!==owner.targets[skillTarget]?.after)throw Error('skill_changed_requires_review');desired.push({target:skillTarget,kind:'skill',bytes});}
 const oldPath=await pathStore.get(),bin=l.bin;const parts=oldPath.split(';').filter(Boolean);const already=parts.some(x=>path.resolve(x).toLowerCase()===bin.toLowerCase());if(!already)desired.push({target:'user:PATH',kind:'path',bytes:Buffer.from(oldPath+(oldPath&&!oldPath.endsWith(';')?';':'')+bin)});
 for(const item of desired){const current=item.kind==='path'?Buffer.from(oldPath):await optional(item.target),before=current?hash(current):null,after=hash(item.bytes);if(before===after)continue;const n=String(op.entries.length),originalFile=path.join(operationDir(c,id),n+'.before'),stagedFile=path.join(operationDir(c,id),n+'.after');op.entries.push({target:item.target,kind:item.kind,before,after,originalFile,stagedFile,groups:item.groups});if(owner.targets[item.target])op.previousOwners![item.target]=structuredClone(owner.targets[item.target]);op.changes.push({target:item.target,kind:item.kind,beforeSha256:before,afterSha256:after});await atomicBytes(stagedFile,item.bytes);if(current)await atomicBytes(originalFile,current);}
 await save(c,op);return op;
}
async function load(c:InstallContext,id:string):Promise<Operation>{const file=path.join(operationDir(c,id),'operation.json');await safePath(c.installRoot,file);const op=JSON.parse(await readFile(file,'utf8'));if(op.schemaVersion!==1||op.operationId!==id||!Array.isArray(op.entries))throw Error('invalid_configuration_operation');const allowed=Object.values(targets(c));for(const e of op.entries){if(e.target!=='user:PATH'&&!allowed.includes(e.target))throw Error('invalid_configuration_target');if(e.target!=='user:PATH')await safePath(c.home,e.target);await safePath(operationDir(c,id),e.stagedFile);await safePath(operationDir(c,id),e.originalFile);}return op;}
export async function applyConfiguration(c:InstallContext,id:string,options:Options={}):Promise<SetupPlan>{
 return withInstallLock(c,()=>applyConfigurationOne(c,id,options));
}
async function applyConfigurationOne(c:InstallContext,id:string,options:Options={}):Promise<SetupPlan>{
 const pathStore=options.pathStore||registry(c),op=await load(c,id);if(op.status==='rolled_back')throw Error('operation_rolled_back');const owner=await owned(c);
 const read=async(e:Entry)=>e.kind==='path'?Buffer.from(await pathStore.get()):optional(e.target);
 // Check every target before any side effect; resumption accepts only own staged bytes.
 for(const e of op.entries){const bytes=await readFile(e.stagedFile);if(hash(bytes)!==e.after)throw Error('staging_hash_mismatch');const actual=await read(e),h=actual?hash(actual):null;if(h!==e.before&&h!==e.after)throw Error('configuration_changed');}
 op.status='applying';await save(c,op);
 for(const e of op.entries){const current=await read(e),h=current?hash(current):null;if(h!==e.before&&h!==e.after)throw Error('configuration_changed_during_apply');if(h!==e.after){if(e.kind==='path')await setConfirmedPath(pathStore,(await readFile(e.stagedFile)).toString());else await atomicBytes(e.target,await readFile(e.stagedFile));}
 owner.targets[e.target]={after:e.after,operationId:id};await atomicBytes(path.join(resolveLayout(c).install,'configuration-owner.json'),jsonBytes(owner));if(!op.appliedTargets.includes(e.target))op.appliedTargets.push(e.target);await save(c,op);await options.afterWrite?.();}
 op.status='applied';await save(c,op);return op;
}
export async function rollbackConfiguration(c:InstallContext,id:string,options:Options={}):Promise<SetupPlan>{
 return withInstallLock(c,()=>rollbackConfigurationOne(c,id,options));
}
async function rollbackConfigurationOne(c:InstallContext,id:string,options:Options={}):Promise<SetupPlan>{
 const pathStore=options.pathStore||registry(c),op=await load(c,id),owner=await owned(c);if(op.status==='rolled_back')return op;
 // Precompute all removals first: changed owned content must not cause a partial rollback.
 const actions:{entry:Entry;current:Buffer|undefined;restore:Buffer|undefined}[]=[];
 for(const e of op.entries){if(op.rolledBackTargets.includes(e.target))continue;const current=e.kind==='path'?Buffer.from(await pathStore.get()):await optional(e.target);const h=current?hash(current):null;if(!op.appliedTargets.includes(e.target)&&owner.targets[e.target]?.operationId!==id){if(h!==e.before)throw Error('configuration_changed_requires_review');continue;}if(h===e.before){actions.push({entry:e,current,restore:current});continue;}let restore:Buffer|undefined;
 if(h===e.after){restore=e.before===null?undefined:await readFile(e.originalFile);if(restore&&hash(restore)!==e.before)throw Error('backup_mismatch');}
 else if(e.kind==='path'){const bin=resolveLayout(c).bin;restore=Buffer.from((current?.toString()||'').split(';').filter(x=>!x||path.resolve(x).toLowerCase()!==bin.toLowerCase()).join(';'));}
 else if(e.kind==='hook'&&current){const value=JSON.parse(current.toString()),original=e.before===null?undefined:await readFile(e.originalFile);if(original&&hash(original)!==e.before)throw Error('backup_mismatch');const prior=original?JSON.parse(original.toString()).hooks||{}:{};for(const [event,groups] of Object.entries(e.groups||{})){const actual=value.hooks?.[event];if(!Array.isArray(actual))throw Error('hook_changed_requires_review');for(const group of groups){const matches=actual.map((x:any,i:number)=>same(x,group)?i:-1).filter((i:number)=>i>=0);if(matches.length!==1)throw Error('hook_changed_requires_review');if((prior[event]||[]).some((x:any)=>same(x,group)))continue;const old=(prior[event]||[]).filter((x:any)=>commands(x)===commands(group));if(old.length>1)throw Error('hook_changed_requires_review');actual.splice(matches[0],1,...old.filter((x:any)=>!actual.some((a:any)=>same(a,x))));}if(!actual.length)delete value.hooks[event];}restore=jsonBytes(value);}
 else throw Error('owned_file_changed_requires_review');actions.push({entry:e,current,restore});}
 for(const {entry:e,current,restore} of actions){const latest=e.kind==='path'?Buffer.from(await pathStore.get()):await optional(e.target);if((latest?hash(latest):null)!==(current?hash(current):null))throw Error('configuration_changed_during_rollback');if(e.kind==='path')await setConfirmedPath(pathStore,restore?.toString()||'');else if(restore)await atomicBytes(e.target,restore);else if(latest)await unlink(e.target);const previous=op.previousOwners?.[e.target];if(previous&&restore!==undefined)owner.targets[e.target]={...previous,after:hash(restore)};else delete owner.targets[e.target];await atomicBytes(path.join(resolveLayout(c).install,'configuration-owner.json'),jsonBytes(owner));op.rolledBackTargets.push(e.target);await save(c,op);}
 op.status='rolled_back';await save(c,op);return op;
}

// An operation may own only some targets after a repair. Object insertion order
// is not application order: unwind current owners before superseded entries.
export async function configurationRollbackOrder(c:InstallContext):Promise<string[]>{
 const owner=await owned(c),pending=new Map<string,Operation>();
 async function include(id:string){assertId(id);if(pending.has(id))return;if(pending.size>=128)throw Error('configuration_ownership_limit');const op=await load(c,id);pending.set(id,op);for(const [target,previous] of Object.entries(op.previousOwners||{})){if(!op.entries.some(e=>e.target===target)||!/^[a-f0-9]{64}$/.test(previous.after))throw Error('invalid_configuration_operation');await include(previous.operationId);}}
 for(const current of Object.values(owner.targets) as any[])await include(current.operationId);
 const result:string[]=[];
 while(pending.size){const next=[...pending].find(([id,op])=>op.entries.filter(e=>!op.rolledBackTargets.includes(e.target)&&(op.appliedTargets.includes(e.target)||owner.targets[e.target]?.operationId===id)).every(e=>{const current=owner.targets[e.target]?.operationId;return !current||current===id||!pending.has(current);}));if(!next)throw Error('configuration_ownership_cycle');const [id,op]=next;result.push(id);pending.delete(id);for(const e of op.entries)if(!op.rolledBackTargets.includes(e.target)&&owner.targets[e.target]?.operationId===id){const previous=op.previousOwners?.[e.target];if(previous&&e.before!==null)owner.targets[e.target]=previous;else delete owner.targets[e.target];}}
 return result;
}
