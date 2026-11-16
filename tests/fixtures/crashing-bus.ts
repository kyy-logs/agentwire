import path from 'node:path';
import {appendFile} from 'node:fs/promises';
import {startMain} from '../../src/main.ts';
const [root,mode]=process.argv.slice(2);
if(!root||!path.basename(root).startsWith('localbus-test-'))throw Error('unsafe_fixture_root');
const adapters=['codex','claude'].map(kind=>({
  kind,probe:async()=>({status:'available' as const,details:[]}),
  submit:async(_b:any,m:any)=>{await appendFile(path.join(root,'fixture-submit-count.txt'),m.messageId+'\n');process.send?.({submitting:m.messageId});if(mode==='hold')await new Promise(()=>{});return {status:'accepted' as const};},
  reconcile:async()=>({status:'unknown' as const})
}));
await startMain(root,{adapters,intervalMs:20,signals:false,quiet:true});process.send?.({ready:true});
