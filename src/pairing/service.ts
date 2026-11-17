import {activeConnection,readConnection,samePair,sameChat,activatePairedConnectionLocked,checkPairedRoutesLocked,assertPairedInfrastructureLocked} from '../installation/connections.ts';
import {discoverCandidates} from '../installation/discovery.ts';
import {withPairState,inspectClaimLocked,claimCodeLocked,completeActivationLocked} from './store.ts';
import type {InstallContext,ConnectionRecord} from '../installation/model.ts';
import type {PairActivation,PairDeps,PairTransaction} from './model.ts';

async function active(c:InstallContext){try{return await activeConnection(c);}catch(e:any){if(e.message!=='not_connected')throw e;}}
async function confirmTargets(c:InstallContext,a:Pick<PairActivation,'codex'|'claude'>,deps:PairDeps){
 for(const p of ['codex','claude'] as const){const matches=(await(deps.discover||discoverCandidates)(c,p,a[p].sessionId)).filter(x=>x.sessionId===a[p].sessionId);
  if(matches.length!==1||!sameChat(matches[0],a[p])||p==='claude'&&matches[0].availability!=='live_endpoint')throw Error('pairing_target_unavailable');}
 // Codex discovery proves the exact known identity only; it is not evidence
 // that a Desktop endpoint is online or that a message can make a round trip.
}
function verifyResult(r:ConnectionRecord,a:PairActivation){
 const version=a.reuse?.schemaVersion??2;if(r.schemaVersion!==version||!samePair(r,a)||r.schemaVersion===2&&r.pairing.activationId!==(a.reuse?.schemaVersion===2?a.reuse.activationId:a.activationId))throw Error('pairing_activation_requires_check');
}
async function resumeLocked(c:InstallContext,tx:PairTransaction,a:PairActivation,deps:PairDeps):Promise<ConnectionRecord>{
 if(a.phase==='needs_check')throw Error('pairing_activation_requires_check');
 try{
  if(a.phase==='paired'){const r=await readConnection(c,a.connectionId);verifyResult(r,a);if(r.phase!=='disconnected')await assertPairedInfrastructureLocked(c,r);return r;}
  const old=await active(c);if(old&&old.phase!=='disconnected'&&(old.connectionId!==a.connectionId||!samePair(old,a)))throw Error('pairing_activation_requires_check');
  if(a.reuse){if(!old||['disconnected','needs_check'].includes(old.phase))throw Error('pairing_activation_requires_check');verifyResult(old,a);await assertPairedInfrastructureLocked(c,old);await completeActivationLocked(tx,a.activationId,deps);return old;}
  await confirmTargets(c,a,deps);const r=await activatePairedConnectionLocked(c,a,deps);await completeActivationLocked(tx,a.activationId,deps);return r;
 }catch(e:any){
  if(['pairing_activation_requires_check','invalid_connection','invalid_routes','session_already_routed'].includes(e.message)){a.phase='needs_check';a.errorCode='pairing_activation_requires_check';delete a.terminalAt;delete tx.state.invitations.find(i=>i.invitationId===a.invitationId)!.terminalAt;await tx.commit();throw Error('pairing_activation_requires_check');}
  throw e; // Interrupted/in-flight operations retain the same activating ID.
 }
}
export async function redeemCode(c:InstallContext,intentId:string,deps:PairDeps={}):Promise<ConnectionRecord>{
 return withPairState(c,async tx=>{
  const previous=tx.state.activations.find(a=>a.redeemIntentId===intentId);if(previous)return resumeLocked(c,tx,previous,deps);
  const {intent,inv}=inspectClaimLocked(tx,intentId,deps),pair={codex:intent.source.provider==='codex'?intent.source:inv.issuer,claude:intent.source.provider==='claude'?intent.source:inv.issuer};
  const old=await active(c);if(old&&old.phase!=='disconnected'&&!samePair(old,pair))throw Error('active_connection_exists');
  if(old?.phase==='needs_check'||old?.schemaVersion===2&&old.phase==='pairing')throw Error('pairing_activation_requires_check');
  if(tx.state.activations.some(a=>a.phase!=='paired'))throw Error('pairing_activation_requires_check');
  await confirmTargets(c,pair,deps);const reuse=old&&old.phase!=='disconnected'?old:undefined;
  // Check orphan/foreign routes before consuming a code. Reuse retains the
  // exact old schema and admission rule instead of upgrading it to paired.
  await checkPairedRoutesLocked(c,{...pair,connectionId:reuse?.connectionId??''} as PairActivation);
  const reuseProof=reuse?.schemaVersion===1?{schemaVersion:1 as const}:reuse?.schemaVersion===2?{schemaVersion:2 as const,activationId:reuse.pairing.activationId}:undefined;
  const a=await claimCodeLocked(tx,intentId,deps,reuse?.connectionId,reuseProof);await deps.afterStep?.('claimed');return resumeLocked(c,tx,tx.state.activations.find(x=>x.activationId===a.activationId)!,deps);
 },deps);
}
export async function recoverPairing(c:InstallContext,activationId:string,deps:PairDeps={}):Promise<ConnectionRecord>{
 return withPairState(c,async tx=>{const a=tx.state.activations.find(a=>a.activationId===activationId);if(!a)throw Error('pairing_activation_requires_check');return resumeLocked(c,tx,a,deps);},deps);
}
