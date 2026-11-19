import type {CleanTerminalHint} from '../native/model.ts';
import {mkdir,readFile,readdir,stat,rename,unlink} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {atomicJson} from '../store.ts';
import {assertId} from '../model.ts';
import {validateEvent,validateExecution,validateResult,executionKey,eventKey,assertKey,semanticEvent,digest} from './model.ts';
import type {LifecycleEvent,ExecutionRef,ExecutionRecord,CapturedResult} from './model.ts';
export class FileLifecycleStore{
  root:string;hooks:{beforeRename?:()=>Promise<void>};
  constructor(root:string,hooks:{beforeRename?:()=>Promise<void>}={}){this.root=path.join(path.resolve(root),'lifecycle');this.hooks=hooks;}
  file(dir:string,key:string){assertKey(key);return path.join(this.root,dir,key+'.json');}
  async read(file:string){try{if((await stat(file)).size>2*1024*1024)throw new Error('lifecycle_file_too_large');return JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as any).code==='ENOENT')return undefined;throw e;}}
  async files(dir:string){await mkdir(path.join(this.root,dir),{recursive:true});return (await readdir(path.join(this.root,dir))).filter(n=>n.endsWith('.json')).sort();}
  async enqueue(e:LifecycleEvent){validateEvent(e);const file=path.join(this.root,'inbox',e.eventKey+'-'+randomUUID()+'.json');await atomicJson(file,e,this.hooks.beforeRename);return {file};}
  async readInbox(){return (await this.files('inbox')).map(n=>path.join(this.root,'inbox',n));}
  async consumeInbox(file:string){if(path.dirname(file)!==path.join(this.root,'inbox')||!/^(?:[a-f0-9]{64}-)?[-a-f0-9]{36}\.json$/.test(path.basename(file)))throw new Error('invalid_inbox_file');return this.read(file);}
  async findInput(ref:ExecutionRef):Promise<LifecycleEvent|undefined>{
    if(await this.hasConflict(ref)||(await this.getExecution(ref))?.phase==='needs_check')return;
    const key=eventKey(ref,'input');
    const matches=(await this.files('inbox')).filter(n=>n.startsWith(key+'-')||!/^[-a-f0-9]{64}-/.test(n));
    let candidate=await this.getEvent(key);
    for(const name of matches){const e=await this.consumeInbox(path.join(this.root,'inbox',name));validateEvent(e);if(e.eventKey!==key||e.phase!=='input'){if(name.startsWith(key+'-'))throw new Error('invalid_input_filename');continue;}if(candidate&&!isDeepStrictEqual(semanticEvent(candidate),semanticEvent(e)))return;candidate=e;}
    return candidate;
  }
  async removeInbox(file:string){if(path.dirname(file)!==path.join(this.root,'inbox'))throw new Error('invalid_inbox_file');await unlink(file);}
  async quarantine(file:string){if(path.dirname(file)!==path.join(this.root,'inbox'))throw new Error('invalid_inbox_file');await mkdir(path.join(this.root,'quarantine'),{recursive:true});await rename(file,path.join(this.root,'quarantine',randomUUID()+'.json'));}
  async putEvent(e:LifecycleEvent){validateEvent(e);const old=await this.getEvent(e.eventKey);if(old){if(!isDeepStrictEqual(semanticEvent(old),semanticEvent(e)))throw new Error('lifecycle_event_conflict');return {duplicate:true};}await atomicJson(this.file('events',e.eventKey),e,this.hooks.beforeRename);return {duplicate:false};}
  async getEvent(key:string):Promise<LifecycleEvent|undefined>{const e=await this.read(this.file('events',key));if(e){validateEvent(e);if(e.eventKey!==key)throw new Error('invalid_event_filename');}return e;}
  async events(){const out:LifecycleEvent[]=[];for(const n of await this.files('events')){const e=await this.getEvent(n.slice(0,-5));if(e)out.push(e);}return out;}
  async getExecution(ref:ExecutionRef):Promise<ExecutionRecord|undefined>{const e=await this.read(this.file('executions',executionKey(ref)));if(e){validateExecution(e);if(executionKey(e)!==executionKey(ref))throw new Error('invalid_execution_filename');}return e;}
  async bindExecution(e:ExecutionRecord){validateExecution(e);const old=await this.getExecution(e);if(old&&(old.messageId!==e.messageId||old.dispatchNonce!==e.dispatchNonce))throw new Error('execution_binding_conflict');await atomicJson(this.file('executions',executionKey(e)),e,this.hooks.beforeRename);}
  async executions(){const out:ExecutionRecord[]=[];for(const n of await this.files('executions')){const e=await this.read(this.file('executions',n.slice(0,-5)));validateExecution(e);if(executionKey(e)!==n.slice(0,-5))throw new Error('invalid_execution_filename');out.push(e);}return out;}
  resultFile(id:string){assertId(id);return path.join(this.root,'results',id+'.json');}
  async getResult(id:string):Promise<CapturedResult|undefined>{const r=await this.read(this.resultFile(id));if(r){validateResult(r);if(r.messageId!==id||r.sha256!==digest(r.body))throw new Error('invalid_result_artifact');}return r;}
  async saveResult(r:CapturedResult){validateResult(r);const saved={...r,artifactRef:'lifecycle/results/'+r.messageId+'.json',sha256:digest(r.body)};const old=await this.getResult(r.messageId);if(old){if(!isDeepStrictEqual(old,saved))throw new Error('captured_result_conflict');return old;}await atomicJson(this.resultFile(r.messageId),saved,this.hooks.beforeRename);return saved;}
  async isApplied(key:string){return !!await this.read(this.file('applied',key));}
  async markApplied(key:string,review?:{reason:string;proof:unknown}){await atomicJson(this.file('applied',key),{eventKey:key,...review},this.hooks.beforeRename);}
  async markConflict(ref:ExecutionRef,reason:string){await atomicJson(this.file('conflicts',executionKey(ref)),{reason},this.hooks.beforeRename);}
  async hasConflict(ref:ExecutionRef){return !!await this.read(this.file('conflicts',executionKey(ref)));}
  async enqueueCleanHint(h:CleanTerminalHint){validateCleanHint(h);const {observedAt,...semantic}=h;const key=digest(JSON.stringify(semantic));await atomicJson(this.file('clean-hints',key),h,this.hooks.beforeRename);}
  async listCleanHints():Promise<CleanTerminalHint[]>{const out:CleanTerminalHint[]=[];for(const name of await this.files('clean-hints')){const h=await this.read(this.file('clean-hints',name.slice(0,-5)));validateCleanHint(h);out.push(h);}return out;}
  async recover(){return {events:await this.events(),executions:await this.executions(),inbox:await this.readInbox(),quarantined:(await this.files('quarantine')).length};}
}

export function validateCleanHint(h:CleanTerminalHint){if(!h||h.schemaVersion!==1||!['stop','failure','interrupt'].includes(h.phase)||!Number.isFinite(Date.parse(h.observedAt))||!['codex','claude'].includes(h.provider))throw Error('invalid_clean_hint');assertId(h.sessionId);assertId(h.nativeExecutionId);const allowed=['schemaVersion','provider','sessionId','nativeExecutionId','phase','observedAt','backgroundPending','continuation','incomplete','errorCode'];if(Object.keys(h).some(k=>!allowed.includes(k)))throw Error('invalid_clean_hint_fields');for(const k of ['backgroundPending','continuation','incomplete'] as const)if(h[k]!==undefined&&typeof h[k]!=='boolean')throw Error('invalid_clean_hint_flag');}
