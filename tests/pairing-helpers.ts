import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {temp} from './helpers.ts';
import {mkdir,writeFile} from 'node:fs/promises';
import {stagePairRequest} from '../src/pairing/requests.ts';
import {startMain} from '../src/main.ts';
import {capturePairIntent,issueCode} from '../src/pairing/store.ts';
import type {Candidate} from '../src/installation/model.ts';
import type {PairIntent} from '../src/pairing/model.ts';
export async function pairingFixture(t:any){
 const root=await temp(t),c={home:path.join(root,'home'),installRoot:path.join(root,'install'),sourceRoot:root,nodeExe:process.execPath},clock={value:Date.parse('2026-11-17T12:00:00Z')};
 const peers=(['codex','claude'] as const).map(provider=>({provider,sessionId:randomUUID(),workspaceRoot:path.join(root,provider),availability:provider==='codex'?'candidate':'live_endpoint'} as Candidate));
 const sent:any[]=[],services=new Map<string,any>();
 const deps:any={now:()=>new Date(clock.value),discover:async(_c:any,provider:string)=>peers.filter(p=>p.provider===provider),ensure:async(_c:any,state:string)=>{
  if(!services.has(state)){const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available',details:[]}),submit:async(b:any,m:any)=>{sent.push(m);return {status:'accepted'};},reconcile:async()=>({status:'unknown'})}));const main=await startMain(state,{adapters:adapters as any,quiet:true,intervalMs:0});services.set(state,main);t.after(()=>main.close());}
  return {instanceId:'fixture',pid:process.pid,stateRoot:state};}};
 const make=(source:Candidate,command:any):PairIntent=>{const nativeInputId=randomUUID();return {intentId:randomUUID(),source,nativeInputId,command,capturedAt:new Date(clock.value).toISOString(),expiresAt:new Date(clock.value+120000).toISOString(),proofRef:path.join(c.home,source.provider==='codex'?'.codex':'.claude',source.provider==='codex'?'sessions':'projects',source.sessionId+'.jsonl')+'#'+nativeInputId};};
 const issuer=make(peers[1],{kind:'issue'});await capturePairIntent(c,issuer,deps);const invitation=await issueCode(c,issuer.intentId,deps),redeemer=make(peers[0],{kind:'redeem',target:'claude',code:invitation.code});await capturePairIntent(c,redeemer,deps);
 return {root,c,clock,peers,sent,services,deps,make,issuer,invitation,redeemer,file:path.join(c.installRoot,'pairing','state.json')};
}
export async function stageNativeCommand(f:any,source:Candidate,prompt:string){
 const input=randomUUID(),file=path.join(f.c.home,source.provider==='codex'?'.codex':'.claude',source.provider==='codex'?'sessions':'projects',source.sessionId+'.jsonl'),stamp=new Date(f.clock.value).toISOString();
 const rows=source.provider==='codex'?[{type:'session_meta',payload:{id:source.sessionId,source:'vscode',cwd:source.workspaceRoot}},{type:'event_msg',payload:{type:'task_started',turn_id:input,turn_attribution:{turn_id:input,turn_trigger:'composer',parent_turn_id:null,initiating_agent_path:null,root_turn_id:input}}},{type:'turn_context',payload:{turn_id:input,cwd:source.workspaceRoot}},{type:'response_item',timestamp:stamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}}]:[{type:'user',sessionId:source.sessionId,promptId:input,isSidechain:false,origin:{kind:'human'},cwd:source.workspaceRoot,timestamp:stamp,message:{content:prompt}}];
 await mkdir(path.dirname(file),{recursive:true});await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return stagePairRequest(f.c,source.provider,{hook_event_name:'UserPromptSubmit',session_id:source.sessionId,turn_id:input,prompt_id:input,prompt,cwd:source.workspaceRoot,transcript_path:file},f.deps);
}
