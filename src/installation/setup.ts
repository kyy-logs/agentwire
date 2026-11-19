import {readdir,readFile,mkdir,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertId} from '../model.ts';
import {hash,optional,safePath,atomicBytes,jsonBytes,resolveLayout,withInstallLock} from './paths.ts';
import {runtimeIsActive} from './service.ts';
import {inspectPairWorker} from '../pairing/worker.ts';
import {inspectPairOperations} from '../pairing/operations.ts';
import type {InstallContext,SetupPlan} from './model.ts';
type Operation=SetupPlan&{files:{target:string;before:string|null;after:string;stage:string}[]};
async function productFiles(root:string){const out:string[]=[];async function walk(rel:string){let entries;try{entries=await readdir(path.join(root,rel),{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw e;}for(const e of entries){const name=path.join(rel,e.name);if(e.isSymbolicLink())throw Error('symlink_not_allowed');if(e.isDirectory())await walk(name);else if(e.isFile()&&(/\.(ts|md|yaml|json|cmd|ps1)$/.test(e.name)))out.push(name);}}await walk('src');await walk('assets');for(const f of ['package.json']){await access(path.join(root,f));out.push(f);}return out.sort();}
function opPath(c:InstallContext,id:string){assertId(id);return path.join(resolveLayout(c).install,'operations',id);}
export async function previewSetup(c:InstallContext,options:{nodeVersion?:string}={}):Promise<SetupPlan>{
 if((await inspectPairWorker(c)).active)throw Error('active_pairing_worker');
 if((await inspectPairOperations(c)).active)throw Error('active_pairing_operation');
 const l=resolveLayout(c);await safePath(l.root,l.root);let version=options.nodeVersion;
 try{if(!version)version=(await promisify(execFile)(c.nodeExe,['--version'],{windowsHide:true,timeout:5000})).stdout.trim();}catch{throw Error('node_unavailable');}
 if(!/^v\d+\./.test(version!)||Number(version!.slice(1).split('.')[0])<24)throw Error('node_version');
 const manifestFile=path.join(l.install,'manifest.json'),raw=await optional(manifestFile);const old=raw?JSON.parse(raw.toString()):{files:{}};
 if(raw&&(old.schemaVersion!==1||typeof old.files!=='object'))throw Error('invalid_manifest');
 const desired:{target:string;bytes:Buffer}[]=[];
 for(const rel of await productFiles(c.sourceRoot)){const file=await safePath(c.sourceRoot,path.join(c.sourceRoot,rel));desired.push({target:path.join(l.runtime,rel),bytes:await readFile(file)});}
 const quote=(s:string)=>{if(/["\r\n%]/.test(s))throw Error('unsupported_launcher_path');return '"'+s+'"';};
 desired.push({target:path.join(l.bin,'labus.cmd'),bytes:Buffer.from('@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "AGENTWIRE_INSTALL_ROOT='+quote(l.root).slice(1,-1)+'"\r\nset "_LABUS_CP="\r\nfor /f "tokens=2 delims=:" %%C in (\'chcp\') do set "_LABUS_CP=%%C"\r\nchcp 65001 >nul\r\n'+quote(c.nodeExe)+' --experimental-strip-types '+quote(path.join(l.runtime,'src','labus.ts'))+' %*\r\nset "_LABUS_EXIT=%ERRORLEVEL%"\r\nif defined _LABUS_CP chcp %_LABUS_CP% >nul\r\nexit /b %_LABUS_EXIT%\r\n')});
 const operationId=randomUUID(),files:Operation['files']=[],changes:SetupPlan['changes']=[];
 for(const item of desired){await safePath(l.root,item.target);const current=await optional(item.target),before=current?hash(current):null,after=hash(item.bytes);if(before===after){if(!old.files[item.target])throw Error('foreign_file');continue;}if(before!==null&&old.files[item.target]!==before)throw Error('foreign_file');const stage=path.join(opPath(c,operationId),'files',String(files.length));files.push({target:item.target,before,after,stage});changes.push({target:item.target,beforeSha256:before,afterSha256:after,kind:'runtime'});}
 if(changes.length&&await runtimeIsActive(c))throw Error('active_runtime');
 await mkdir(path.join(opPath(c,operationId),'files'),{recursive:true});
 for(const f of files)await atomicBytes(f.stage,desired.find(x=>x.target===f.target)!.bytes);
 const op:Operation={schemaVersion:1,operationId,changes,files,status:'preview'};await atomicBytes(path.join(opPath(c,operationId),'operation.json'),jsonBytes(op));return op;
}
export async function applySetup(c:InstallContext,id:string,options:{afterWrite?:()=>Promise<void>}={}):Promise<SetupPlan>{
 return withInstallLock(c,()=>applySetupOne(c,id,options));
}
async function applySetupOne(c:InstallContext,id:string,options:{afterWrite?:()=>Promise<void>}={}):Promise<SetupPlan>{
 if((await inspectPairWorker(c)).active)throw Error('active_pairing_worker');
 if((await inspectPairOperations(c)).active)throw Error('active_pairing_operation');
 const l=resolveLayout(c),file=path.join(opPath(c,id),'operation.json');await safePath(l.root,file);const op:Operation=JSON.parse(await readFile(file,'utf8'));if(op.operationId!==id||op.schemaVersion!==1)throw Error('operation_mismatch');
 const mf=path.join(l.install,'manifest.json'),raw=await optional(mf),manifest=raw?JSON.parse(raw.toString()):{schemaVersion:1,files:{}};
 for(const f of op.files){await safePath(l.root,f.target);await safePath(opPath(c,id),f.stage);const bytes=await readFile(f.stage);if(hash(bytes)!==f.after)throw Error('staging_hash_mismatch');const current=await optional(f.target),actual=current?hash(current):null;if(actual!==f.before&&actual!==f.after)throw Error('configuration_changed');}
 if(op.files.length&&op.status!=='applied'&&await runtimeIsActive(c,true))throw Error('active_runtime');
 op.status='applying';await atomicBytes(file,jsonBytes(op));
 for(const f of op.files){const bytes=await readFile(f.stage);const current=await optional(f.target),actual=current?hash(current):null;if(actual!==f.before&&actual!==f.after)throw Error('configuration_changed');if(actual!==f.after)await atomicBytes(f.target,bytes);manifest.files[f.target]=f.after;await atomicBytes(mf,jsonBytes(manifest));await options.afterWrite?.();}
 op.status='applied';await atomicBytes(file,jsonBytes(op));return op;
}
