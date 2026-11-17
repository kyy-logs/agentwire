import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pairingFixture} from '../pairing-helpers.ts';
import {redeemCode} from '../../src/pairing/service.ts';
import {inspectPairHealth} from '../../src/pairing/health.ts';
import {FileMessageStore} from '../../src/store.ts';
import {FileLifecycleStore} from '../../src/lifecycle/store.ts';
import {IdentityStore} from '../../src/native/identity-store.ts';
import {eventKey,digest} from '../../src/lifecycle/model.ts';
import {realClock} from '../../src/model.ts';

async function proof(t:any){
 const f=await pairingFixture(t),r=await redeemCode(f.c,f.redeemer.intentId,f.deps),root=path.join(f.c.installRoot,'connections',r.connectionId,'state'),messages=new FileMessageStore(root,realClock),life=new FileLifecycleStore(root),native=new IdentityStore(root,realClock),time=new Date().toISOString();
 const id=randomUUID(),replyId=randomUUID(),nonce=randomUUID(),ref={provider:'claude',sessionId:r.claude.sessionId,nativeExecutionId:randomUUID()} as const;
 const base={schemaVersion:2 as const,wireVersion:'clean-v1' as const,taskId:id,executionIndex:1,createdAt:time,expiresAt:new Date(Date.now()+60000).toISOString()};
 const m={...base,messageId:id,kind:'task' as const,from:'codex',to:'claude',sourceSessionId:r.codex.sessionId,targetSessionId:r.claude.sessionId,body:'fixture read task',returnMode:'auto' as const},back={...base,messageId:replyId,kind:'reply' as const,replyTo:id,from:'claude',to:'codex',sourceSessionId:r.claude.sessionId,targetSessionId:r.codex.sessionId,body:'fixture result'};
 const result=await life.saveResult({messageId:id,ref,terminalEventKey:eventKey(ref,'stop'),nativeOutcome:'response_ended',businessVerdict:'unverified',body:'fixture result',truncated:false});
 const p=(await messages.putNew(m)).record,reply=(await messages.putNew(back)).record;p.state='completed';p.attempts=1;p.resultRef=replyId;p.dispatchNonce=nonce;p.activeAttemptId=randomUUID();p.completion={nativeOutcome:'response_ended',businessVerdict:'unverified',eventKey:result.terminalEventKey,sha256:result.sha256,truncated:false};await messages.replace(p);
 reply.state='delivered';reply.attempts=1;reply.activeAttemptId=randomUUID();reply.receipt={status:'accepted',evidenceRef:'fixture:actual-inbound'};await messages.replace(reply);
 await life.bindExecution({...ref,messageId:id,dispatchNonce:nonce,phase:'applied',terminalEventKey:result.terminalEventKey,replyMessageId:replyId});
 const parent={schemaVersion:1 as const,connectionId:r.connectionId,provider:'claude' as const,targetSessionId:r.claude.sessionId,sourceSessionId:r.codex.sessionId,messageId:id,attemptId:p.activeAttemptId,transportId:randomUUID(),wireVersion:'clean-v1' as const,bodySha256:digest(m.body),createdAt:time,updatedAt:time,phase:'reply_committed' as const,nativeExecutionId:ref.nativeExecutionId,evidenceRef:'fixture:parent-native'};await native.prepare(parent);
 const replyIntent={...parent,provider:'codex' as const,targetSessionId:r.codex.sessionId,sourceSessionId:r.claude.sessionId,messageId:replyId,attemptId:reply.activeAttemptId,transportId:randomUUID(),bodySha256:digest(back.body),phase:'prepared' as const,nativeExecutionId:undefined,evidenceRef:undefined};
 return {...f,r,messages,life,native,parent,replyIntent};
}

test('receipt alone and an unwritten native attempt cannot report an observed roundtrip',async t=>{
 const f=await proof(t);assert.equal((await inspectPairHealth(f.c,f.r as any,f.deps)).roundtrip.codex_to_claude.status,'untested');await f.native.prepare(f.replyIntent);
 assert.equal((await inspectPairHealth(f.c,f.r as any,f.deps)).roundtrip.codex_to_claude.status,'untested');
});
test('exact result, execution and delivered native reply prove only their own direction',async t=>{
 const f=await proof(t);await f.native.prepare({...f.replyIntent,phase:'mapped',nativeExecutionId:randomUUID(),evidenceRef:'fixture:reply-native'});const health=await inspectPairHealth(f.c,f.r as any,f.deps);assert.equal(health.roundtrip.codex_to_claude.status,'observed');assert.equal(health.roundtrip.claude_to_codex.status,'untested');assert.equal(f.sent.length,0);
 await f.life.markConflict({provider:'claude',sessionId:f.r.claude.sessionId,nativeExecutionId:f.parent.nativeExecutionId},'fixture_conflict');assert.equal((await inspectPairHealth(f.c,f.r as any,f.deps)).roundtrip.codex_to_claude.status,'untested');
});
