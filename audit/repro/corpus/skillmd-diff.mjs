import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("audit/repro/corpus/provenance-results.json","utf8"));
const d = r.diffs["data/skills/modern-web-guidance/SKILL.md"];
const heads = (sign) => d.filter(l=>l[0]===sign && /^[-+]#{1,4}\s|^[-+]###?\s/.test(l)).map(l=>`${l[0]} ${l.slice(1).trim()}`);
console.log("removed headings:"); for(const h of heads("-")) console.log("  "+h);
console.log("added headings:"); for(const h of heads("+")) console.log("  "+h);
console.log("\nremoved lines mentioning npx/network/approval:");
for(const l of d.filter(l=>l[0]==="-" && /npx|pnpx|network|approval|allowlist|npm/i.test(l))) console.log("  "+l.slice(1,150));
