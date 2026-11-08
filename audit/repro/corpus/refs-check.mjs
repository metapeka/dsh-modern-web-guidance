import { readFileSync, existsSync } from "node:fs";
const files = ["data/skills/chrome-extensions/SKILL.md","data/skills/modern-web-guidance/SKILL.md"];
const refs = new Set();
for (const f of files) {
  const t = readFileSync(f,"utf8");
  for (const m of t.matchAll(/`(references\/[^`]+)`|\((references\/[^)]+)\)/g)) refs.add((m[1]||m[2]).replace(/[),.;]+$/,""));
}
console.log("distinct references/ paths cited:", refs.size);
let missing = 0;
for (const r of refs) { if (!existsSync("data/skills/chrome-extensions/"+r)) { missing++; console.log("  MISSING:", r); } }
console.log("missing cited reference files:", missing);
// also check references cited without the references/ prefix (e.g. extensions/popup-ui.md)
const bare = new Set();
for (const f of files) {
  const t = readFileSync(f,"utf8");
  for (const m of t.matchAll(/`((?:extensions|webstore)\/[a-z0-9-]+\.md)`/g)) bare.add(m[1]);
}
let miss2=0;
for (const b of bare) if(!existsSync("data/skills/chrome-extensions/references/"+b)){miss2++;console.log("  MISSING bare ref:",b);}
console.log("bare (extensions|webstore)/x.md refs:", bare.size, "missing:", miss2);
// final numbers for the report
console.log("\n--- report numbers ---");
console.log("guide md files:", 193, "| index entries:", JSON.parse(readFileSync("data/guides.json","utf8")).length);
console.log("chrome-ext files:", 25, "| corpus files total:", 220);
