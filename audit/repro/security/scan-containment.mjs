// Read-surface control for 0.5.0: `web_guidance_legacy_scan` refuses an explicit path that leaves
// the session workspace (lib/scan.js:333-340, code `path-outside`). The refusal is not a bug: it is
// the boundary that keeps a model-supplied path from turning the scanner into an arbitrary-file
// reader. This script plants a temp workspace and a sibling directory outside it, asks for the
// outside file through the real `scan()` API, and prints the exact command plus the exact output.
// Run: node audit/repro/security/scan-containment.mjs   (from the package root)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ScanError, scan } from '../../../lib/scan.js'

const line = (text) => console.log(text)
const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const workspace = join(root, 'tmp-scan-workspace')
const outside = join(root, 'tmp-scan-outside')

rmSync(workspace, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })
mkdirSync(join(workspace, 'site'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(
  join(workspace, 'site', 'index.html'),
  '<style>::-webkit-scrollbar { width: 8px }</style>\n<div onclick="go()">old</div>\n',
  'utf8',
)
writeFileSync(join(outside, 'secret.md'), '# planted fixture\n\nPLANTED_MARKER=this-file-is-outside-the-workspace\n', 'utf8')

line('command: node audit/repro/security/scan-containment.mjs')
line('tool call: web_guidance_legacy_scan({ paths: ["../tmp-scan-outside/secret.md"] })')
line('')

let refusal
try {
  await scan({ cwd: workspace, paths: ['../tmp-scan-outside/secret.md'] })
} catch (error) {
  if (!(error instanceof ScanError)) throw error
  refusal = error
}

line(`error: ${refusal.code} — ${refusal.message}`)
line(`subject: ${JSON.stringify(refusal.subject)}`)
line('')

if (!refusal || refusal.code !== 'path-outside') {
  line('FAIL — the outside path was not refused; the control regressed.')
  process.exitCode = 1
} else {
  const inside = await scan({ cwd: workspace, paths: ['site'] })
  line(`inside the workspace: scanned=${inside.scanned.files} files, findings=${inside.findings.length}`)
  line('OK — path-outside refusal reproduced; the in-workspace scan still works.')
}

rmSync(workspace, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })
line('')
line('cleaned up tmp-scan-workspace/ and tmp-scan-outside/')
