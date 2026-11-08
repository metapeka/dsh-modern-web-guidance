// Shared helpers for the audit repros. Not a defect report itself.
// Plugin root resolves two levels up from audit/repro/bugs/.
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const DATA_DIR = join(PLUGIN_ROOT, 'data')

/** Fresh copy of the shipped data/ directory in a temp dir. */
export function copyData() {
  const dir = mkdtempSync(join(tmpdir(), 'mwg-audit-'))
  cpSync(DATA_DIR, join(dir, 'data'), { recursive: true })
  return {
    dataDir: join(dir, 'data'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Minimal Cordis context, copied from test/plugin.test.mjs. */
export function createContext() {
  const tools = []
  const skills = []
  const disposers = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    skills: { register(registration) { skills.push(registration); return () => {} } },
    effect(create) { const d = create(); disposers.push(d); return d },
  }
  return { ctx, tools, skills, disposeAll: () => disposers.forEach((d) => typeof d === 'function' && d()) }
}

export function header(title) {
  console.log(`\n=== ${title} ===`)
}

export function show(label, value, maxLen = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const trimmed = text.length > maxLen ? `${text.slice(0, maxLen)}…[${text.length} chars]` : text
  console.log(`${label}: ${trimmed}`)
}

export { writeFileSync, mkdirSync, join }
