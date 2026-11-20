import {assertId} from '../model.ts';
import {getAgent} from '../agents/registry.ts';
import type {InstallContext,Provider,Candidate} from './model.ts';
/** Exact lookup keeps provider-specific bounds and ambiguity; it never selects a latest chat. */
export async function discoverCandidates(c:InstallContext,provider:Provider,sessionId?:string):Promise<Candidate[]>{
 const agent=getAgent(provider);if(sessionId!==undefined)assertId(sessionId);return agent.discover(c,sessionId);
}
