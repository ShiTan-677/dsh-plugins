import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

import { ROOT, createFakeReact, loadClient, materialize } from './harness.mjs'
import { generate, generateText } from '../scripts/build-client.mjs'
import { compareVersions } from '../scripts/watch-official.mjs'

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts', 'official-baseline.json'), 'utf8'))

test('lib/client.js 与 src/ 同步（生成物不允许手改）', () => {
  const result = generate({ check: true })
  assert.equal(result.ok, true, (result.errors ?? []).join('; '))
})

test('产物是可编译的 JS，且带官方 ModuleLoader 契约', () => {
  const code = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.doesNotThrow(() => new vm.Script(code), '产物应能通过语法解析')
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(code, /factory: \(require\) => \{/)
  assert.match(code, /require\('react'\)/)
  assert.match(code, /module\.exports = \{ name, inject, apply \};/)
  assert.doesNotMatch(code, /__PLUGIN_VERSION__/, '版本占位符必须被替换')
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, '产物里不应残留 ESM 语法')
  assert.equal(generateText(), code, 'generateText 与产物逐字节一致')
})

test('产物导出的 name/inject 与 package.json 声明一致', () => {
  const { definition } = loadClient()
  const moduleExports = materialize(definition, createFakeReact())
  assert.equal(moduleExports.name, pkg.name)
  // 跨 vm realm 的数组原型不同，先转成宿主数组再比较。
  assert.deepEqual(Array.from(moduleExports.inject), ['slots', 'sessions', 'locale'])
  assert.equal(typeof moduleExports.apply, 'function')
  assert.equal(definition.id, pkg.name, 'ModuleLoader id 必须是包名')
})

test('package.json 的 bundle / client 声明满足官方契约', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
})

/** 解析 ">=下限 <上限" 形式的 peer 区间；本仓库只允许这一种形状。 */
function parsePeerSpan(range) {
  const match = /^>=(\S+)\s+<(\S+)$/.exec(String(range).trim())
  assert.ok(match !== null, 'peerRange 必须是 ">=下限 <上限" 形式：' + range)
  return { min: match[1], max: match[2] }
}

/** 取 x.y 形式的 minor 前缀，用来判断区间是否真的跨 minor。 */
function minorOf(version) {
  return String(version).split('.').slice(0, 2).join('.')
}

test('DSH peer 是跨 minor 区间，且覆盖基线运行时（自动退休的第一层）', () => {
  const peers = pkg.peerDependencies ?? {}
  assert.ok(Object.keys(peers).length >= 2, '必须声明 DSH peer 才能被启动期校验识别')
  assert.deepEqual(
    Object.keys(peers).sort(),
    [...baseline.peerPackages].sort(),
    'peer 列表必须与 official-baseline.json 的 peerPackages 一致',
  )
  assert.equal(typeof baseline.peerRange, 'string', 'official-baseline.json 必须声明 peerRange')
  for (const [name, range] of Object.entries(peers)) {
    assert.ok(name.startsWith('@deepseek-ai/dsh'), 'peer 必须是 DSH 包：' + name)
    assert.equal(range, baseline.peerRange, name + ' 的 peer 必须与 official-baseline.json 的 peerRange 一致')
  }

  const { min, max } = parsePeerSpan(baseline.peerRange)
  assert.ok(
    compareVersions(baseline.runtime, min) >= 0 && compareVersions(baseline.runtime, max) < 0,
    'peerRange 必须覆盖已验证的运行时 ' + baseline.runtime + '，否则插件会在自己验证过的版本上被门禁拦掉',
  )
  assert.notEqual(
    minorOf(min),
    minorOf(max),
    'peerRange 必须跨 minor（' + minorOf(min) + ' → ' + minorOf(max) + '）：' +
      '^0.1.x 在 0.x 语义下等于 >=0.1.x <0.2.0，精确锁死等于「DSH 每发一个 minor 就整包退场」',
  )

  for (const name of baseline.peerPackages) {
    assert.equal(baseline.pins[name], baseline.runtime, name + ' 的 pin 必须是已验证的运行时版本')
  }
})

test('宿主 half 是合法的 bundle 插件（name/inject/apply）', async () => {
  const host = await import('../lib/index.js')
  assert.equal(host.name, pkg.name)
  assert.deepEqual(host.inject, [])
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.apply(), undefined)
})

test('bundle patch 只插入一行自己的 entry，不带任何 id 定向覆盖', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-plugin-mark-unread/)
  assert.match(patch, /name: 'dsh-plugin-mark-unread'/)
  assert.doesNotMatch(patch, /^- id:/m, '不应有顶层 id 定向覆盖行（卸载后会变成悬空 patch）')
})

test('README 与 LICENSE 随包分发', () => {
  for (const file of pkg.files) {
    assert.equal(existsSync(join(ROOT, file)), true, '缺少分发文件：' + file)
  }
  assert.equal(existsSync(join(ROOT, 'README.en.md')), true)
})
