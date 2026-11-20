import path from 'node:path';
import type {AgentIntegration,PairProof} from './model.ts';
import {boundedBytes,names,idValid} from './discovery-support.ts';
import {safePath} from '../installation/paths.ts';
import {samePath} from './proof-support.ts';
function plainText(r:any):string|undefined{
 const value=r.message?.content;
 if(typeof value==='string')return value;
 if(Array.isArray(value)&&value.length>0&&value.every(b=>b?.type==='text'&&typeof b.text==='string'))return value.map(b=>b.text).join('');
}
function nativeSkillCompanion(rows:any[],r:any,e:any):boolean{
 // Claude persists Skill contents as a user-shaped text companion. Exclude it
 // only with native flags AND the exact parent result -> Skill call lineage;
 // neither its text nor a missing human origin alone is evidence of metadata.
 if(r.isMeta!==true||r.turnCompanion!==true||r.isSidechain!==false||r.origin!==undefined||r.agentId!==undefined||typeof r.sourceToolUseID!=='string'||!r.sourceToolUseID||typeof r.parentUuid!=='string')return false;
 const parents=rows.filter(p=>p.uuid===r.parentUuid);if(parents.length!==1)return false;const p=parents[0];
 if(p.type!=='user'||p.sessionId!==e.session_id||p.promptId!==e.prompt_id||p.isSidechain!==false||p.agentId!==undefined||typeof p.sourceToolAssistantUUID!=='string'||!Array.isArray(p.message?.content)||!p.message.content.some((b:any)=>b?.type==='tool_result'&&b.tool_use_id===r.sourceToolUseID))return false;
 const calls=rows.filter(a=>a.uuid===p.sourceToolAssistantUUID);if(calls.length!==1)return false;const a=calls[0];
 return a.type==='assistant'&&a.sessionId===e.session_id&&a.isSidechain===false&&a.agentId===undefined&&Array.isArray(a.message?.content)&&a.message.content.filter((b:any)=>b?.type==='tool_use'&&b.id===r.sourceToolUseID&&b.name==='Skill').length===1;
}
function proveClaude(rows:any[],e:any):PairProof|undefined{
 // Tool continuations and proven native Skill companions share promptId.
 const roots=rows.filter(r=>r?.type==='user'&&r.sessionId===e.session_id&&r.promptId===e.prompt_id&&plainText(r)!==undefined&&!nativeSkillCompanion(rows,r,e));
 if(roots.length!==1)return;const r=roots[0];
 if(r.isSidechain!==false||r.origin?.kind!=='human'||r.agentId)return;
 if(plainText(r)!==e.prompt||!samePath(r.cwd,e.cwd)||typeof r.timestamp!=='string')return;
 return {timestamp:r.timestamp,cwd:r.cwd};
}

export const claude:AgentIntegration=Object.freeze<AgentIntegration>({
 provider:'claude',sessionEnv:'CLAUDE_SESSION_ID',allowSkillSession:true,
 executionIdField:'prompt_id',transcriptDirectory:'.claude/projects',sessionNamedTranscript:true,
 acceptsLifecycleAgentType:(value)=>!value||value==='claude',
 provePairInput:proveClaude,
 async discover(c,sessionId){const provider='claude' as const,out:import('../installation/model.ts').Candidate[]=[];
const dir=path.join(c.home,'.claude','sessions');for(const name of (await names(dir,2000,sessionId!==undefined)).filter(x=>/^\d+\.json$/.test(x))){try{const file=await safePath(c.home,path.join(dir,name)),r=JSON.parse(await boundedBytes(file));if(!idValid(r.sessionId)||sessionId!==undefined&&r.sessionId!==sessionId||r.pid+'.json'!==name||!Number.isInteger(r.pid)||!path.isAbsolute(r.cwd||''))continue;try{process.kill(r.pid,0);}catch{continue;}out.push({provider,sessionId:r.sessionId,workspaceRoot:r.cwd,...(typeof r.name==='string'?{title:r.name.slice(0,120)}:{}),...(typeof r.updatedAt==='string'?{lastActiveAt:r.updatedAt}:{}),availability:'live_endpoint'});}catch{}}return sessionId!==undefined?out:out.slice(0,20);
 },
 async createRuntime(o){
  const [{ClaudeAdapter,resolveClaude,postClaude},{createClaudeEvidence}]=await Promise.all([import('../adapters/claude.ts'),import('../native/claude-evidence.ts')]);
  return {adapter:new ClaudeAdapter({resolve:resolveClaude,post:postClaude,command:o.command,observe:async(b,r)=>{
   for(let i=0;i<8;i++){const result=await o.observe(b,r);if(result.status==='submitted')return result;if(i<7)await new Promise(done=>setTimeout(done,200));}return {status:'unknown'};
  }}),reader:createClaudeEvidence({claudeHome:path.join(o.home,'.claude')})};
 }
});
