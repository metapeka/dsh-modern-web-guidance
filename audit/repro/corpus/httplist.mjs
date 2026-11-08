import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("audit/repro/corpus/scan-results.json","utf8"));
console.log("plain-http hits:", r.nonHttps.length);
for(const n of r.nonHttps) console.log(`  ${n.file}:${n.line}  ${n.url}`);
