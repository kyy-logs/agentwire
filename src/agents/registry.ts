import {codex} from './codex.ts';
import {claude} from './claude.ts';
import type {AgentIntegration,AgentRuntimeOptions} from './model.ts';
import type {Provider} from '../installation/model.ts';
import type {EvidenceReader} from '../native/model.ts';
// Explicit built-ins only: importing a module never starts a CLI or changes configuration.
export const agents:readonly AgentIntegration[]=Object.freeze([codex,claude]);
const byProvider=new Map(agents.map(agent=>[agent.provider,agent]));
export function findAgent(provider:unknown):AgentIntegration|undefined{return typeof provider==='string'?byProvider.get(provider as Provider):undefined;}
export function getAgent(provider:unknown):AgentIntegration{const agent=findAgent(provider);if(!agent)throw Error('invalid_provider');return agent;}
export async function createAgentRuntime(options:AgentRuntimeOptions){
 const entries=await Promise.all(agents.map(async agent=>({provider:agent.provider,...await agent.createRuntime(options)})));
 for(const entry of entries)if(entry.adapter.kind!==entry.provider)throw Error('adapter_provider_mismatch');
 return {adapters:entries.map(entry=>entry.adapter),readers:Object.fromEntries(entries.map(entry=>[entry.provider,entry.reader])) as Record<Provider,EvidenceReader>};
}
