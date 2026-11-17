import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertId} from '../model.ts';
import {readPairEvent,verifyPairIntent} from './capture.ts';
import {withPairState} from './store.ts';
import type {InstallContext,Provider} from '../installation/model.ts';
import type {PairDeps,PairIntent} from './model.ts';
function now(deps:PairDeps){const t=(deps.now??(()=>new Date()))().getTime();if(!Number.isFinite(t))throw Error('pairing_identity_unconfirmed');return t;}
/** Hook-time correlation only: neither creates a PairIntent nor issues/claims a
 * code. The native input may not be persisted until after this Hook returns. */
export async function stagePairRequest(c:InstallContext,provider:Provider,event:unknown,deps:PairDeps={}):Promise<string|undefined>{
 const e=await readPairEvent(c,provider,event);if(!e)return;
 return withPairState(c,async tx=>{
  const key=provider==='codex'?'turn_id':'prompt_id',old=tx.state.requests.find(r=>r.provider===provider&&r.event.session_id===e.session_id&&r.event[key]===e[key]);
  if(old){if(!isDeepStrictEqual(old.event,e))throw Error('pairing_identity_unconfirmed');return old.requestId;}
  const t=now(deps),request={requestId:randomUUID(),provider,event:e,observedAt:new Date(t).toISOString(),expiresAt:new Date(t+120000).toISOString()};
  tx.state.requests.push(request);await tx.commit();return request.requestId;
 },deps);
}
/** Called by the CLI with the exact ticket delivered in this input's native
 * context. No session/cwd/command overrides and no latest-request lookup. */
export async function resolvePairRequest(c:InstallContext,ticket:string,deps:PairDeps={}):Promise<PairIntent>{
 try{assertId(ticket);}catch{throw Error('pairing_identity_unconfirmed');}
 return withPairState(c,async tx=>{
  const r=tx.state.requests.find(r=>r.requestId===ticket);if(!r)throw Error('pairing_identity_unconfirmed');
  if(r.intentId)return structuredClone(tx.state.intents.find(i=>i.intentId===r.intentId)!);
  const t=now(deps);if(t<Date.parse(r.observedAt))throw Error('pairing_identity_unconfirmed');if(t>=Date.parse(r.expiresAt))throw Error('pairing_intent_expired');
  const intent=await verifyPairIntent(c,r.provider,r.event,deps);if(!intent)throw Error('pairing_identity_unconfirmed');
  const checked=now(deps);if(checked>=Date.parse(r.expiresAt)||checked>=Date.parse(intent.expiresAt))throw Error('pairing_intent_expired');
  const old=tx.state.intents.find(i=>i.intentId===intent.intentId);if(old&&!isDeepStrictEqual(old,intent))throw Error('pairing_identity_unconfirmed');
  if(!old)tx.state.intents.push(intent);r.intentId=intent.intentId;await tx.commit();return structuredClone(intent);
 },deps);
}
