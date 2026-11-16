// A test-owned native-pipe protocol fixture, never a real Claude process.
import net from 'node:net';
import path from 'node:path';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
const [home,sessionId]=process.argv.slice(2);
if(!home||!sessionId||!path.basename(home).startsWith('localbus-test-'))throw Error('unsafe_fixture_home');
const token=randomBytes(32).toString('hex');
const socket=process.platform==='win32'?`\\\\.\\pipe\\claude-fixture-${randomUUID()}`:path.join(home,randomUUID()+'.sock');
const dir=path.join(home,'sessions'),project=path.join(home,'projects','fixture');await mkdir(dir,{recursive:true});await mkdir(project,{recursive:true});
const server=net.createServer(s=>{
  let buffer='',authenticated=false,chain=Promise.resolve();s.setEncoding('utf8');s.on('error',()=>{});
  s.on('data',chunk=>{buffer+=chunk;let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    chain=chain.then(async()=>{const frame=JSON.parse(line);if(!authenticated){authenticated=frame.type==='auth'&&frame.token===token;return;}
      if(frame.type==='user'&&typeof frame.message?.content==='string')await appendFile(path.join(project,sessionId+'.jsonl'),JSON.stringify({type:'user',sessionId,uuid:randomUUID(),timestamp:new Date().toISOString(),message:frame.message})+'\n');
    }).catch(()=>s.destroy());
  }});
  s.on('end',()=>{void chain.finally(()=>s.end());});
});
await new Promise<void>(resolve=>server.listen(socket,resolve));
await writeFile(path.join(dir,process.pid+'.fixture.key'),JSON.stringify({peerToken:token}));
await writeFile(path.join(dir,process.pid+'.json'),JSON.stringify({pid:process.pid,sessionId,messagingSocketPath:socket}));
process.send?.({ready:true,pid:process.pid});
process.on('message',m=>{if(m==='stop'){server.close(()=>process.exit(0));}});
