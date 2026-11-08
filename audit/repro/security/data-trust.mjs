// Data-trust boundary: readEntry() builds a filesystem path from data/guides.json
// values (lib/guidance.js:125-126). Tool arguments cannot reach it (see probes.mjs);
// this shows what a tampered/compromised catalog file would be able to do.
// Run: node audit/repro/security/data-trust.mjs   (from the package root)
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createGuidance } from '../../../lib/guidance.js'

const line = (s) => console.log(s)
const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tmp = join(root, 'tmpdata')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(join(tmp, 'guides'), { recursive: true })

// A markdown file OUTSIDE the data directory, i.e. outside data/guides/<category>/.
// The marker is deliberately not shaped like a credential: this repo is public, and a fixture that
// reads as `TOKEN=…` trips secret scanners (and reviewers) for no reason.
const outside = join(root, 'outside-fixture.md')
writeFileSync(outside, '# planted fixture\n\nPLANTED_MARKER=this-file-lives-outside-the-data-directory\n', 'utf8')

// category '..' collapses data/guides, id segments then walk out of data/.
writeFileSync(join(tmp, 'guides.json'), JSON.stringify([
  { id: '../outside-fixture', category: '..', description: 'tampered entry' },
]), 'utf8')

const g = createGuidance({ dataDir: tmp })
const { guides, unknown } = await g.retrieve(['../outside-fixture'])
line(`guides=${guides.length} unknown=${JSON.stringify(unknown)}`)
line(`leaked content: ${JSON.stringify(guides[0]?.content ?? null)}`)
line('')
line('same call through search():')
const hits = await g.search('planted fixture')
line(JSON.stringify(hits, null, 2))
rmSync(tmp, { recursive: true, force: true })
rmSync(outside, { force: true })
line('')
line('cleaned up tmpdata/ and outside-fixture.md')

