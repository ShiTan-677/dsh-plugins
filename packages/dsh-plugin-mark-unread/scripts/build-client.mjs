/**
 * 生成 lib/client.js（分发的浏览器 half 产物）。
 *
 * 契约（与官方 client 内核一致）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) → { name, inject, apply }
 *
 * 本插件不需要打包器：源码是普通 JavaScript（不用 JSX），
 * 因此构建 = 把 src/store.js 与 src/plugin.js 顺序拼进 factory 闭包，
 * 并把 `__PLUGIN_VERSION__` 替换为 package.json 的 version。
 * React 走平台 baseline 模块表（`require('react')`），不打包进来。
 *
 * `--check` 在内存重新生成后与已提交产物逐字节比对（CI / pre-commit 用）：
 * 产物是生成物，改代码请改 src/，不要手改 lib/client.js。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCES = ['src/store.js', 'src/plugin.js']
const OUTPUT = 'lib/client.js'
const VERSION_TOKEN = '__PLUGIN_VERSION__'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 去掉源码里的 ESM 关键字，并拒绝任何模块依赖。
 *
 * @param {string} source 源文件内容。
 * @param {string} file 相对路径（报错用）。
 * @returns {string} 可直接内联进函数体的代码。
 */
export function stripModuleSyntax(source, file) {
  const lines = []
  for (const line of source.split('\n')) {
    if (/^\s*(import|export)\s*[{*]/.test(line) || /^\s*import\s/.test(line)) {
      throw new Error(file + ': client 源码不允许 import/export —— ' + line.trim())
    }
    lines.push(line.startsWith('export ') ? line.slice('export '.length) : line)
  }
  const text = lines.join('\n')
  if (/^\s*export\s/m.test(text)) throw new Error(file + ': 仍残留 export（只支持行首 `export ` 前缀）')
  return text
}

/**
 * 生成产物文本。
 *
 * @param {{ root?: string }} [options]
 * @returns {string} lib/client.js 的完整内容。
 */
export function generateText(options = {}) {
  const root = options.root ?? ROOT
  const pkg = readJson(join(root, 'package.json'))
  const pluginId = pkg.name
  const version = pkg.version
  const parts = []
  for (const relative of SOURCES) {
    const source = readFileSync(join(root, relative), 'utf8')
    parts.push('// ---- ' + relative + ' ' + '-'.repeat(Math.max(0, 60 - relative.length)) + '\n' + stripModuleSyntax(source, relative))
  }
  const body = parts.join('\n\n').replaceAll(VERSION_TOKEN, version)
  if (body.includes(VERSION_TOKEN)) throw new Error('版本占位符未被替换')
  return [
    '// 生成物，请勿手改：改 src/ 后运行 `node scripts/build-client.mjs`。',
    '// 契约：window.__ModuleLoader__.load({ id, factory }) → factory(require) 返回 { name, inject, apply }。',
    'window.__ModuleLoader__.load({',
    '\tid: ' + JSON.stringify(pluginId) + ',',
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tconst React = require(\'react\');',
    '',
    body,
    '',
    '\t\tmodule.exports = { name, inject, apply };',
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
}

/**
 * 写入或校验产物。
 *
 * @param {{ check?: boolean, root?: string }} [options]
 * @returns {{ ok: boolean, changed?: boolean, path?: string, errors?: string[] }}
 */
export function generate(options = {}) {
  const root = options.root ?? ROOT
  const check = options.check === true
  const output = join(root, OUTPUT)
  const text = generateText({ root })
  if (check) {
    let committed = null
    try {
      committed = readFileSync(output, 'utf8')
    } catch {
      return { ok: false, errors: [OUTPUT + ' 不存在：运行 `node scripts/build-client.mjs` 生成'] }
    }
    if (committed !== text) {
      return { ok: false, errors: [OUTPUT + ' 与 src/ 不一致：重新生成（禁止手改生成物）'] }
    }
    return { ok: true, changed: false, path: output }
  }
  let previous = null
  try {
    previous = readFileSync(output, 'utf8')
  } catch {
    previous = null
  }
  if (previous !== text) writeFileSync(output, text)
  return { ok: true, changed: previous !== text, path: output }
}

// CLI 入口（被 import 时不执行）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = generate({ check: process.argv.includes('--check') })
  if (!result.ok) {
    for (const error of result.errors ?? []) console.error('[build-client] ' + error)
    process.exit(1)
  }
  console.log(result.changed === true
    ? '[build-client] 已生成 ' + OUTPUT
    : '[build-client] ' + OUTPUT + ' 已是最新')
}
