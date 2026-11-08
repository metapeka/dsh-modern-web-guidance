/**
 * Durable JSON store for the plugin's usage counters.
 *
 * The telemetry core takes a store adapter, so it never has to know how state is
 * persisted. This adapter keeps one JSON document under the DSH home directory and
 * writes it atomically, so a crashed write cannot leave a half-written file behind.
 * Reads are forgiving: a missing or corrupt document reads as "no state yet".
 */

import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Resolve the default state file for the current profile.
 * @param {string} [home] profile directory; defaults to the environment's.
 * @returns {string} absolute path to the counters document.
 */
export function defaultStatePath(home) {
  const base = home ?? process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'storage', 'modern-web-guidance', 'stats.json')
}

/**
 * Create a store adapter backed by one JSON file.
 * @param {{ file: string }} options target document path.
 * @returns {{ load: () => Promise<unknown>, save: (state: unknown) => Promise<void> }} the adapter.
 */
export function createFileStore({ file }) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'))
      } catch {
        return null
      }
    },

    async save(state) {
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      await writeFile(temporary, JSON.stringify(state), 'utf8')
      await rename(temporary, file)
    },
  }
}
