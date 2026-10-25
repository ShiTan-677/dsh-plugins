/**
 * 「官方是不是已经支持标记未读了？」探测脚本。
 *
 * 背景：官方不会通知插件作者。所以把「官方支持」变成一个可自动判定的信号：
 *   1. 只读 npm registry 元数据（一次 GET/包），发现比基线新的版本；
 *   2. 有新版本才下载 tarball，扫描发布产物里的置未读入口：
 *      - 强信号：`markUnread` / `markAsUnread` / `setUnread` / `toggleUnread` /
 *        `setCompletionUnread` 这类 setter 名，出现在 .d.ts / client.js / README；
 *      - 弱信号：`unread` / `未读` 字样（README 描述、内部字段名）；
 *   3. 输出结论与退出码，便于 cron / launchd / DSH schedule 定期跑：
 *        0  没有更新，什么都不用做
 *        2  有更新但未见置未读能力 —— 人工复核
 *        10 强信号命中 —— 官方很可能已支持，验收后卸载本插件
 *
 * 用法：
 *   node scripts/watch-official.mjs                     # 人类可读
 *   node scripts/watch-official.mjs --json              # 机器可读
 *   node scripts/watch-official.mjs --profile desktop   # 附带：profile 里是否还挂着本插件
 *   node scripts/watch-official.mjs --no-scan           # 只看版本，不下载 tarball
 *
 * 无第三方依赖：Node ≥20 的全局 fetch + node:zlib 自带 tar 解析。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const REGISTRY = 'https://registry.npmjs.org/'
const FETCH_TIMEOUT_MS = 30_000
const MAX_SCAN_BYTES = 8 * 1024 * 1024

/** 退出码语义（同时写进 --json 的 verdict）。 */
export const EXIT = { CURRENT: 0, REVIEW: 2, OFFICIAL: 10, ERROR: 1 }

/**
 * 解析 semver（够用即可：主/次/修订 + 预发布标识）。
 *
 * @param {string} value 形如 `0.1.7-rc.2`。
 * @returns {{ nums: number[], pre: string[] }} 解析结果。
 */
export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/, '')
  const dash = text.indexOf('-')
  const main = dash === -1 ? text : text.slice(0, dash)
  const pre = dash === -1 ? '' : text.slice(dash + 1)
  const nums = main.split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
  while (nums.length < 3) nums.push(0)
  return { nums: nums.slice(0, 3), pre: pre === '' ? [] : pre.split('.') }
}

/**
 * semver 优先级比较（prerelease 低于同版本正式版）。
 *
 * @param {string} a 左版本。
 * @param {string} b 右版本。
 * @returns {-1 | 0 | 1} a<b 为 -1，a>b 为 1。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < length; i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 扫描一段文本，找出置未读相关的证据。
 *
 * @param {string} file 文件路径（用于报告）。
 * @param {string} text 文本内容。
 * @param {{ strongTokens: string[], weakTokens: string[], ignoreLinePattern?: string, limit?: number }} config 词表与忽略规则。
 * @returns {{ file: string, strength: 'strong' | 'weak', token: string, line: number, context: string }[]} 命中列表。
 */
export function scanText(file, text, config) {
  const limit = config.limit ?? 5
  const strong = config.strongTokens ?? []
  const weak = config.weakTokens ?? []
  const ignore = config.ignoreLinePattern === undefined || config.ignoreLinePattern === ''
    ? null
    : new RegExp(config.ignoreLinePattern, 'i')
  const found = []
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (ignore !== null && ignore.test(line)) continue
    let token = null
    let strength = null
    for (const candidate of strong) {
      if (line.includes(candidate)) {
        token = candidate
        strength = 'strong'
        break
      }
    }
    if (token === null) {
      for (const candidate of weak) {
        if (line.includes(candidate)) {
          token = candidate
          strength = 'weak'
          break
        }
      }
    }
    if (token === null) continue
    found.push({
      file,
      strength,
      token,
      line: index + 1,
      context: line.trim().slice(0, 200),
    })
    if (found.length >= limit) break
  }
  return found
}

