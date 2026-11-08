import { readFileSync } from "node:fs";
const a = readFileSync("LICENSE","utf8").split(/\r?\n/);
const b = readFileSync("E:/0ai/dsh_mod_1/.tmp-mwg/pkg/package/LICENSE","utf8").split(/\r?\n/);
console.log("plugin lines",a.length,"upstream lines",b.length);
let diffs=0;
for(let i=0;i<Math.max(a.length,b.length);i++){
  if(a[i]!==b[i]){ diffs++; if(diffs<=15) console.log(`L${i+1}\n  plugin  : ${JSON.stringify(a[i])}\n  upstream: ${JSON.stringify(b[i])}`); }
}
console.log("differing lines:",diffs);
// prove index.js:2 dash decoding
const idx=readFileSync("index.js","utf8").split("\n")[1];
console.log("index.js L2 codepoints:", [...idx].filter(c=>c.charCodeAt(0)>127).map(c=>"U+"+c.codePointAt(0).toString(16).toUpperCase()).join(" "));
