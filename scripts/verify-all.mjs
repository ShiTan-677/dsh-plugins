#!/usr/bin/env node
/**
 * Run every package's own `verify` script, in a stable order.
 *
 * Packages are self-contained: each one owns its build check and tests, so this
 * script only fans out and aggregates exit codes. It deliberately avoids pnpm
 * so a fresh checkout can be verified with nothing but Node.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const packagesDir = join(root, 'packages')
const dirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  .map(entry => entry.name)
  .sort()

if (dirs.length === 0) {
  console.error('no packages found under packages/')
  process.exit(1)
}

let failed = 0
for (const name of dirs) {
  const dir = join(packagesDir, name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.scripts?.verify) {
    console.log(`- ${name}: no verify script, skipped`)
    continue
  }
  console.log(`\n=== ${name} ===`)
  const result = spawnSync('npm', ['run', '--silent', 'verify'], { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
    console.error(`=== ${name} FAILED (exit ${result.status}) ===`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} package(s) failed`)
  process.exit(1)
}
console.log(`\nall ${dirs.length} package(s) verified`)
