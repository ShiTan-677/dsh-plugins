import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  EXIT,
  compareVersions,
  extractTarball,
  parseTar,
  run,
  scanText,
} from '../scripts/watch-official.mjs'
import { ROOT } from './harness.mjs'

test('compareVersions 遵循 semver 优先级', () => {
  const cases = [
    ['0.1.7-rc.2', '0.1.7-rc.1', 1],
    ['0.1.7-rc.2', '0.1.7-rc.2', 0],
    ['0.1.7', '0.1.7-rc.2', 1],
    ['0.1.7-rc.2', '0.1.7', -1],
    ['0.1.10', '0.1.9', 1],
    ['0.2.0', '0.1.9', 1],
    ['1.0.0', '0.9.9', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['v1.2.3', '1.2.3', 0],
  ]
  for (const [a, b, expected] of cases) {
    assert.equal(compareVersions(a, b), expected, a + ' vs ' + b)
  }
})

test('scanText 命中强/弱信号，并跳过 unreadable 之类的噪声', () => {
  const config = {
    strongTokens: ['markUnread', 'setUnread'],
    weakTokens: ['unread', '未读'],
    ignoreLinePattern: 'unreadable',
    limit: 5,
  }
  const text = [
    'a file that is unreadable for other reasons',
    'export declare function markUnread(sessionId: string): void',
    'the dot shows unread sessions',
    '菜单里出现「标记为未读」',
  ].join('\n')

  const matches = scanText('lib/types/index.d.ts', text, config)
  assert.equal(matches.length, 3, JSON.stringify(matches))
  assert.equal(matches[0].strength, 'strong')
  assert.equal(matches[0].token, 'markUnread')
  assert.equal(matches[0].line, 2)
  assert.equal(matches[1].strength, 'weak')
  assert.equal(matches[2].token, '未读')

  assert.deepEqual(scanText('x', 'unreadable only', config), [])
  const sixLines = ['unread', 'unread', 'unread', 'unread', 'unread', 'unread'].join('\n')
  assert.equal(scanText('x', sixLines, { ...config, limit: 2 }).length, 2, 'limit 限制每文件命中数')
})

/** 造一个最小 ustar 文件（仅测试用）。 */
function tarFile(name, content) {
  const data = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12)
  header.write('00000000000\0', 136, 12)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  let sum = 0
  for (const byte of header.subarray(0, 148)) sum += byte
  for (const byte of header.subarray(156)) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, pad])
}

test('tar.gz 解析取回普通文件内容', () => {
  const tgz = gzipSync(Buffer.concat([
    tarFile('package/package.json', '{"name":"x"}'),
    tarFile('package/lib/types/index.d.ts', 'export declare function setUnread(id: string): void\n'),
    Buffer.alloc(1024),
  ]))
  const entries = extractTarball(tgz)
  assert.deepEqual(entries.map((entry) => entry.name), [
    'package/package.json',
    'package/lib/types/index.d.ts',
  ])
  assert.match(entries[1].data.toString('utf8'), /setUnread/)
  assert.deepEqual(parseTar(Buffer.alloc(1024)), [])
})

/** 用假 fetch 跑一遍完整探测流程。 */
function withFakeRegistry(handler, body) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => handler(String(url))
  return Promise.resolve()
    .then(body)
    .finally(() => {
      globalThis.fetch = original
    })
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    arrayBuffer: async () => Buffer.from(JSON.stringify(value)),
  }
}

/**
 * 由基线版本造一个「确定更新」的版本，供假 registry 使用。
 *
 * 写死 `0.1.9` 之类的字面量会在每次同步基线时静默失配（它可能已经不比基线新），
 * 于是探测结论从 review / official-likely 掉成 current。这里从
 * `scripts/official-baseline.json` 的 runtime 现算，基线升级后无需再改测试。
 */
function bumpVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version))
  assert.ok(match !== null, '基线版本必须形如 x.y.z：' + version)
  return `${match[1]}.${Number(match[2]) + 1}.0`
}

