import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("audit/repro/corpus/scan-results.json","utf8"));
const outside = r.hits.filter(h=>!h.inCode && ["script-tag","iframe-tag","on-handler","js-uri","eval","data-uri"].includes(h.id));
console.log("outside-fence HTML-ish hits:", outside.length);
const seen=new Set();
for (const h of outside) {
  if (seen.has(h.file+h.line)) continue; seen.add(h.file+h.line);
  const line = readFileSync(h.file,"utf8").split(/\r?\n/)[h.line-1];
  const t = line.trim();
  console.log(`${h.file}:${h.line} [${h.id}] :: ${t.slice(0,160)}`);
}
