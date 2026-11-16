import path from 'node:path';
import {lstat,readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import type {InstallContext} from './model.ts';
export const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export async function optional(file:string){try{return await readFile(file);}catch(e:any){if(e.code==='ENOENT')return;throw e;}}
export async function safePath(root:string,file:string){
 const rel=path.relative(path.resolve(root),path.resolve(file));if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('path_escape');
 let cursor=path.resolve(file);for(;;){try{if((await lstat(cursor)).isSymbolicLink())throw Error('symlink_not_allowed');}catch(e:any){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
 return path.resolve(file);
}
export async function atomicBytes(file:string,bytes:Buffer|string){await mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';const h=await open(tmp,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}try{await rename(tmp,file);}catch(e){await unlink(tmp).catch(()=>{});throw e;}}
export const jsonBytes=(v:unknown)=>Buffer.from(JSON.stringify(v,null,2)+'\n');
export function resolveLayout(c:InstallContext){const root=path.resolve(c.installRoot);return {root,runtime:path.join(root,'runtime'),bin:path.join(root,'bin'),install:path.join(root,'install'),connections:path.join(root,'connections'),routes:path.join(root,'routes.json'),logs:path.join(root,'logs')};}
export function deadPid(pid:unknown){if(!Number.isInteger(pid)||Number(pid)<=0)return false;try{process.kill(Number(pid),0);return false;}catch(e:any){return e.code==='ESRCH';}}
export async function acquireLock(file:string){
 await safePath(path.dirname(file),file);await mkdir(path.dirname(file),{recursive:true});let handle;
 try{handle=await open(file,'wx',0o600);}catch(e:any){if(e.code!=='EEXIST')throw e;let repair;try{repair=await open(file+'.recovery','wx',0o600);}catch{throw Error('installation_busy');}
 try{const old=await optional(file);if(old){let record;try{record=JSON.parse(old.toString());}catch{throw Error('lock_requires_check');}if(!deadPid(record.ownerPid))throw Error('installation_busy');if(hash((await optional(file))!)!==hash(old))throw Error('lock_requires_check');await unlink(file);}try{handle=await open(file,'wx',0o600);}catch{throw Error('installation_busy');}}finally{await repair.close();await unlink(file+'.recovery').catch(()=>{});}}
 const bytes=jsonBytes({ownerPid:process.pid,lockId:randomUUID()});await handle!.writeFile(bytes);await handle!.sync();return async()=>{await handle!.close();const current=await optional(file);if(current&&hash(current)===hash(bytes))await unlink(file);};
}
export async function withInstallLock<T>(c:InstallContext,fn:()=>Promise<T>){const release=await acquireLock(path.join(resolveLayout(c).install,'mutation.lock'));try{return await fn();}finally{await release();}}