test('新版官方产物里出现 setter ⇒ 结论 official-likely（退出码 10）', async () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts', 'official-baseline.json'), 'utf8'))
  const current = baseline.runtime
  const newer = bumpVersion(current)
  const sessionPkg = Object.keys(baseline.pins).find((name) => name.includes('ui-session'))
  const workspacePkg = Object.keys(baseline.pins).find((name) => name.includes('ui-workspace'))
  const frontendPkg = Object.keys(baseline.pins).find((name) => name.includes('web-frontend'))
  const tgz = gzipSync(Buffer.concat([
    tarFile('package/lib/types/client/index.d.ts', 'export declare function markUnread(sessionId: string): void\n'),
    Buffer.alloc(1024),
  ]))

  await withFakeRegistry(async (url) => {
    if (url.includes('tarball-should-be-fetched')) {
      return { ok: true, status: 200, arrayBuffer: async () => tgz }
    }
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''))
    const isSession = name === sessionPkg
    const versions = isSession
      ? { [current]: {}, [newer]: { dist: { tarball: 'https://example.invalid/tarball-should-be-fetched' } } }
      : { [current]: {} }
    return jsonResponse({ 'dist-tags': { next: isSession ? newer : current }, versions })
  }, async () => {
    const { exitCode, report } = await run({ root: ROOT })
    assert.equal(exitCode, EXIT.OFFICIAL)
    assert.equal(report.verdict, 'official-likely')
    const session = report.packages.find((entry) => entry.name === sessionPkg)
    assert.equal(session.newest, newer)
    assert.ok(report.hits.some((hit) => hit.token === 'markUnread' && hit.strength === 'strong'))
    const others = report.packages.filter((entry) => [workspacePkg, frontendPkg].includes(entry.name))
    assert.equal(others.length, 2)
    assert.ok(others.every((entry) => entry.newest === null), '未升级的包不应被下载扫描')
  })
})

test('只有新版本、没有 setter ⇒ review（退出码 2）', async () => {
  const current = JSON.parse(readFileSync(join(ROOT, 'scripts', 'official-baseline.json'), 'utf8')).runtime
  const newer = bumpVersion(current)
  await withFakeRegistry(async () => jsonResponse({
    'dist-tags': { next: newer },
    versions: { [current]: {}, [newer]: { dist: { tarball: 'https://example.invalid/never-fetched' } } },
  }), async () => {
    // scan: false：只看版本，不下载 tarball（离线也能跑）。
    const { exitCode, report } = await run({ root: ROOT, scan: false })
    assert.equal(exitCode, EXIT.REVIEW)
    assert.equal(report.verdict, 'review')
    assert.deepEqual(report.hits, [])
  })
})

test('没有新版本 ⇒ current（退出码 0）', async () => {
  const current = JSON.parse(readFileSync(join(ROOT, 'scripts', 'official-baseline.json'), 'utf8')).runtime
  await withFakeRegistry(async () => jsonResponse({
    'dist-tags': { next: current },
    versions: { [current]: {} },
  }), async () => {
    const { exitCode, report } = await run({ root: ROOT })
    assert.equal(exitCode, EXIT.CURRENT)
    assert.equal(report.verdict, 'current')
    assert.ok(report.packages.every((entry) => entry.newest === null))
  })
})

test('registry 不可用时报告错误但不崩', async () => {
  await withFakeRegistry(async () => {
    throw new Error('offline')
  }, async () => {
    const { exitCode, report } = await run({ root: ROOT })
    assert.equal(exitCode, EXIT.CURRENT)
    assert.ok(report.scanErrors.length > 0)
    assert.ok(report.packages.every((entry) => typeof entry.error === 'string'))
  })
})

test('--profile 附带报告插件是否还挂着', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(tmpdir(), 'mark-unread-home-'))
  const profileDir = path.join(home, 'profiles', 'demo')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-mark-unread'] } },
  }))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await withFakeRegistry(async () => jsonResponse({ 'dist-tags': {}, versions: {} }), async () => {
      const { report } = await run({ root: ROOT, profile: 'demo' })
      assert.equal(report.profile.plugin.installed, true)
      assert.equal(report.profile.plugin.checked, true)
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
