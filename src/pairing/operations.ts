import {randomUUID} from 'node:crypto';import path from 'node:path';
import {optional,safePath,atomicBytes,jsonBytes,withInstallLock,deadPid} from '../installation/paths.ts';
import {assertId} from '../model.ts';import type {InstallContext} from '../installation/model.ts';
type Operation={id:string;pid:number};
const fileFor=(c:InstallContext)=>safePath(c.installRoot,path.join(c.installRoot,'pairing','executions.json'));
async function read(c:InstallContext):Promise<Operation[]>{const bytes=await optional(await fileFor(c));if(!bytes)return [];if(bytes.length>32768)throw Error('pairing_operations_invalid');const s=JSON.parse(bytes.toString());if(s.schemaVersion!==1||!Array.isArray(s.operations)||s.operations.length>128)throw Error('pairing_operations_invalid');const ids=new Set();for(const o of s.operations){try{assertId(o.id);}catch{throw Error('pairing_operations_invalid');}if(!Number.isSafeInteger(o.pid)||o.pid<=0||ids.has(o.id))throw Error('pairing_operations_invalid');ids.add(o.id);}return s.operations;}
export async function inspectPairOperations(c:InstallContext){const operations=(await read(c)).filter(o=>!deadPid(o.pid));return {active:operations.length>0,count:operations.length};}
/** Registration and setup exclusion share mutation.lock. Never hold that lock
 * across core execution: ensureService needs it independently. */
export async function withPairOperation<T>(c:InstallContext,fn:()=>Promise<T>):Promise<T>{
 const id=randomUUID();await withInstallLock(c,async()=>{const operations=(await read(c)).filter(o=>!deadPid(o.pid));if(operations.length>=32)throw Error('pairing_operation_limit');await atomicBytes(await fileFor(c),jsonBytes({schemaVersion:1,operations:[...operations,{id,pid:process.pid}]}));});
 try{return await fn();}finally{await withInstallLock(c,async()=>{const operations=(await read(c)).filter(o=>o.id!==id);await atomicBytes(await fileFor(c),jsonBytes({schemaVersion:1,operations}));});}
}
