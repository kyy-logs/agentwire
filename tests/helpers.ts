import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function temp(t: any) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'localbus-test-'));
  t.after(async()=>{
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('localbus-test-'))throw new Error('Unsafe test cleanup');
    await rm(dir,{recursive:true,force:true});
  });
  return dir;
}
export const clock=()=>({value:Date.parse('2026-11-15T14:00:00Z'),now(){return new Date(this.value);}});
export const taskInput=(extra={})=>({messageId:randomUUID(),kind:'task' as const,from:'codex',to:'claude',body:'审查 "hello"\n` $() 🌊',...extra});
