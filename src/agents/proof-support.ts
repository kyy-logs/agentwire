import path from 'node:path';
function nativePath(file:string){return /^\\\\\?\\[A-Za-z]:\\/.test(file)?file.slice(4):file;}
export function samePath(a:unknown,b:string){return typeof a==='string'&&path.isAbsolute(a)&&path.relative(path.resolve(nativePath(a)),path.resolve(nativePath(b)))==='';}
