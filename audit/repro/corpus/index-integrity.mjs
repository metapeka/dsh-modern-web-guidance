import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const idx = JSON.parse(readFileSync("data/guides.json","utf8"));
const missing = [], dup = new Set(), seen = new Set();
for (const e of idx) {
  if (seen.has(e.id)) dup.add(e.id); seen.add(e.id);
  const p = join("data/guides", e.category, e.id + ".md");
  if (!existsSync(p)) missing.push(`${e.category}/${e.id} -> ${p}`);
}
console.log("index entries:", idx.length, "unique ids:", seen.size, "dups:", dup.size);
console.log("index entries whose .md is MISSING:", missing.length);
for (const m of missing) console.log("  " + m);
const hasPromptApi = idx.find(e=>e.id==="prompt-api");
console.log("guides.json contains id 'prompt-api':", !!hasPromptApi, hasPromptApi?JSON.stringify(hasPromptApi).slice(0,160):"");
const hasLM = idx.find(e=>e.id==="language-model");
console.log("guides.json contains id 'language-model':", !!hasLM, hasLM?hasLM.category:"");
// extra files with no index entry
import { readdirSync } from "node:fs";
const byCat = {};
for (const e of idx) (byCat[e.category] ??= new Set()).add(e.id);
const extra=[];
for (const cat of Object.keys(byCat)) {
  for (const f of readdirSync(join("data/guides",cat))) {
    const id=f.replace(/\.md$/,"");
    if(!byCat[cat].has(id)) extra.push(`${cat}/${f}`);
  }
}
console.log("guide files with NO index entry:", extra.length, extra.join(", ")||"");
