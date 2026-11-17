import {assertId} from '../model.ts';
import path from 'node:path';
import {unlink,readFile} from 'node:fs/promises';
import {startMain} from '../main.ts';
import {safePath} from './paths.ts';
const [stateRoot,installRoot]=process.argv.slice(2);if(!stateRoot||!installRoot)throw Error('invalid_arguments');
await safePath(path.join(installRoot,'connections'),stateRoot);
const connectionId=path.basename(path.dirname(path.resolve(stateRoot)));assertId(connectionId);if(path.basename(path.resolve(stateRoot))!=='state')throw Error('invalid_state_root');const record=JSON.parse(await readFile(path.join(path.dirname(stateRoot),'connection.json'),'utf8'));if(record.connectionId!==connectionId||![1,2].includes(record.schemaVersion))throw Error('connection_context_mismatch');
// Preserve the legacy bootstrap context contract. New identity-paired runtime
// additionally requires a complete valid schema-2 connection record.
if(record.schemaVersion===2){const {readConnection}=await import('./connections.ts');await readConnection({installRoot,home:'',sourceRoot:'',nodeExe:process.execPath},connectionId);}
await startMain(stateRoot,{connectionId,newAutoWireVersion:'clean-v1'});
// No separate daemon loop: the existing Bus timer owns process lifetime.
process.once('beforeExit',async()=>{const marker=path.join(installRoot,'install','runtime-active.json');try{const h=JSON.parse(await readFile(marker,'utf8'));if(h.pid===process.pid)await unlink(marker);}catch{}});
