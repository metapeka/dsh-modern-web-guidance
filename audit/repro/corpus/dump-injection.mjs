import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("audit/repro/corpus/scan-results.json","utf8"));
for (const h of r.hits.filter(h=>h.area==="injection")) {
  console.log(`--- ${h.sev} ${h.id} ${h.file}:${h.line} inCode=${!!h.inCode}`);
  console.log((h.snippet||"").split("\n").map(l=>"    "+l.slice(0,170)).join("\n"));
}
console.log("\n\n### nonWebScheme / data-uri / base64 / js-uri / on-handler hits");
for (const h of r.hits.filter(h=>["non-web-scheme","data-uri","base64-blob","js-uri","on-handler","eval"].includes(h.id))) {
  console.log(`${h.area}/${h.id} ${h.file}:${h.line} inCode=${!!h.inCode} :: ${(h.match||"").slice(0,110)}`);
}
