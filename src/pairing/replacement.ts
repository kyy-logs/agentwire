import path from 'node:path';
import {readFile,unlink} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {readConnection,activeConnection} from '../installation/connections.ts';
import {assertIdle,inspectConnectionBindings,inspectConnectionRoutes,stopBus} from '../installation/connection-management.ts';
import {optional,safePath,hash,jsonBytes,atomicBytes} from '../installation/paths.ts';
import type {InstallContext,ConnectionRecord} from '../installation/model.ts';
import type {PairActivation,PairDeps,PairTransaction} from './model.ts';

const recordFile=(c:InstallContext,id:string)=>path.join(c.installRoot,'connections',id,'connection.json');
const guardFile=(c:InstallContext)=>path.join(c.installRoot,'connection-transition.json');
const marker=(a:PairActivation)=>({schemaVersion:1,operationId:a.activationId,from:a.replacement!.connectionId,to:a.connectionId,phase:'pair_replacing'});

/** Called only after the native redeem intent and both new targets are verified.
 * A fresh human redemption may replace the installation's single active pair
 * even when neither new chat belongs to the old pair. Read-only preflight must
 * finish before claiming the code. */
export async function inspectReplacement(c:InstallContext,old:ConnectionRecord):Promise<NonNullable<PairActivation['replacement']>>{
 if(!['paired','ready'].includes(old.phase)||old.errorCode)throw Error('active_connection_exists');
 await inspectConnectionRoutes(c,old);if(old.schemaVersion===2)await inspectConnectionBindings(c,old);await assertIdle(c,old);
 const before=await readFile(await safePath(c.installRoot,recordFile(c,old.connectionId)));
 return {connectionId:old.connectionId,beforeSha256:hash(before),afterSha256:hash(jsonBytes({...old,phase:'disconnected'})),phase:'pending'};
}

/** Caller holds connection.lock. The existing guard blocks normal clients AND
 * direct IPC while the old daemon drains. No task is stopped or replayed. */
export async function detachReplacement(c:InstallContext,tx:PairTransaction,a:PairActivation,deps:PairDeps){
 const replacement=a.replacement!;
 const guard=await safePath(c.installRoot,guardFile(c)),existing=await optional(guard);
 if(existing&&!isDeepStrictEqual(JSON.parse(existing.toString()),marker(a)))throw Error('connection_switch_requires_check');
 const old=await readConnection(c,replacement.connectionId),file=await safePath(c.installRoot,recordFile(c,old.connectionId)),bytes=await readFile(file);
 const current=await activeConnection(c,true);
 if(current.connectionId!==old.connectionId&&current.connectionId!==a.connectionId)throw Error('pairing_activation_requires_check');
 if(replacement.phase==='detached'){
  if(hash(bytes)!==replacement.afterSha256)throw Error('pairing_activation_requires_check');
  if(existing)await unlink(guard);return;
 }
 if(current.connectionId!==old.connectionId)throw Error('pairing_activation_requires_check');
 const original=hash(bytes)===replacement.beforeSha256,detached=hash(bytes)===replacement.afterSha256;
 if(!original&&!detached||!existing&&!original)throw Error('pairing_activation_requires_check');
 await assertIdle(c,old);
 if(!existing){await inspectConnectionRoutes(c,old);await atomicBytes(guard,jsonBytes(marker(a)));}
 await deps.afterStep?.('replacement_guarded');
 await stopBus(c,old,deps);await deps.afterStep?.('replacement_stopped');
 await assertIdle(c,old);if(old.schemaVersion===2)await inspectConnectionBindings(c,old);
 const routesFile=await safePath(c.installRoot,path.join(c.installRoot,'routes.json')),routes=await optional(routesFile);
 // A crash may leave empty routes before the old record is marked disconnected.
 if(routes&&isDeepStrictEqual(JSON.parse(routes.toString()),{schemaVersion:1,routes:[]})){
  if(!existing)throw Error('connection_routes_require_check');
 }else{if(!original)throw Error('connection_routes_require_check');await inspectConnectionRoutes(c,old);}
 if(hash(await readFile(file))!==hash(bytes))throw Error('pairing_activation_requires_check');
 const latest=await optional(guard);if(!latest||!isDeepStrictEqual(JSON.parse(latest.toString()),marker(a)))throw Error('connection_switch_requires_check');
 await atomicBytes(routesFile,jsonBytes({schemaVersion:1,routes:[]}));
 await deps.afterStep?.('replacement_routes_cleared');
 if(original)await atomicBytes(file,jsonBytes({...old,phase:'disconnected'}));
 await deps.afterStep?.('replacement_record_disconnected');
 replacement.phase='detached';await tx.commit();await deps.afterStep?.('replacement_detached');
 // The old daemon is confirmed stopped, its record is disconnected, and its
 // routes are empty. Normal activation/recovery now owns the remaining steps.
 await unlink(guard);
}
