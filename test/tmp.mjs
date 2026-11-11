/**
 * Throwaway directories for the test suite, in one place.
 *
 * Three things every test file that writes into `.tmp` needs and none of them should spell its own:
 * a removal that retries the way Windows needs, a sweep for what an earlier failed run left behind,
 * and one directory name the suite owns. A teardown copied into six files is six chances to fix a
 * flake in one of them. A fourth arrived later: the wait for the counters write no test can await,
 * which has to know *which* profile it is waiting for and must never ask the environment.
 */
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defaultStatePath } from '../lib/store.js'
import { PACKAGE_DIR } from './paths.mjs'

/** The ignored scratch directory at the repo root; every throwaway root the suite makes lives here. */
export const TMP_DIR = join(PACKAGE_DIR, '.tmp')

/**
 * How many times a removal retries, and the pause before the next attempt: 25, 50, 75, 100 ms.
 *
 * Five attempts and a quarter of a second of patience covers the whole class this exists for — a
 * Windows handle released a moment late — without turning a genuinely broken teardown into a
 * four-second stall that hides the real error.
 */
const CLEAN_ATTEMPTS = 5
const CLEAN_PAUSE_MS = 25
/** The codes a retry can win: the handle is released and the directory goes. Others are raised at once. */
const CLEAN_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
/**
 * How old a root must be before the sweep may remove it.
 *
 * This is the one guard that makes the sweep safe: a live run's directories are seconds old, a stale
 * one is at least one suite run old, and two agents can share this checkout. Without it, an import
 * could delete a directory another run is using right now.
 */
const STALE_AFTER_MS = 10 * 60 * 1000

/** How long `settleCounters` watches a write in flight: 25 polls of 10 ms after the debounce's window. */
const SETTLE_POLLS = 25
const SETTLE_POLL_MS = 10

/**
 * Remove one path, retrying the way Windows needs.
 *
 * `rm -rf` is not one atomic step on this platform: after a write or a rename a directory can stay
 * busy for a moment — the OS indexer, a virus scanner, or a handle the previous `rename` has not
 * released yet — so a single attempt fails with `EBUSY` on a path that is gone a millisecond later.
 * That is exactly how one full-suite run in twenty went red, inside a teardown, with the product
 * assertions underneath it green.
 *
 * The retry lives here, in the harness, and nowhere else: `lib/` must not grow retry logic to make a
 * test happy. A code that cannot heal (`ENOENT` is already swallowed by `force`) is raised on the
 * first attempt, and the final failure names the path that stayed locked, so a red run says which
 * directory to look at instead of only which line.
 *
 * @param {string} path a file or a directory
 * @param {object} [options] forwarded to `fs.rm`
 * @returns {Promise<void>}
 */
export async function removeTree(path, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, ...options })
      return
    } catch (error) {
      if (!CLEAN_RETRY_CODES.has(error.code)) throw error
      if (attempt >= CLEAN_ATTEMPTS) {
        throw new Error(
          `the temp path ${path} stayed locked (${error.code}) after ${CLEAN_ATTEMPTS} attempts`,
          { cause: error },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, CLEAN_PAUSE_MS * attempt))
    }
  }
}

/**
 * A fresh throwaway directory inside `.tmp`, named `<prefix>-<random>`.
 *
 * The prefix is also what the sweep matches on, so it must belong to one file: a generic name like
 * `app-` would make two files' roots indistinguishable, and the sweep would be deleting a stranger's.
 *
 * @param {string} prefix the family this directory belongs to, without the trailing dash
 * @returns {Promise<string>} the absolute path
 */
export async function makeScratchDir(prefix) {
  await mkdir(TMP_DIR, { recursive: true })
  return mkdtemp(join(TMP_DIR, `${prefix}-`))
}

/**
 * Remove the roots a previous run left in `.tmp`, before any test in this file makes one.
 *
 * A directory that survived a flake must not be inherited by the next run: it is a phantom
 * workspace, and the counters hash real paths, so it would quietly join a run it has nothing to do
 * with. Only the prefixes the caller names are swept — `.tmp` also holds other files' roots and files
 * that are not directories at all, and a wildcard over it is not this file's to run. Roots young
 * enough to belong to a run in flight are left alone, so two concurrent runs cannot delete each
 * other's fixtures.
 *
 * @param {string[]} prefixes the families this file owns, without the trailing dash
 * @returns {Promise<string[]>} the paths it removed
 */
export async function sweepStale(prefixes) {
  await mkdir(TMP_DIR, { recursive: true })
  const entries = await readdir(TMP_DIR, { withFileTypes: true })
  const cutoff = Date.now() - STALE_AFTER_MS
  const stale = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!prefixes.some((prefix) => entry.name.startsWith(`${prefix}-`))) continue
    const path = join(TMP_DIR, entry.name)
    const stats = await statOf(path)
    if (stats === null || stats.mtimeMs > cutoff) continue
    stale.push(path)
  }
  for (const path of stale) await removeTree(path)
  return stale
}

/** One path's `stat`, or null when it disappeared between the listing and the look. */
async function statOf(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * Wait until the counters write a test cannot await has landed, or until it never will.
 *
 * The plugin debounces that write and `void`s the promise (`scheduleSave` in `index.js`), so a test
 * can neither await it nor be told when it finished: a fixed sleep is a guess, and at suite load it
 * lost about once in twenty runs — the read found no `stats.json` yet, or a teardown raced the write's
 * `rename` and answered `EBUSY`. So the wait gives the debounce its window, then stops as soon as the
 * file has stopped changing. A save makes the directory before it renames the file into place, so a
 * missing file beside an existing `storage/` is a write still in progress, while a missing `storage/`
 * is a write that never came — and the wait returns at once instead of burning its poll budget.
 *
 * `home` is an argument, never `process.env.DSH_PROFILE_DIR`. Under `--test-isolation=none` one process
 * serves every file and three of them point that variable at fixtures of their own, so an ambient read
 * makes a teardown wait on — and then remove — a directory that belongs to another test. Passing the
 * path also makes the wait readable: it is about *that* profile.
 *
 * @param {string} home the profile whose counters write is in flight
 * @returns {Promise<void>}
 */
export async function settleCounters(home) {
  if (typeof home !== 'string' || home === '') {
    throw new TypeError('settleCounters() needs the home whose counters write it is waiting for')
  }
  // The debounce window: nothing the plugin flushed can land sooner, and polling before it is wasted.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const file = defaultStatePath(home)
  let previous = null
  for (let attempt = 0; attempt < SETTLE_POLLS; attempt += 1) {
    const size = await sizeOf(file)
    if (size !== null && size === previous) return
    if (size === null && (await statOf(dirname(file))) === null) return
    previous = size
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
  }
}

/** One path's size, or null when it is not there — the one fact `settleCounters` compares between polls. */
async function sizeOf(path) {
  const stats = await statOf(path)
  return stats === null ? null : stats.size
}
