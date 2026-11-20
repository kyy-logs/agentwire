import {findAgent,agents} from '../agents/registry.ts';
import {assertId} from '../model.ts';import type {Provider,SourceRef} from './model.ts';
export async function readCallerSource(provider:Provider,env:Record<string,string|undefined>,skillSessionId?:string):Promise<SourceRef>{
 const agent=findAgent(provider);if(!agent)throw Error('source_provider_invalid');const native=env[agent.sessionEnv];
 if(!agent.allowSkillSession&&!native)throw Error('source_session_missing');if(native&&skillSessionId&&native!==skillSessionId)throw Error('source_session_conflict');const sessionId=native||skillSessionId;if(!sessionId)throw Error('source_session_missing');try{assertId(sessionId);}catch{throw Error('source_session_invalid');}return {provider,sessionId};
}
/** Global route mutation cannot use a model-supplied session as sole proof. */
export async function readSwitchCallerSource(provider:Provider,env:Record<string,string|undefined>,skillSessionId?:string):Promise<SourceRef>{
 const agent=findAgent(provider);if(!agent)throw Error('source_provider_invalid');
 const native=env[agent.sessionEnv],other=agents.some(a=>a.provider!==provider&&!!env[a.sessionEnv]);
 if(other)throw Error('source_provider_conflict');if(!native)throw Error('source_native_identity_required');return readCallerSource(provider,env,skillSessionId);
}
