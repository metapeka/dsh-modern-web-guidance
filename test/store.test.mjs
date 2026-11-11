import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { createFileStore, defaultStatePath } from '../lib/store.js'
import { makeScratchDir, removeTree, sweepStale } from './tmp.mjs'

/** Sweep the roots an earlier failed run left behind, before this run creates any of its own. */
await sweepStale(['store-test'])

/** A throwaway directory inside the ignored `.tmp/` folder, removed when its test ends. */
async function temporaryDirectory(t) {
  const directory = await makeScratchDir('store-test')
  t.after(() => removeTree(directory))
  return directory
}

test('save then load round-trips one document', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'nested', 'stats.json')
  const store = createFileStore({ file })

  await store.save({ version: 1, calls: 3 })

  assert.deepEqual(await store.load(), { version: 1, calls: 3 })
})

test('load returns null when the document is missing', async (t) => {
  const directory = await temporaryDirectory(t)
  const store = createFileStore({ file: join(directory, 'absent.json') })

  assert.equal(await store.load(), null)
})

test('load returns null when the document is corrupt', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'stats.json')
  await writeFile(file, '{not json')
  const store = createFileStore({ file })

  assert.equal(await store.load(), null)
})

test('save replaces the previous document atomically', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'stats.json')
  const store = createFileStore({ file })

  await store.save({ calls: 1 })
  await store.save({ calls: 2 })

  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { calls: 2 })
})

test('defaultStatePath honours an explicit home', () => {
  assert.equal(
    defaultStatePath('C:\\dsh-home'),
    join('C:\\dsh-home', 'storage', 'modern-web-guidance', 'stats.json'),
  )
})
