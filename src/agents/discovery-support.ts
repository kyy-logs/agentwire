import {open,opendir} from 'node:fs/promises';
import {assertId} from '../model.ts';
export async function boundedBytes(file:string,tail=false){const h=await open(file,'r');try{const size=(await h.stat()).size,n=Math.min(size,262144),b=Buffer.alloc(n);await h.read(b,0,n,tail?size-n:0);const text=b.toString('utf8');return tail&&size>n?text.slice(text.indexOf('\n')+1):text;}finally{await h.close();}}
export async function names(dir:string,limit:number,strict=false){const out:string[]=[];let d;try{d=await opendir(dir);}catch(e:any){if(e.code==='ENOENT')return out;throw e;}try{for await(const entry of d){if(entry.isFile()&&!entry.isSymbolicLink())out.push(entry.name);if(strict&&out.length>limit)throw Error('discovery_limit');if(!strict&&out.length>=limit)break;}}finally{await d.close().catch(()=>{});}return out;}
export function idValid(id:string){try{assertId(id);return true;}catch{return false;}}
