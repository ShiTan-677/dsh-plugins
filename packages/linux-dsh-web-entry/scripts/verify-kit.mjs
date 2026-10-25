#!/usr/bin/env node
/**
 * Verify the shell kit without Linux.
 *
 * Three cheap invariants that catch the failures we actually hit:
 *   1. every shell script parses (`bash -n`) — a broken launcher only shows up
 *      on the user's desktop otherwise;
 *   2. `VERSION` and `package.json` agree — two copies of one number drift;
 *   3. the templates the installer substitutes into still exist.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const failures = []

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (entry === 'node_modules' || entry === '.git') continue
    const info = statSync(path)
    if (info.isDirectory()) walk(path, out)
    else if (entry.endsWith('.sh')) out.push(path)
  }
  return out
}

for (const script of walk(root)) {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push(`${relative(root, script)}: bash -n failed\n${result.stderr.trim()}`)
  }
}

const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (manifest.version !== version) {
  failures.push(`VERSION (${version}) != package.json version (${manifest.version})`)
}

for (const template of ['share/dsh-web.desktop.in', 'share/dsh-web.service.in']) {
  try {
    readFileSync(join(root, template))
  } catch {
    failures.push(`missing template: ${template}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('linux-dsh-web-entry: kit verified')
