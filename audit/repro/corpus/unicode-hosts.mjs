import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
function walk(d,a=[]){for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())walk(p,a);else a.push(p);}return a;}
const files=[...walk("data/guides"),...walk("data/skills"),join("data","guides.json")];
const hosts=new Map(); const nonAscii=new Map(); const scripts=new Map();
for(const f of files){
  const t=readFileSync(f,"utf8");
  for(const m of t.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)){ const h=m[1].toLowerCase(); hosts.set(h,(hosts.get(h)||0)+1); }
  for(const ch of t){ const c=ch.codePointAt(0); if(c>127){ nonAscii.set(ch,(nonAscii.get(ch)||0)+1); } }
}
console.log("distinct hosts:",hosts.size);
console.log([...hosts.entries()].sort((a,b)=>b[1]-a[1]).map(([h,n])=>`  ${h.padEnd(36)} ${n}`).join("\n"));
console.log("\ndistinct non-ASCII chars:",nonAscii.size);
const byScript=(ch)=>{const c=ch.codePointAt(0);
  if(c>=0x0400&&c<=0x04ff)return "cyrillic"; if(c>=0x0370&&c<=0x03ff)return "greek";
  if(c>=0x0590&&c<=0x05ff)return "hebrew"; if(c>=0x0600&&c<=0x06ff)return "arabic";
  if(c>=0x4e00&&c<=0x9fff)return "cjk"; if(c>=0xac00&&c<=0xd7af)return "hangul";
  if(c>=0x3040&&c<=0x30ff)return "kana"; if(c>=0xff00&&c<=0xffef)return "fullwidth";
  if(c>=0x2000&&c<=0x206f)return "punct-n"; if(c>=0x2190&&c<=0x21ff)return "arrows";
  if(c>=0x1f300&&c<=0x1faff)return "emoji"; return "other";
};
for(const [ch,n] of nonAscii){ const s=byScript(ch); scripts.set(s,(scripts.get(s)||0)+n); }
console.log("by script:",JSON.stringify([...scripts.entries()].sort((a,b)=>b[1]-a[1])));
console.log("non latin/greek/cyrillic/punct samples:");
for(const [ch,n] of [...nonAscii.entries()].filter(([ch])=>["other","emoji","cjk","hebrew","arabic","hangul","kana","fullwidth"].includes(byScript(ch))).slice(0,40)) console.log(`  U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")} ${JSON.stringify(ch)} x${n}`);
console.log("\nbinary/asset files shipped under data:", files.filter(f=>!/\.(md|json|txt)$/i.test(f)).join(", ")||"none");
console.log("all shipped data extensions:",[...new Set(files.map(f=>f.slice(f.lastIndexOf(".")).toLowerCase()))].join(","));
