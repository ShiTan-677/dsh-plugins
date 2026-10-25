# AGENTS.md

本文件写给在本仓库工作的 agent。只记**仓库地图**与**工具的具体坑**，不写项目介绍
（项目介绍在 [README.md](./README.md)）。

## 仓库地图

```
package.json                    dsh.bundle / dsh.client 声明 + DSH peer
cordis.patch.yml                bundle patch：只 insert 一行自己的 entry
lib/index.js                    Node half：无宿主行为，只满足 bundle 契约（手写，不是生成物）
lib/client.js                   浏览器 half —— **生成物，禁止手改**
src/store.js                    纯逻辑：未读标记的持久状态（可单测）
src/plugin.js                   槽位组件 + 会话监听 + 官方能力探测（客户端源码）
scripts/build-client.mjs        零依赖拼接构建；--check 做逐字节新鲜度校验
scripts/official-baseline.json  **唯一真源**：已验证的运行时版本 + peer 区间
scripts/watch-official.mjs      上游能力巡检（读 npm registry + 扫 tarball）
tests/                          node:test；artifact.test.mjs 是仓库的契约守卫
```

运行时（浏览器 half）由 `scripts/build-client.mjs` 把 `src/store.js` + `src/plugin.js`
拼进 `window.__ModuleLoader__.load({ id, factory })` 的闭包。

## 一条命令

```sh
npm run verify     # = build-client.mjs --check + 全量测试。提交前唯一必跑项
```

## 工具的具体坑

- **`lib/client.js` 是生成物，必须提交，但绝不能手改。** 改 `src/` 后跑
  `node scripts/build-client.mjs`。CI 用 `--check` 逐字节比对，手改会在 CI 红。
  （这与"生成物应该 gitignore"的直觉相反，是刻意的：只有这样 CI 才能发现"改了源码忘了重新生成"。）
- **`src/plugin.js` / `src/store.js` 里不允许 `import` / `export` / 顶层 `await`。**
  它们会被内联进一个函数体，构建脚本会直接抛错。
- **`npm test` 不用加 `--`**，脚本已带 `--test`。
- **React 必须走平台 baseline 模块表**（`require('react')`），不要打包进来、不要引 CDN。
- **不要给本包加 `"sideEffects": false`。** `lib/client.js` 的作用**就是**副作用
  （向 `ModuleLoader` 注册），声明成无副作用会让打包器有机会丢掉整个插件。

## 不可破坏的不变量

- **DSH peer 区间必须跨 minor，且与 `scripts/official-baseline.json` 保持一致。**
  禁止 `^0.1.x` 与精确锁死：在 0.x 语义下 `^0.1.7-rc.2` 等于 `>=0.1.7-rc.2 <0.2.0`，
  **DSH 每发一个 minor 插件就整包静默退场**。改 peer 必须同时改 baseline，
  `tests/artifact.test.mjs` 会强制两者一致并覆盖已验证运行时。
- **不要写 profile 的 `package.json` / `cordis.patch.yml`，不要在 profile 目录跑 pnpm。**
  安装走 `plugin_manager` 的 `install_bundle`，它负责这些步骤。
- **文案必须走官方 `locale` 服务**（`ctx.locale.register`），
  **不得在 `apply` 时读 `<html lang>` 决定语言** —— 页面初始活跃语言是浏览器推断的临时值，
  宿主持久化偏好稍后才到，会把中文界面永久锁成英文（0.1.0 踩过，见 CHANGELOG）。
- **只在运行期间观察到会话跃迁时清除标记**，启动时不清除任何标记（0.1.0 踩过）。
- **不碰官方私有 API**：不劫持 `uiSession.completionUnread`，只注册公开槽位。

## 契约到哪里查

DSH 插件契约（manifest 字段、patch 方言、槽位、生命周期）以**官方 skill** 为准：
agent 预设切到 `cordis` 会挂载 `cordis-plugin-development` 及其 `references/`。
不要凭记忆写这里没写到的 API。
