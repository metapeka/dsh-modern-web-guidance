import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const EXCL=["\\.git","\\audit","\\node_modules"];
function walk(d,a=[]){for(const n of readdirSync(d)){const p=join(d,n);if(EXCL.some(x=>p.replaceAll("/","\\").includes(x)))continue;const s=statSync(p);if(s.isDirectory())walk(p,a);else a.push(p);}return a;}
const files=walk(".").filter(f=>/\.(md|json|txt|mjs|js|yml|svg)$/i.test(f)||/(LICENSE|NOTICE)$/.test(f));
const hosts=new Map(), schemes=new Map();
for(const f of files){const t=readFileSync(f,"utf8");
 for(const m of t.matchAll(/\b([a-z][a-z0-9+.-]{1,15}):\/\/([a-z0-9.-]+)/gi)){const s=m[1].toLowerCase();schemes.set(s,(schemes.get(s)||0)+1); if(s==="http"||s==="https"){const h=m[2].toLowerCase();hosts.set(h,(hosts.get(h)||0)+1);}}}
console.log("files:",files.length,"distinct web hosts:",hosts.size);
console.log("schemes:",JSON.stringify([...schemes.entries()].sort((a,b)=>b[1]-a[1])));
console.log("hosts:",[...hosts.keys()].sort().join(", "));
