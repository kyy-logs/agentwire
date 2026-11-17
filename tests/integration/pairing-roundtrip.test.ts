import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
import {startMain} from '../../src/main.ts';
import {runLabus} from '../../src/labus.ts';
import {routeHook} from '../../src/installation/hook-router.ts';
import {envelope} from '../../src/envelope.ts';

for(const reverse of [false,true])test((reverse?'Claude':'Codex')+' native-shaped pairing -> explicit task -> exact auto result -> followup without probes',async t=>{
 const f=await pairingFixture(t);f.clock.value=Date.now();const nativeRows=new Map(),sent:any[]=[];let main:any;
 const reader={inspect:async(i:any)=>nativeRows.get(i.transportId)||{status:'missing'}};
 f.deps.ensure=async(_c:any,state:string)=>{if(!main){const adapters=['codex','claude'].map(kind=>({kind,probe:async()=>({status:'available',details:[]}),reconcile:async()=>({status:'unknown'}),submit:async(b:any,m:any,o:any)=>{
  assert.ok(o.transportId);sent.push(m);const execution=randomUUID(),ref={provider:kind,sessionId:b.sessionId,nativeExecutionId:execution},body=m.kind==='followup'?'fixture review result 2':'fixture review result 1';
  nativeRows.set(o.transportId,{status:'mapped',identity:{...ref,transportId:o.transportId,evidenceRef:'fixture-native-input'},terminal:{ref,nativeOutcome:'response_ended',body,evidenceRef:'fixture-native-final',backgroundPending:false,continuation:false,incomplete:false}});
  if(m.kind!=='reply'){const event={session_id:b.sessionId,...(kind==='codex'?{turn_id:execution}:{prompt_id:execution})};await routeHook(f.c,kind as any,[Buffer.from(JSON.stringify({...event,hook_event_name:'UserPromptSubmit',prompt:envelope(m)}))]);await routeHook(f.c,kind as any,[Buffer.from(JSON.stringify({...event,hook_event_name:'Stop',last_assistant_message:body}))]);}return {status:'accepted'};}}));
  main=await startMain(state,{connectionId:path.basename(path.dirname(state)),newAutoWireVersion:'clean-v1',native:{client:{call:async()=>{throw Error('not_expected')},close:async()=>{}},readers:{codex:reader,claude:reader}},quiet:true,intervalMs:0,adapters:adapters as any});t.after(()=>main.close());}return {instanceId:'fixture',pid:process.pid,stateRoot:state};};
 const issuer=f.peers[reverse?0:1],source=f.peers[reverse?1:0],call=async(args:string[])=>{let out='';const exit=await runLabus(args,{stdout:{write(s:string){out+=s;}},stderr:{write(){}}},{context:f.c,env:{CODEX_THREAD_ID:source.sessionId},connectionDeps:f.deps});assert.equal(exit,0,out);return JSON.parse(out);};
 const issue=await call(['pair','issue','--intent',(await stageNativeCommand(f,issuer,'生成连接码'))!]);await call(['pair','redeem','--intent',(await stageNativeCommand(f,source,`连接 ${issuer.provider==='codex'?'Codex':'Claude'}，连接码 ${issue.data.code}`))!]);assert.equal(sent.length,0);assert.equal((await main.bus.store.list()).length,0);
 const sourceArgs=['--provider',source.provider,...(source.provider==='claude'?['--source-session',source.sessionId]:[])],asked=await call(['ask',...sourceArgs,'--text','fixture review first']);
 const pump=async()=>{await main.bus.tick();await main.lifecycle.drain();await main.clean.drain();await main.bus.tick();await main.bus.tick();};await pump();
 const first=await main.bus.store.get(asked.data.messageId),result=await main.bus.store.get(first.resultRef);assert.equal(first.state,'completed');assert.equal(result.state,'delivered');assert.ok(result.message.body.includes('fixture review result 1'));
 const status=await call(['pair','status']),direction=reverse?'claude_to_codex':'codex_to_claude';assert.equal(status.data.health.roundtrip[direction].status,'observed');
 const next=await call(['followup',...sourceArgs,'--reply-to',first.resultRef,'--text','fixture review next']);await pump();const second=await main.bus.store.get(next.data.messageId);assert.equal(second.state,'completed');assert.ok((await main.bus.store.get(second.resultRef)).message.body.includes('fixture review result 2'));assert.equal(sent.filter(m=>m.kind!=='reply').length,2);
 for(const m of sent)assert.ok(!m.body.includes('LOCALBUS-CONNECT'));
});
