import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { createFileStore, defaultStatePath } from '../lib/store.js'

const scratch = join(import.meta.dirname, '..', '.tmp')

/** A throwaway directory inside the ignored `.tmp/` folder. */
async function temporaryDirectory() {
  await mkdir(scratch, { recursive: true })
  return mkdtemp(join(scratch, 'store-test-'))
}

test('save then load round-trips one document', async () => {
  const directory = await temporaryDirectory()
  const file = join(directory, 'nested', 'stats.json')
  const store = createFileStore({ file })

  await store.save({ version: 1, calls: 3 })

  assert.deepEqual(await store.load(), { version: 1, calls: 3 })
})

test('load returns null when the document is missing', async () => {
  const directory = await temporaryDirectory()
  const store = createFileStore({ file: join(directory, 'absent.json') })

  assert.equal(await store.load(), null)
})

test('load returns null when the document is corrupt', async () => {
  const directory = await temporaryDirectory()
  const file = join(directory, 'stats.json')
  await writeFile(file, '{not json')
  const store = createFileStore({ file })

  assert.equal(await store.load(), null)
})

test('save replaces the previous document atomically', async () => {
  const directory = await temporaryDirectory()
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
