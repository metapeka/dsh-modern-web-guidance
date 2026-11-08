import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const ROOT=".";
function walk(d,a=[]){for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())walk(p,a);else a.push(p);}return a;}
const files=walk("data/guides");
// collect HTML comments and see whether any contain imperative/instruction-like text
const commentRe=/<!--([\s\S]*?)-->/g;
const rows=[];
for(const f of files){
  const t=readFileSync(f,"utf8");
  for(const m of t.matchAll(commentRe)){
    const body=m[1].replace(/\s+/g," ").trim();
    const before=t.slice(0,m.index);
    const line=before.split("\n").length;
    rows.push({f,line,body});
  }
}
console.log("total HTML comments:",rows.length);
const suspicious=rows.filter(r=>/ignore|instruction|prompt|system|you (must|should)|always|never|secret|hidden|agent|assistant|model|todo|fixme|important/i.test(r.body));
console.log("comments with instruction-ish words:",suspicious.length);
for(const r of suspicious.slice(0,25)) console.log(`  ${r.f}:${r.line} :: ${r.body.slice(0,140)}`);
// distinct comment bodies sample
const uniq=[...new Set(rows.map(r=>r.body))];
console.log("\ndistinct comment bodies:",uniq.length);
for(const u of uniq.slice(0,18)) console.log("  - "+u.slice(0,120));
