import {randomUUID} from 'node:crypto';
import {LocalBus} from '../src/bus.ts';
import {FileMessageStore} from '../src/store.ts';
import {FileLifecycleStore} from '../src/lifecycle/store.ts';
import {LifecycleProcessor} from '../src/lifecycle/processor.ts';
import {normalizeHook} from '../src/lifecycle/normalize.ts';
import {envelope} from '../src/envelope.ts';
import {temp,clock,taskInput} from './helpers.ts';
export async function lifecycleFixture(t:any){
 const root=await temp(t),time=clock(),store=new FileMessageStore(root,time),lifecycle=new FileLifecycleStore(root),sent:any[]=[];
 const bindings=['codex','claude'].map(agentId=>({agentId,kind:agentId as 'codex'|'claude',sessionId:randomUUID(),workspaceRoot:root}));
 const adapters=bindings.map(b=>({kind:b.kind,probe:async()=>({status:'available' as const,details:[]}),submit:async(_b:any,m:any,options:any)=>{sent.push({m,options});return {status:'accepted' as const};},reconcile:async()=>({status:'unknown' as const})}));
 const bus=new LocalBus({store,bindings,adapters,clock:time}),processor=new LifecycleProcessor(bus,lifecycle);
 const task=await bus.accept(taskInput({returnMode:'auto'}) as any);await bus.tick();const native=randomUUID(),x=sent[0];
 const begin=normalizeHook('claude',{session_id:bindings[1].sessionId,prompt_id:native,hook_event_name:'UserPromptSubmit',prompt:envelope(x.m,undefined,x.options)})!;
 const terminal=(raw:any={})=>normalizeHook('claude',{session_id:bindings[1].sessionId,prompt_id:native,hook_event_name:'Stop',last_assistant_message:'computed 667',...raw})!;
 const replies=async()=> (await store.list()).filter(r=>r.message.kind==='reply'&&r.message.replyTo===task.message.messageId);
 return {root,time,store,lifecycle,sent,bus,processor,task,begin,terminal,replies,bindings};
}
