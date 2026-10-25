#!/usr/bin/env node
/**
 * Guard the vendored copy of the launcher kit against drift.
 *
 * This package ships a copy of `packages/linux-dsh-web-entry` so that a profile
 * install (npm tarball or `link:`) stays self-contained. The copy is fine as a
 * packaging decision; a *silently stale* copy is not. Every file the kit
 * publishes is compared byte-for-byte against the workspace package, and a file
 * present in one but not the other fails the build.
 *
 * When this fires, re-copy the kit instead of hand-editing vendor/:
 *   rsync -a --delete ../linux-dsh-web-entry/{bin,share,tools,install.sh,VERSION,LICENSE,.gitignore} vendor/linux-dsh-web-entry/
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

const root = new URL('..', import.meta.url).pathname
const source = join(root, '..', 'linux-dsh-web-entry')
const vendor = join(root, 'vendor', 'linux-dsh-web-entry')

/** Paths the kit publishes; anything outside this list is upstream-only docs. */
const TRACKED = ['bin', 'share', 'tools', 'install.sh', 'VERSION', 'LICENSE', '.gitignore']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const path = join(dir, entry)
    const info = statSync(path)
    if (info.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

function collect(base) {
  const files = new Map()
  for (const tracked of TRACKED) {
    const path = join(base, tracked)
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      for (const file of walk(path)) {
        files.set(relative(base, file), createHash('sha256').update(readFileSync(file)).digest('hex'))
      }
    } else {
      files.set(tracked, createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  return files
}

const expected = collect(source)
const actual = collect(vendor)
const failures = []

for (const [path, hash] of expected) {
  if (!actual.has(path)) failures.push(`missing in vendor: ${path}`)
  else if (actual.get(path) !== hash) failures.push(`differs from kit: ${path}`)
}
for (const path of actual.keys()) {
  if (!expected.has(path)) failures.push(`not in kit anymore: ${path}`)
}

if (failures.length > 0) {
  console.error('vendor/linux-dsh-web-entry is out of sync with packages/linux-dsh-web-entry:')
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`vendor kit in sync (${actual.size} files)`)
