import test from 'node:test';import assert from 'node:assert/strict';
import {pairingFixture,stageNativeCommand} from '../pairing-helpers.ts';
import {readPairState} from '../../src/pairing/store.ts';
const api:any=await import('../../src/pairing/executor.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('program executor issues a real code without a model tool and reuses the same invitation',async t=>{
 const f=await pairingFixture(t),id=await stageNativeCommand(f,f.peers[1],'生成连接码');assert.equal(typeof api.executePairRequest,'function');const a=await api.executePairRequest(f.c,id,f.deps),b=await api.executePairRequest(f.c,id,f.deps);assert.equal(a.ok,true);assert.equal(a.phase,'code_issued');assert.equal(a.data.code,b.data.code);assert.equal((await readPairState(f.c)).invitations.filter(i=>i.issueIntentId===a.intentId).length,1);assert.equal(f.sent.length,0);
});
test('program executor redeems using exact native input and is idempotent after activation',async t=>{
 const f=await pairingFixture(t),id=await stageNativeCommand(f,f.peers[0],'连接 Claude，连接码 '+f.invitation.code);assert.equal(typeof api.executePairRequest,'function');const a=await api.executePairRequest(f.c,id,f.deps),b=await api.executePairRequest(f.c,id,f.deps);assert.equal(a.ok,true);assert.equal(a.data.connection.connectionId,b.data.connection.connectionId);assert.equal((await readPairState(f.c)).activations.length,1);assert.equal(f.sent.length,0);
});
