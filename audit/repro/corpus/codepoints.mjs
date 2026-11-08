import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
function walk(d,a=[]){for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())walk(p,a);else a.push(p);}return a;}
const files=[...walk("data/guides"),...walk("data/skills"),join("data","guides.json")];
const m=new Map();
for(const f of files){const t=readFileSync(f,"utf8");for(const ch of t){const c=ch.codePointAt(0);if(c>127)m.set(c,(m.get(c)||0)+1);}}
for(const [c,n] of [...m.entries()].sort((a,b)=>a[0]-b[0])){
  const inPunct=c>=0x2000&&c<=0x206f;
  const sep=[0x2028,0x2029,0x00a0,0x3000,0x1680,0x202f,0x205f].includes(c);
  console.log(`U+${c.toString(16).toUpperCase().padStart(4,"0")} ${JSON.stringify(String.fromCodePoint(c))} x${n}${sep?"  <-- SPACE/SEPARATOR":""}`);
}
// URLs of interest
const all=new Set();
for(const f of files){const t=readFileSync(f,"utf8");for(const u of t.matchAll(/https?:\/\/[^\s)\]"\'<>`]+/g))all.add(u[0]);}
for(const u of ["raw.githubusercontent.com","miunau.com","cloudfour.com"]) for(const x of all) if(x.includes(u)) console.log("URL:",x);
