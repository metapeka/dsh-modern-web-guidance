// Repro 03 — a failed buildIndex() is cached forever: one transient read error disables
// all three tools for the rest of the session, and repairing the data does not help.
// Run: node audit/repro/bugs/03-sticky-index-rejection.mjs
//
// The plugin comment at index.js:224 says "a failed warm-up is retried by the first tool
// call". It is not: `indexPromise ??= buildIndex()` (lib/guidance.js:176) stores the
// rejected promise, so every later call on the same instance rejects with the old error.
//
// Simulated transient failure: guides.json is missing when the instance is created, then
// restored (exactly what a repaired install / unlocked file looks like).
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createGuidance } from '../../../lib/guidance.js'
import { copyData, DATA_DIR } from './_harness.mjs'

const { dataDir, cleanup } = copyData()
const catalog = join(dataDir, 'guides.json')
try {
  rmSync(catalog) // transient: file not readable yet
  const guidance = createGuidance({ dataDir })

  const attempt = async (label) => {
    try {
      const value = await guidance.search('dialog')
      console.log(`${label}: ok, ${value.length} hits`)
      return true
    } catch (err) {
      console.log(`${label}: rejects ${err.code ?? err.constructor.name}`)
      return false
    }
  }

  await attempt('call 1 (file missing) ')
  copyFileSync(join(DATA_DIR, 'guides.json'), catalog) // data is now healthy again
  await attempt('call 2 (file restored)')
  await attempt('call 3 (file restored)')
  const listed = await guidance.list().then((v) => `ok ${v.length}`).catch((err) => `rejects ${err.code}`)
  console.log('list after repair:', listed)

  const reproduced = listed.startsWith('rejects')
  console.log('EXPECT: call 2/3 and list succeed after the file is restored; ACTUAL: every call keeps the first rejection')
  console.log(reproduced ? 'DEFECT REPRODUCED' : 'not reproduced')
  process.exitCode = reproduced ? 1 : 0
} finally {
  cleanup()
}