function readString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim()
}

/**
 * 解析 tar（ustar）内容，只取普通文件。
 *
 * @param {Buffer} buffer 未压缩的 tar 字节。
 * @returns {{ name: string, data: Buffer }[]} 条目。
 */
export function parseTar(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    let empty = true
    for (const byte of header) {
      if (byte !== 0) {
        empty = false
        break
      }
    }
    if (empty) break
    const name = readString(header, 0, 100)
    const sizeField = readString(header, 124, 12)
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    const typeflag = String.fromCharCode(header[156] ?? 48)
    const prefix = readString(header, 345, 155)
    const path = prefix === '' ? name : prefix + '/' + name
    const safeSize = Number.isFinite(size) && size > 0 ? size : 0
    const dataStart = offset + 512
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      entries.push({ name: path, data: buffer.subarray(dataStart, dataStart + safeSize) })
    }
    offset = dataStart + Math.ceil(safeSize / 512) * 512
  }
  return entries
}

/**
 * 解压并解析 npm tarball。
 *
 * @param {Buffer} gzipped tgz 字节。
 * @returns {{ name: string, data: Buffer }[]} 条目（名字带 `package/` 前缀）。
 */
export function extractTarball(gzipped) {
  return parseTar(gunzipSync(gzipped))
}

async function fetchWithTimeout(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url)
  return response
}

function packageUrl(name) {
  return REGISTRY + encodeURIComponent(name).replace('%40', '@')
}

/**
 * 查一个包的 registry 元数据，判断有没有比基线新的版本。
 *
 * @param {string} name 包名。
 * @param {string} pin 基线版本。
 * @returns {Promise<object>} 探测结果。
 */
export async function inspectPackage(name, pin) {
  const response = await fetchWithTimeout(packageUrl(name), { headers: { accept: 'application/json' } })
  const meta = await response.json()
  const versions = Object.keys(meta.versions ?? {})
  const newer = versions.filter((version) => compareVersions(version, pin) > 0)
  newer.sort(compareVersions)
  const newest = newer.length > 0 ? newer[newer.length - 1] : null
  return {
    name,
    pin,
    distTags: meta['dist-tags'] ?? {},
    newer,
    newest,
    tarball: newest === null ? null : meta.versions[newest]?.dist?.tarball ?? null,
  }
}

function matchesScanPattern(name, pattern) {
  return new RegExp(pattern).test(name)
}

/**
 * 下载一个版本并扫描其中的置未读证据。
 *
 * @param {object} info inspectPackage 的结果。
 * @param {object} baseline 基线配置（词表与文件匹配）。
 * @returns {Promise<{ matches: object[], scanned: number, error: string | null }>} 扫描结果。
 */
export async function scanPackage(info, baseline) {
  if (info.tarball === null) return { matches: [], scanned: 0, error: null }
  const response = await fetchWithTimeout(info.tarball)
  const buffer = Buffer.from(await response.arrayBuffer())
  const entries = extractTarball(buffer)
  const matches = []
  let scanned = 0
  for (const entry of entries) {
    if (!matchesScanPattern(entry.name, baseline.scanFilePattern)) continue
    if (entry.data.length > MAX_SCAN_BYTES) continue
    scanned += 1
    matches.push(...scanText(entry.name, entry.data.toString('utf8'), {
      strongTokens: baseline.strongTokens,
      weakTokens: baseline.weakTokens,
      ignoreLinePattern: baseline.ignoreLinePattern,
      limit: 3,
    }))
  }
  return { matches, scanned, error: null }
}

function pluginStillInstalled(profileName) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const manifestPath = join(home, 'profiles', profileName, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    return { checked: true, path: manifestPath, installed: bundles.includes('dsh-plugin-mark-unread') }
  } catch (error) {
    return { checked: false, path: manifestPath, installed: null, error: String(error) }
  }
}

function parseArgs(argv) {
  const options = { json: false, scan: true, profile: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--no-scan') options.scan = false
    else if (arg === '--profile') {
      options.profile = argv[index + 1] ?? null
      index += 1
    }
  }
  return options
}

