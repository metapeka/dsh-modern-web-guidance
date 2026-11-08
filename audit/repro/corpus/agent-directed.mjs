import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
function walk(d,a=[]){for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())walk(p,a);else a.push(p);}return a;}
const files=[...walk("data/guides"),join("data","guides.json"),...walk("data/skills")];
const PAT = {
  "agent-config-write": /(AGENTS\.md|CLAUDE\.md|\.cursorrules|copilot-instructions|\.claude\/|settings\.json|\.mcp\.json)/i,
  "dangerous-shell": /\b(rm -rf|curl\s+[^|\n]*\|\s*(sh|bash)|iwr\s+[^|\n]*\|\s*iex|Invoke-Expression|chmod \+x|sudo\s)/i,
  "no-confirm": /\b(without (asking|confirming|telling|permission)|do not (ask|confirm)|skip (the )?(confirmation|review|check)|bypass)\b/i,
  "persistence": /\b(persist|permanently (add|write|modify)|add (this|the following) (to|in) your (config|settings|memory))\b/i,
  "credential-store": /\b(store|save|write|commit)\b[^.\n]{0,40}\b(api[ _-]?key|token|password|secret)s?\b/i,
  "prompt-leak": /\b(system prompt|hidden instruction|context window contents|repeat (your|the) instructions)\b/i,
  "disable-security": /\b(disable|turn off|ignore|bypass)\b[^.\n]{0,30}\b(security,? (check|policy)|csp|sandbox|validation|warning as errors?)\b/i,
  "fetch-execute": /\b(fetch|download|retrieve|load)\b[^.\n]{0,30}\b(from|at)\b[^.\n]{0,30}\b(https?:\/\/)/i,
  "imperative-agent": /\b(you|the agent|the model|the assistant)\b[^.\n]{0,20}\b(must|shall)\b[^.\n]{0,40}\b(run|execute|call|invoke|send|write|delete|install)\b/i,
};
const res={};
for(const f of files){
  const rel=relative(".",f).replaceAll("\\","/");
  const lines=readFileSync(f,"utf8").split(/\r?\n/);
  let fence=false;
  lines.forEach((line,i)=>{
    if(/^\s{0,3}(```|~~~)/.test(line)){
      const mk=line.match(/^\s{0,3}(```+|~~~+)/)[1][0];
      if(!fence){fence=true;} else {fence=false;}
      return; // naive toggle ok for these files
    }
    for(const [id,re] of Object.entries(PAT)){
      if(re.test(line)){ (res[id]??=[]).push({rel,line:i+1,inCode:fence,txt:line.trim().slice(0,150)}); }
    }
  });
}
for(const [id,hits] of Object.entries(res)){
  console.log(`\n== ${id}: ${hits.length}`);
  for(const h of hits.slice(0,12)) console.log(`  ${h.rel}:${h.line}${h.inCode?" [code]":""} :: ${h.txt}`);
}
console.log("\nids with zero hits:", Object.keys(PAT).filter(k=>!res[k]).join(", "));
