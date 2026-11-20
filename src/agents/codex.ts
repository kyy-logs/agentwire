import path from 'node:path';
import type {AgentIntegration,PairProof} from './model.ts';
import {boundedBytes,names,idValid} from './discovery-support.ts';
import {safePath} from '../installation/paths.ts';
import {samePath} from './proof-support.ts';
function proveCodex(rows:any[],e:any):PairProof|undefined{
 const metas=rows.filter(r=>r?.type==='session_meta'&&r.payload?.id===e.session_id);
 if(metas.length!==1)return;const meta=metas[0].payload;
 if(!['vscode','cli'].includes(meta.source))return;
 let turn:string|undefined;const starts:any[]=[],inputs:any[]=[],contexts:any[]=[];
 for(const r of rows){const p=r?.payload??{};
 if(r.type==='event_msg'&&p.type==='task_started'){turn=p.turn_id;if(turn===e.turn_id)starts.push(p);}
 if(r.type==='turn_context'&&typeof p.turn_id==='string')turn=p.turn_id;
 if(turn!==e.turn_id)continue;
 if(r.type==='turn_context')contexts.push(p);
 if(r.type==='response_item'&&p.type==='message'&&p.role==='user'&&Array.isArray(p.content)&&p.content.length===1&&p.content[0]?.type==='input_text'&&p.content[0].text===e.prompt)inputs.push(r);
 }
 if(starts.length!==1||inputs.length!==1)return;const a=starts[0].turn_attribution;
 if(!a||a.turn_id!==e.turn_id||a.turn_trigger!=='composer'||a.parent_turn_id!==null||a.initiating_agent_path!==null||a.root_turn_id!==e.turn_id)return;
 const cwd=contexts.length?contexts.at(-1).cwd:meta.cwd;
 if(!samePath(cwd,e.cwd)||typeof inputs[0].timestamp!=='string')return;
 return {timestamp:inputs[0].timestamp,cwd};
}

export const codex:AgentIntegration=Object.freeze<AgentIntegration>({
 provider:'codex',sessionEnv:'CODEX_THREAD_ID',allowSkillSession:false,
 executionIdField:'turn_id',transcriptDirectory:'.codex/sessions',sessionNamedTranscript:false,
 acceptsLifecycleAgentType:()=>true,
 provePairInput:proveCodex,
 async discover(c,sessionId){const provider='codex' as const,out:import('../installation/model.ts').Candidate[]=[];
 let text;try{text=await boundedBytes(await safePath(c.home,path.join(c.home,'.codex','session_index.jsonl')),true);}catch(e:any){if(e.code==='ENOENT')return [];throw e;}
 const unique=new Map<string,any>(),lines=text.trim().split(/\r?\n/);for(const line of sessionId!==undefined?lines:lines.slice(-200)){try{const r=JSON.parse(line);if(idValid(r.id))unique.set(r.id,r);}catch{}}
 const ordered=[...unique.values()].sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))),rows=sessionId!==undefined?ordered.filter(r=>r.id===sessionId):ordered.slice(0,20),cache=new Map<string,string[]>();
 for(const r of rows){let cwd=typeof r.cwd==='string'?r.cwd:undefined;
 if(!cwd){const ms=Number.parseInt(r.id.replaceAll('-','').slice(0,12),16);const d=new Date(ms);if(Number.isFinite(+d))for(const offset of [0,86400000,-86400000]){const date=new Date(+d+offset).toISOString().slice(0,10).replaceAll('-',path.sep),dir=path.join(c.home,'.codex','sessions',date);let files=cache.get(dir);if(!files){files=await names(dir,2000);cache.set(dir,files);}const file=files.find(n=>n.includes(r.id)&&n.endsWith('.jsonl'));if(!file)continue;try{const first=(await boundedBytes(await safePath(c.home,path.join(dir,file)))).split('\n',1)[0],meta=JSON.parse(first);if(meta.type==='session_meta'&&meta.payload?.id===r.id)cwd=meta.payload.cwd;}catch{}break;}}
 if(typeof cwd!=='string'||!path.isAbsolute(cwd))continue;out.push({provider,sessionId:r.id,workspaceRoot:cwd,...(typeof r.thread_name==='string'?{title:r.thread_name.slice(0,120)}:{}),lastActiveAt:r.updated_at,availability:'candidate'});}
 return out;
 },
 async createRuntime(o){
  const [{CodexAdapter,runChild},{createCodexEvidence}]=await Promise.all([import('../adapters/codex.ts'),import('../native/codex-evidence.ts')]);
  return {adapter:new CodexAdapter(runChild,{exe:o.exe,appServer:o.client,observe:o.observe,command:o.command}),reader:createCodexEvidence(o.client)};
 }
});
