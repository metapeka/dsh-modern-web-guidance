// Corpus text scan: prompt-injection / instruction-smuggling + hidden-content + link hygiene.
// Read-only. Walks the shipped corpus and prints an aggregated summary; full hits to JSON.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = "E:/0ai/dsh_mod_1/dsh-modern-web-guidance";
const OUT = join(ROOT, "audit/repro/corpus");

// ---- file discovery -------------------------------------------------------
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// Whole repo, excluding the audit output itself, .git and node_modules.
// Files without an extension (LICENSE, NOTICE, .gitattributes) are included by name.
const EXCLUDE_DIRS = ["\\.git", "\\audit", "\\node_modules"];
const NAMED_TEXT = new Set(["LICENSE", "NOTICE", ".gitattributes", ".gitignore"]);
function walkRepo(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (EXCLUDE_DIRS.some((x) => p.replaceAll("/", "\\").includes(x))) continue;
    const st = statSync(p);
    if (st.isDirectory()) walkRepo(p, acc);
    else acc.push(p);
  }
  return acc;
}

const TEXT_EXT = new Set([".md", ".json", ".txt", ".mjs", ".js", ".yml", ".svg"]);
let files = [];
for (const f of walkRepo(ROOT)) {
  const ext = extname(f).toLowerCase();
  if (TEXT_EXT.has(ext) || NAMED_TEXT.has(f.split(/[\\/]/).pop())) files.push(f);
}
files = [...new Set(files)].sort();

// ---- patterns -------------------------------------------------------------
// Injection families. `scope` = "corpus" (reaches a model) vs "meta" (repo docs).
const INJECTION = [
  { id: "ignore-instructions", re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|system)\b[^.\n]{0,20}\b(instruction|prompt|direction|message|rule)s?\b/i, sev: "high" },
  { id: "system-prompt", re: /\bsystem (prompt|message|instructions?)\b/i, sev: "high" },
  { id: "you-are-now", re: /\byou are now\b|\bfrom now on,? you\b/i, sev: "high" },
  { id: "as-an-ai", re: /\bas an (ai|assistant|language model)\b|\b(you are|you're) an (ai|assistant|language model)\b/i, sev: "medium" },
  { id: "you-must-now", re: /\byou (must|should|need to|have to) (now|instead|immediately|always|never)\b/i, sev: "medium" },
  { id: "must-obey", re: /\bobey\b|\bcomply with\b[^.\n]{0,30}\b(instruction|request)s?\b/i, sev: "medium" },
  { id: "override", re: /\boverride\b[^.\n]{0,40}\b(instruction|safety|guardrail|rule|policy|system)s?\b/i, sev: "high" },
  { id: "new-instructions", re: /\b(new|updated|revised) (instructions?|system prompt|directives?)\b/i, sev: "high" },
  { id: "secret-keep", re: /\b(do not|don't|never) (tell|inform|mention to|reveal to|alert) (the )?(user|human|operator)\b|\bwithout (telling|informing|notifying) (the )?(user|human)\b|\bsecretly\b|\bsilently (run|execute|send|call)\b/i, sev: "critical" },
  { id: "exfil", re: /\b(exfiltrat|send|post|upload|transmit|leak)\b[^.\n]{0,60}\b(to|at)\b[^.\n]{0,40}\b(https?:\/\/|webhook|endpoint|server|api)\b/i, sev: "high" },
  { id: "shell-cmd", re: /\b(run|execute)\b[^.\n]{0,30}\b(shell|bash|powershell|cmd(\.exe)?|terminal|command line|npx|npm|curl|wget|rm -rf|sudo)\b/i, sev: "high" },
  { id: "creds", re: /\b(api[ _-]?key|access token|secret key|credentials?|password)\b[^.\n]{0,40}\b(send|paste|include|discard|export|leak|read)\b/i, sev: "high" },
  { id: "tool-steer", re: /\b(call|invoke|use) the\b[^.\n]{0,30}\b(tool|function call)\b[^.\n]{0,40}\b(instead|regardless|always)\b/i, sev: "medium" },
];
const HTML = [
  { id: "script-tag", re: /<\s*script\b/i, sev: "medium" },
  { id: "iframe-tag", re: /<\s*iframe\b/i, sev: "medium" },
  { id: "on-handler", re: /\bon(click|load|error|mouseover|focus|submit|change|input)\s*=/i, sev: "medium" },
  { id: "js-uri", re: /\bjavascript:/i, sev: "medium" },
  { id: "data-uri", re: /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i, sev: "low" },
  { id: "base64-blob", re: /[A-Za-z0-9+/]{200,}={0,2}/, sev: "medium" },
  { id: "eval", re: /\beval\s*\(|\bnew Function\s*\(/i, sev: "medium" },
  { id: "html-comment", re: /<!--/, sev: "low" },
];

// Invisible / control characters.
const INVISIBLE = [
  { id: "c0-control", test: (c) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d },
  { id: "c1-control", test: (c) => c >= 0x80 && c <= 0x9f },
  { id: "zw", test: (c) => c >= 0x200b && c <= 0x200f },
  { id: "bidi", test: (c) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) },
  { id: "bom", test: (c) => c === 0xfeff },
  { id: "wj", test: (c) => c >= 0x2060 && c <= 0x2064 },
  { id: "tag-chars", test: (c) => c >= 0xe0000 && c <= 0xe007f },
  { id: "soft-hyphen", test: (c) => c === 0x00ad },
  { id: "other-invisible", test: (c) => [0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x3164, 0xffa0].includes(c) },
];

const hits = [];
const unseen = {}; // invisible char id -> count
const urlSchemes = {};
const nonHttps = [];
let totalBytes = 0, totalLines = 0;
const scanned = [];

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const buf = readFileSync(file);
  totalBytes += buf.length;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = buf.toString("utf8");
    hits.push({ area: "encoding", id: "not-utf8", file: rel, line: 0, sev: "medium", snippet: "file is not valid UTF-8" });
  }
  const lines = text.split(/\r?\n/);
  totalLines += lines.length;
  scanned.push({ rel, bytes: buf.length, lines: lines.length });

  if (text.charCodeAt(0) === 0xfeff) {
    hits.push({ area: "hidden", id: "bom-at-start", file: rel, line: 1, sev: "low", snippet: "UTF-8 BOM present" });
    unseen["bom"] = (unseen["bom"] || 0) + 1;
  }

  // per-line structure: knowledge of fenced code blocks
  let inFence = false;
  let fenceMark = null;
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) { inFence = false; fenceMark = null; }
      return;
    }
    const ctx = (n) => lines.slice(Math.max(0, n - 3), n + 2).join("\n");

    for (const p of INJECTION) {
      const m = line.match(p.re);
      if (m) hits.push({ area: "injection", id: p.id, file: rel, line: lineNo, sev: p.sev, inCode: inFence, match: m[0], snippet: ctx(i) });
    }
    for (const p of HTML) {
      const m = line.match(p.re);
      if (m) hits.push({ area: "html", id: p.id, file: rel, line: lineNo, sev: p.sev, inCode: inFence, match: m[0].slice(0, 120) });
    }
    // codepoints: iterate over the line's chars
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      for (const inv of INVISIBLE) {
        if (inv.test(c)) {
          unseen[inv.id] = (unseen[inv.id] || 0) + 1;
          hits.push({ area: "hidden", id: inv.id, file: rel, line: lineNo, sev: "high", col: k + 1, codepoint: "U+" + c.toString(16).toUpperCase().padStart(4, "0") });
          break;
        }
      }
    }
    // URLs
    for (const m of line.matchAll(/\b([a-z][a-z0-9+.-]{1,15}):\/\//gi)) {
      const scheme = m[1].toLowerCase();
      urlSchemes[scheme] = (urlSchemes[scheme] || 0) + 1;
      if (scheme !== "https" && scheme !== "http") hits.push({ area: "url", id: "non-web-scheme", file: rel, line: lineNo, sev: "low", match: m[0] });
    }
    for (const m of line.matchAll(/\bhttp:\/\/[^\s)\]"'<>]+/gi)) {
      nonHttps.push({ file: rel, line: lineNo, url: m[0] });
      hits.push({ area: "url", id: "plain-http", file: rel, line: lineNo, sev: "low", match: m[0] });
    }
  });
}

