import test from 'node:test';import assert from 'node:assert/strict';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
import {automationLock,setAutomation,enqueuePairJob,readPairJob} from '../../src/pairing/jobs.ts';
import {runPairWorker} from '../../src/pairing/worker.ts';
import * as notifications from '../../src/pairing/notifications.ts';
async function ready(t:any){const f=await pairingFixture(t);await setAutomation(f.c,true,f.deps);const id=await stageNativeCommand(f,f.peers[1],'生成连接码');await enqueuePairJob(f.c,id,f.deps);await runPairWorker(f.c,f.deps);return {...f,id};}
test('delayed notification evidence settles the original transport without another send',async t=>{
 const f=await ready(t);let sends=0,reads=0,waits=0;
 const transport={send:async()=>{sends++;return {status:'unknown'};},inspect:async()=>++reads>=4?{status:'delivered',evidenceRef:'fixture:delayed'}:{status:'missing'}};
 await notifications.notifyPairJob(f.c,f.id,{...f.deps,transport} as any);
 assert.equal(typeof (notifications as any).settlePairNotification,'function');
 await (notifications as any).settlePairNotification(f.c,f.id,{...f.deps,transport,maxWaitMs:10000,sleep:async(ms:number)=>{waits++;f.clock.value+=ms;}});
 assert.equal(sends,1);assert.ok(waits>0);assert.equal((await readPairJob(f.c,f.id))!.notification.phase,'delivered');
});
test('bounded notification settlement leaves unknown intact and never repeats the write',async t=>{
 const f=await ready(t);let sends=0,waited=0;const transport={send:async()=>{sends++;return {status:'unknown'};},inspect:async()=>({status:'missing'})};
 await notifications.notifyPairJob(f.c,f.id,{...f.deps,transport} as any);
 assert.equal(typeof (notifications as any).settlePairNotification,'function');
 await (notifications as any).settlePairNotification(f.c,f.id,{...f.deps,transport,maxWaitMs:2500,sleep:async(ms:number)=>{waited+=ms;f.clock.value+=ms;}});
 assert.equal(sends,1);assert.equal(waited,2500);assert.equal((await readPairJob(f.c,f.id))!.notification.phase,'needs_check');
});

test('notification evidence retries real local admission-lock contention without another transport write',async t=>{
 const f=await ready(t);let sends=0,waits=0,delivered=false;const transport={send:async()=>{sends++;return {status:'unknown'};},inspect:async()=>delivered?{status:'delivered',evidenceRef:'fixture:after-contention'}:{status:'missing'}};
 await notifications.notifyPairJob(f.c,f.id,{...f.deps,transport} as any);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),locked=new Promise<void>(r=>entered=r);
 const holding=automationLock(f.c,async()=>{entered();await gate;});await locked;delivered=true;
 try{await notifications.settlePairNotification(f.c,f.id,{...f.deps,transport,maxWaitMs:2500,sleep:async(ms:number)=>{waits++;f.clock.value+=ms;release();await holding;}} as any);}finally{release();await holding;}
 assert.equal(sends,1);assert.equal(waits,1);assert.equal((await readPairJob(f.c,f.id))!.notification.phase,'delivered');
});
