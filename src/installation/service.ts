import {spawn} from 'node:child_process';
import {open,mkdir,unlink,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {requestBus} from '../ipc.ts';
import {atomicBytes,jsonBytes,optional,resolveLayout,safePath,deadPid,acquireLock,withInstallLock,hash} from './paths.ts';
import type {InstallContext,Health,ServiceHandle} from './model.ts';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export async function serviceHealth(stateRoot:string):Promise<Health>{const r=await requestBus(stateRoot,{requestId:randomUUID(),op:'health'});if(!r.ok||r.data?.stateRoot!==path.resolve(stateRoot)||typeof r.data.instanceId!=='string'||!Number.isInteger(r.data.pid))throw Error('service_identity_unconfirmed');return r.data;}
/** Never probe old daemons with an unknown operation: their error path may log.
 * The startup descriptor is bound to this exact IPC token, not merely a PID. */
export async function inspectService(stateRoot:string):Promise<Health>{
 const token=await readFile(path.join(stateRoot,'auth.token')),raw=await optional(path.join(stateRoot,'diagnostic-endpoint.json'));if(!raw)throw Error('bus_diagnostic_protocol_unverified');
 const d=JSON.parse(raw.toString());if(d.schemaVersion!==1||d.operation!=='diagnostic-health'||d.tokenSha256!==hash(token)||d.stateRoot!==path.resolve(stateRoot))throw Error('bus_diagnostic_protocol_unverified');
 const r=await requestBus(stateRoot,{requestId:randomUUID(),op:'diagnostic-health'});
 if(!r.ok||r.data?.diagnosticReadOnly!==true||r.data.instanceId!==d.instanceId||r.data.pid!==d.pid||r.data.stateRoot!==path.resolve(stateRoot))throw Error('service_identity_unconfirmed');return r.data;
}
export async function runtimeIsActive(c:InstallContext,retireDead=false){const l=resolveLayout(c),file=await safePath(l.root,path.join(l.install,'runtime-active.json')),b=await optional(file);if(!b)return false;const marker=JSON.parse(b.toString());if(!deadPid(marker.pid))return true;if(typeof marker.stateRoot!=='string')throw Error('invalid_service_marker');await safePath(l.connections,marker.stateRoot);try{await serviceHealth(marker.stateRoot);return true;}catch(e:any){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}if(retireDead){const latest=await optional(file);if(!latest||hash(latest)!==hash(b))throw Error('service_marker_changed');await unlink(file);}return false;}
export async function spawnBackground(nodeExe:string,args:string[],logs:{out:string;err:string}):Promise<{pid:number}>{
 await mkdir(path.dirname(logs.out),{recursive:true});const out=await open(logs.out,'a',0o600),err=await open(logs.err,'a',0o600);
 try{const child=spawn(nodeExe,args,{detached:true,windowsHide:true,shell:false,stdio:['ignore',out.fd,err.fd]});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {pid:child.pid!};}finally{await out.close();await err.close();}
}
export async function ensureService(c:InstallContext,stateRoot:string):Promise<ServiceHandle>{
 const l=resolveLayout(c);await safePath(l.connections,stateRoot);await mkdir(stateRoot,{recursive:true});
 try{const h=await serviceHealth(stateRoot);if(h.status!=='running')throw Error('service_storage_requires_check');return h;}catch(e:any){if(e.message==='service_storage_requires_check')throw e;}
 const lockFile=path.join(stateRoot,'service-start.lock');let release;try{release=await acquireLock(lockFile);}catch(e:any){if(e.message!=='installation_busy')throw e;for(let i=0;i<80;i++){await delay(100);try{const h=await serviceHealth(stateRoot);if(h.status!=='running')throw Error('service_storage_requires_check');return h;}catch{}}throw Error('service_start_unconfirmed');}
 try{return await withInstallLock(c,async()=>{if(await runtimeIsActive(c,true))throw Error('service_or_start_requires_check');const activeFile=path.join(l.install,'runtime-active.json'),startId=randomUUID(),entry=path.join(l.runtime,'src','installation','service-entry.ts');await safePath(l.root,entry);await atomicBytes(activeFile,jsonBytes({stateRoot:path.resolve(stateRoot),phase:'starting',ownerPid:process.pid,startId}));let child:{pid:number}|undefined;
 try{child=await spawnBackground(c.nodeExe,['--experimental-strip-types',entry,stateRoot,l.root],{out:path.join(l.logs,'service.stdout.log'),err:path.join(l.logs,'service.stderr.log')});await atomicBytes(activeFile,jsonBytes({stateRoot:path.resolve(stateRoot),phase:'starting',ownerPid:process.pid,startId,pid:child.pid}));
 for(let i=0;i<80;i++){await delay(100);try{const h=await serviceHealth(stateRoot);if(h.pid!==child.pid||h.status!=='running')throw Error('service_identity_unconfirmed');await atomicBytes(path.join(stateRoot,'service.json'),jsonBytes(h));await atomicBytes(activeFile,jsonBytes(h));return h;}catch{}if(deadPid(child.pid))throw Error('service_child_exited');}throw Error('service_start_unconfirmed');
 }catch(e){if(!child||deadPid(child.pid)){const b=await optional(activeFile);if(b&&JSON.parse(b.toString()).startId===startId)await unlink(activeFile);}throw e;}});
 }finally{await release();}
}
export async function shutdownService(h:ServiceHandle):Promise<{status:'closed'|'needs_check'}>{
 try{const actual=await serviceHealth(h.stateRoot);if(actual.instanceId!==h.instanceId||actual.pid!==h.pid)return {status:'needs_check'};const ack=await requestBus(h.stateRoot,{requestId:randomUUID(),op:'shutdown',payload:{instanceId:h.instanceId}});if(!ack.ok)return {status:'needs_check'};
 for(let i=0;i<100;i++){await delay(100);try{process.kill(h.pid,0);}catch{return {status:'closed'};}}
 return {status:'needs_check'};
 }catch{return {status:'needs_check'};}
}
