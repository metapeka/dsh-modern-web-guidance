import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("audit/repro/corpus/scan-results.json","utf8"));
for (const id of ["script-tag","iframe-tag"]) {
  const hits = r.hits.filter(h=>h.id===id);
  console.log(`\n== ${id}: ${hits.length} total, outside code fence: ${hits.filter(h=>!h.inCode).length}`);
  for (const h of hits.filter(h=>!h.inCode).slice(0,10)) console.log(`  ${h.file}:${h.line} :: ${(h.match||"").slice(0,90)}`);
}
