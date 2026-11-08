// Provenance: byte/hash compare every shipped file against the upstream extracted tarball.
// Read-only. Prints aggregate counts; full per-file result to provenance-results.json.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const ROOT = "E:/0ai/dsh_mod_1/dsh-modern-web-guidance";
const UP = "E:/0ai/dsh_mod_1/.tmp-mwg/pkg/package";
const OUT = join(ROOT, "audit/repro/corpus");

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const n of entries) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const rel = (base, p) => relative(base, p).replaceAll("\\", "/");

// target path -> upstream path
const pairs = [];
for (const f of walk(join(ROOT, "data/guides"))) pairs.push({ t: f, u: join(UP, "skills/modern-web-guidance/guides", rel(join(ROOT, "data/guides"), f)) });
pairs.push({ t: join(ROOT, "data/guides.json"), u: join(UP, "skills/modern-web-guidance/guides.json") });
for (const f of walk(join(ROOT, "data/skills/chrome-extensions"))) pairs.push({ t: f, u: join(UP, "skills/chrome-extensions", rel(join(ROOT, "data/skills/chrome-extensions"), f)) });
pairs.push({ t: join(ROOT, "data/skills/modern-web-guidance/SKILL.md"), u: join(UP, "skills/modern-web-guidance/SKILL.md") });

// upstream guide files not shipped
const upGuideFiles = walk(join(UP, "skills/modern-web-guidance/guides")).map((p) => rel(join(UP, "skills/modern-web-guidance/guides"), p));
const dataGuideFiles = new Set(walk(join(ROOT, "data/guides")).map((p) => rel(join(ROOT, "data/guides"), p)));
const upOnly = upGuideFiles.filter((g) => !dataGuideFiles.has(g));

const rows = [];
for (const { t, u } of pairs) {
  const tRel = rel(ROOT, t);
  let tBuf, uBuf;
  try { tBuf = readFileSync(t); } catch { rows.push({ file: tRel, status: "MISSING_TARGET", upstream: rel(UP, u) }); continue; }
  try { uBuf = readFileSync(u); } catch { rows.push({ file: tRel, status: "MISSING_UPSTREAM (target file has no upstream counterpart)", upstream: rel(UP, u) }); continue; }
  const th = sha(tBuf), uh = sha(uBuf);
  rows.push({
    file: tRel, upstream: rel(UP, u), bytesT: tBuf.length, bytesU: uBuf.length,
    shaT: th, shaU: uh,
    status: th === uh ? "IDENTICAL" : (tBuf.length === uBuf.length ? "DIFFERS (same length)" : "DIFFERS (same content length differs)"),
  });
}

// LCS line diff for differing files
function lineDiff(a, b, maxLines = 400) {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/);
  const n = Math.min(A.length, maxLines), m = Math.min(B.length, maxLines);
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(" " + A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("-" + A[i]); i++; }
    else { out.push("+" + B[j]); j++; }
  }
  while (i < n) out.push("-" + A[i++]);
  while (j < m) out.push("+" + B[j++]);
  if (A.length > maxLines || B.length > maxLines) out.push(`...(truncated to ${maxLines} lines; total ${A.length} vs ${B.length})`);
  return out;
}

const diffs = {};
for (const r of rows.filter((x) => x.status.startsWith("DIFFERS"))) {
  const t = readFileSync(join(ROOT, r.file));
  const u = readFileSync(join(UP, r.upstream));
  diffs[r.file] = lineDiff(u.toString("utf8"), t.toString("utf8"));
}

// the duplicate-duplicate check: is upstream prompt-api.md byte-identical to language-model.md?
const dupCheck = {};
for (const pair of [["built-in-ai/prompt-api.md", "built-in-ai/language-model.md"]]) {
  const a = join(UP, "skills/modern-web-guidance/guides", pair[0]);
  const b = join(UP, "skills/modern-web-guidance/guides", pair[1]);
  let ah = null, bh = null;
  try { ah = sha(readFileSync(a)); } catch {}
  try { bh = sha(readFileSync(b)); } catch {}
  dupCheck[pair.join(" vs ")] = { a: ah, b: bh, identical: ah === bh };
}

const counts = {};
for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

writeFileSync(join(OUT, "provenance-results.json"), JSON.stringify({ rows, counts, diffs, upOnly, dupCheck }, null, 2));

console.log(`files compared: ${rows.length}`);
console.log(`status counts: ${JSON.stringify(counts)}`);
console.log(`\nupstream guide files not shipped: ${upOnly.length}`);
for (const g of upOnly) console.log("  - " + g);
console.log(`\nduplicate check: ${JSON.stringify(dupCheck)}`);
console.log(`\nDIFFERS detail:`);
for (const r of rows.filter((x) => x.status.startsWith("DIFFERS"))) {
  console.log(`  ${r.file}  bytes ${r.bytesU} -> ${r.bytesT}  sha ${r.shaU.slice(0, 12)} -> ${r.shaT.slice(0, 12)}`);
  const d = diffs[r.file];
  const sh = d.filter((l) => l[0] !== " ").slice(0, 30);
  console.log(`    +/- lines: ${d.filter((l) => l[0] === "+").length} added, ${d.filter((l) => l[0] === "-").length} removed`);
  console.log(sh.map((l) => "    " + l.slice(0, 150)).join("\n"));
}
if (rows.some((x) => x.status === "MISSING_TARGET" || x.status.startsWith("MISSING_UPSTREAM"))) {
  console.log("\nMISSING rows:");
  for (const r of rows.filter((x) => !x.status.startsWith("IDENT") && !x.status.startsWith("DIFFERS"))) console.log(`  ${r.status} ${r.file}  (upstream ${r.upstream})`);
}
