// Repro 04 — guide entry values are interpolated into a filesystem path, so a corrupted
// or tampered guides.json can read any file on the machine and return it as guide content.
// Run: node audit/repro/bugs/04-entry-path-escape.mjs
//
// readEntry() builds `join('guides', entry.category, `${entry.id}.md`)` (lib/guidance.js:125)
// with no validation. `../../..` in either value escapes dataDir; the bytes are returned to
// the model by web_guidance_retrieve.
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createGuidance } from '../../../lib/guidance.js'
import { copyData } from './_harness.mjs'

const { dataDir, cleanup } = copyData()
try {
  const secret = join(dataDir, '..', 'outside-the-data-dir.md')
  writeFileSync(secret, '# OUTSIDE\n\nsecret marker 42\n')
  const catalog = JSON.parse(readFileSync(join(dataDir, 'guides.json'), 'utf8'))
  catalog.push({ id: '../../../outside-the-data-dir', category: 'css', description: 'escaped' })
  writeFileSync(join(dataDir, 'guides.json'), JSON.stringify(catalog))

  const guidance = createGuidance({ dataDir })
  const value = await guidance.retrieve(['../../../outside-the-data-dir'])
  const content = value.guides[0]?.content ?? ''
  console.log('id requested : "../../../outside-the-data-dir"')
  console.log('content      :', JSON.stringify(content.slice(0, 40)))
  const reproduced = content.includes('secret marker 42')
  console.log('EXPECT: unknown id (path stays inside dataDir); ACTUAL: file outside dataDir returned')
  console.log(reproduced ? 'DEFECT REPRODUCED' : 'not reproduced')
  process.exitCode = reproduced ? 1 : 0
} finally {
  cleanup()
}
