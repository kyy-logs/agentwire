import path from 'node:path';import {mkdir,mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';import {spawn} from 'node:child_process';
import {atomicBytes,jsonBytes} from '../installation/paths.ts';import {automationPath} from './jobs.ts';
import {spawnBackground} from '../installation/service.ts';import type {InstallContext} from '../installation/model.ts';
/** A detached Node child still inherits a Windows Job Object. Explicit
 * BREAKAWAY is permitted only when the owning job allows it; otherwise fail
 * closed. Never fall back to WMI, a scheduled task, elevation or another user. */
export async function spawnPairWorker(c:InstallContext):Promise<{pid:number}>{
 const entry=path.join(c.installRoot,'runtime','src','pairing','worker.ts');
 if(process.platform!=='win32')return spawnBackground(c.nodeExe,['--experimental-strip-types',entry,'--root',c.installRoot],{out:path.join(c.installRoot,'logs/pair-worker.stdout.log'),err:path.join(c.installRoot,'logs/pair-worker.stderr.log')});
 for(const value of [c.nodeExe,c.installRoot])if(!path.isAbsolute(value)||/[\0\r\n]/.test(value))throw Error('pair_worker_launch_invalid');
 const quote=(s:string)=>'"'+s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\*)$/,'$1$1')+'"';
 const command=[c.nodeExe,'--experimental-strip-types',entry,'--root',c.installRoot].map(quote).join(' ');
 if(command.length>=32767)throw Error('pair_worker_launch_invalid');
 await mkdir(path.join(c.installRoot,'pairing'),{recursive:true});const launchDir=await mkdtemp(path.join(c.installRoot,'pairing','launch-'));const receipt=path.join(launchDir,'receipt.json'),permit=path.join(launchDir,'resume');
 const deadline=Date.now()+3000,request=path.join(launchDir,'request.json');await writeFile(request,JSON.stringify({exe:c.nodeExe,command,cwd:c.installRoot,receipt,permit,deadline}),{mode:0o600});
 const data=Buffer.from(JSON.stringify({script:path.join(c.installRoot,'runtime/src/pairing/launch-worker.ps1'),request})).toString('base64');
 const script=`$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json; & ([scriptblock]::Create([IO.File]::ReadAllText($d.script))) -Request $d.request`;
 const windows=process.env.SystemRoot||'C:\\Windows',cmd=path.join(windows,'System32/cmd.exe'),ps=path.join(windows,'System32/WindowsPowerShell/v1.0/powershell.exe');
 if(!path.isAbsolute(windows)||/[\"\0\r\n]/.test(windows))throw Error('pair_worker_launch_invalid');
 const shellCommand='""'+ps+'" -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(script,'utf16le').toString('base64')+'"';
 if(shellCommand.length>8000)throw Error('pair_worker_launch_invalid');
 // Detached cmd avoids libuv's additional SILENT_BREAKAWAY job. The fixed
 // PowerShell child retains the native Hook job's breakaway policy. Direct
 // detached powershell.exe can exit without executing when it has no console.
 const run=()=>new Promise<void>((resolve,reject)=>{
  const child=spawn(cmd,['/d','/s','/c',shellCommand],{cwd:windows,detached:true,windowsHide:true,windowsVerbatimArguments:true,stdio:'ignore'});
  const timer=setTimeout(()=>{child.kill();reject(Error('helper_timeout'));},3500);
  child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('helper_failed'));});
 });
 let ended=false;const completion=run().finally(()=>{ended=true;});completion.catch(()=>{});
 let createdPid:number|undefined;
 try{
  while(Date.now()<deadline){try{const r=JSON.parse(await readFile(receipt,'utf8'));if(Number.isSafeInteger(r.pid)&&r.pid>0){createdPid=r.pid;break;}}catch{}if(ended)break;await new Promise(r=>setTimeout(r,20));}
  if(!createdPid)throw Error('receipt_missing');
  // schedulePairWorker holds both admission locks. Never permit native code to
  // run before its exact PID is durably visible to install/uninstall guards.
  await atomicBytes(await automationPath(c,'worker.json'),jsonBytes({schemaVersion:1,pid:createdPid,phase:'starting'}));
  await writeFile(permit,'resume',{flag:'wx',mode:0o600});await completion;return {pid:createdPid};
 }catch{throw Object.assign(Error('pair_worker_launch_unconfirmed'),{startedPid:createdPid});}finally{await unlink(permit).catch(()=>{});await unlink(request).catch(()=>{});await unlink(receipt).catch(()=>{});await rmdir(launchDir).catch(()=>{});}
}
