import type {InstallContext} from '../installation/model.ts';
import type {ExecutionRef} from '../lifecycle/model.ts';
import {validateRef} from '../lifecycle/model.ts';
import {readPairState} from './store.ts';
import {readConnection,sameChat} from '../installation/connections.ts';

/** Routing can be installed after the pairing turn's input Hook already ran.
 * Only that exact, previously verified control input can explain its orphan
 * terminal event. No text matching, newest-session lookup, or synthetic input. */
export async function isPairControlExecution(c:InstallContext,connectionId:string,ref:ExecutionRef){
 validateRef(ref);const r=await readConnection(c,connectionId);if(r.schemaVersion!==2)return false;
 const state=await readPairState(c),a=state.activations.find(a=>a.activationId===r.pairing.activationId);
 if(!a||a.phase!=='paired'||a.connectionId!==connectionId||!sameChat(a.codex,r.codex)||!sameChat(a.claude,r.claude))return false;
 const inv=state.invitations.find(i=>i.invitationId===a.invitationId);if(!inv)return false;
 return [inv.issueIntentId,a.redeemIntentId].some(id=>{
  const intent=state.intents.find(i=>i.intentId===id);
  return !!intent&&intent.nativeInputId===ref.nativeExecutionId&&intent.source.provider===ref.provider&&intent.source.sessionId===ref.sessionId&&sameChat(intent.source,r[ref.provider]);
 });
}