// ---- aggregate ------------------------------------------------------------
const byArea = {};
const bySev = {};
for (const h of hits) {
  byArea[h.area] = (byArea[h.area] || 0) + 1;
  bySev[h.sev] = (bySev[h.sev] || 0) + 1;
}
const groupCount = {};
for (const h of hits) {
  const k = `${h.area}/${h.id}`;
  groupCount[k] = (groupCount[k] || 0) + 1;
}
const uniqueNonHttps = [...new Set(nonHttps.map((n) => n.url))];

writeFileSync(join(OUT, "scan-results.json"), JSON.stringify({ files, hits, byArea, bySev, groupCount, urlSchemes, nonHttps }, null, 2));
writeFileSync(join(OUT, "scanned-files.json"), JSON.stringify(scanned, null, 2));

const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.padEnd(34)} ${v}`).join("\n");
console.log(`scanned files: ${files.length}   bytes: ${totalBytes}   lines: ${totalLines}`);
console.log(`\n== hit groups (area/id -> count)\n${fmt(groupCount)}`);
console.log(`\n== by severity\n${fmt(bySev)}`);
console.log(`\n== url schemes\n${fmt(urlSchemes)}`);
console.log(`\n== distinct plain-http urls: ${uniqueNonHttps.length}`);
for (const u of uniqueNonHttps.slice(0, 25)) console.log(`  ${u}`);
console.log(`\n== invisible codepoints seen: ${Object.keys(unseen).length ? JSON.stringify(unseen) : "none"}`);
console.log(`\n== HIGH/CRITICAL hits (injection|hidden) ==`);
const hi = hits.filter((h) => (h.sev === "critical" || h.sev === "high") && (h.area === "injection" || h.area === "hidden"));
console.log(hi.length ? hi.slice(0, 40).map((h) => `${h.sev.toUpperCase()} ${h.area}/${h.id} ${h.file}:${h.line}${h.inCode ? " [in-code]" : ""} :: ${(h.match || h.codepoint || "").slice(0, 100)}`).join("\n") : "  none");