/**
 * 跑一次完整探测。
 *
 * @param {{ json?: boolean, scan?: boolean, profile?: string | null, root?: string }} [options] 选项。
 * @returns {Promise<{ exitCode: number, report: object }>} 结论。
 */
export async function run(options = {}) {
  const root = options.root ?? ROOT
  const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'official-baseline.json'), 'utf8'))
  const report = {
    checkedAt: new Date().toISOString(),
    runtime: baseline.runtime,
    packages: [],
    verdict: 'current',
    hits: [],
    scanErrors: [],
  }
  for (const [name, pin] of Object.entries(baseline.pins)) {
    try {
      const info = await inspectPackage(name, pin)
      const record = { ...info, scanned: 0 }
      if (options.scan !== false && info.newest !== null) {
        const scan = await scanPackage(info, baseline)
        record.scanned = scan.scanned
        record.matches = scan.matches
        if (scan.error !== null) report.scanErrors.push({ name, error: scan.error })
        report.hits.push(...scan.matches)
      }
      report.packages.push(record)
    } catch (error) {
      report.packages.push({ name, pin, error: String(error) })
      report.scanErrors.push({ name, error: String(error) })
    }
  }

  const strong = report.hits.filter((hit) => hit.strength === 'strong')
  const anyNewer = report.packages.some((entry) => Array.isArray(entry.newer) && entry.newer.length > 0)
  report.verdict = strong.length > 0 ? 'official-likely' : anyNewer ? 'review' : 'current'
  if (options.profile !== null && options.profile !== undefined) {
    report.profile = { name: options.profile, plugin: pluginStillInstalled(options.profile) }
  }
  const exitCode = report.verdict === 'official-likely'
    ? EXIT.OFFICIAL
    : report.verdict === 'review' ? EXIT.REVIEW : EXIT.CURRENT
  return { exitCode, report }
}

function printHuman(report) {
  console.log('[watch-official] 基线运行时 ' + report.runtime + ' @ ' + report.checkedAt)
  for (const entry of report.packages) {
    if (entry.error !== undefined) {
      console.log('  ' + entry.name + ': 查询失败 — ' + entry.error)
      continue
    }
    const tags = Object.entries(entry.distTags).map(([tag, version]) => tag + '=' + version).join(' ')
    console.log('  ' + entry.name + ': pin=' + entry.pin + (entry.newest === null ? '（无更新）' : ' → ' + entry.newest + '（' + entry.newer.length + ' 个新版本）') + (tags === '' ? '' : '  ' + tags))
    for (const match of entry.matches ?? []) {
      console.log('    [' + match.strength + '] ' + match.token + ' @ ' + match.file + ':' + match.line + ' — ' + match.context)
    }
  }
  if (report.profile !== undefined) {
    const state = report.profile.plugin
    console.log('  profile ' + report.profile.name + ': ' + (state.checked
      ? (state.installed === true ? '本插件仍挂在 bundle 列表里' : '本插件已不在 bundle 列表里')
      : '读取失败 — ' + state.error))
  }
  if (report.verdict === 'official-likely') {
    console.log('\n结论：官方产物里出现了置未读 setter 名（强信号）。')
    console.log('下一步：在官方 UI 里验收（标记未读 + 刷新后仍在），然后卸载本插件：')
    console.log('  plugin_manager remove_bundle target=dsh-plugin-mark-unread（或 dsh plugin，重启后生效）')
  } else if (report.verdict === 'review') {
    console.log('\n结论：官方有更新，但未扫到置未读 setter 名。人工看一眼上面的弱信号，或直接跑 --json 存档。')
  } else {
    console.log('\n结论：官方仍无更新。插件继续用着就行。')
  }
}

// CLI 入口（被 import 时不执行）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2))
  try {
    const { exitCode, report } = await run(options)
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else printHuman(report)
    process.exit(exitCode)
  } catch (error) {
    console.error('[watch-official] ' + String(error))
    process.exit(EXIT.ERROR)
  }
}
