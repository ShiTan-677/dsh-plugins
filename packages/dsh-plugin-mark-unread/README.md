# dsh-plugin-mark-unread

给 DSH Web GUI 的会话列表补一个**手动「标记为未读」**。

> **这是一个过渡插件**：官方目前的未读是「自动生成的只读状态」，而 Codex 桌面端有「已读后手动标回未读」。本插件补上这个动作，并**自带退休机制**——官方一旦支持，它会自己失效并提示你卸载。详见[自动退休](#自动退休官方支持了怎么及时撤掉)。

- 运行时：DSH `0.2.0-rc.2`（`@deepseek-ai/dsh-desktop-runtime`）
- 依赖：无。运行时只用平台 baseline 的 React；构建/测试脚本只用 Node 内置模块
- Node：`^22.19.0 || >=24.0.0`（Node 20 已于 2026-04 EOL；DSH 桌面版随附 Node 24）
- 许可：MIT

---

## 为什么需要它

DSH 现在**有**未读，但它是派生状态，不是可写的标记：

- `@deepseek-ai/dsh-client-ui-session` 的客户端服务 `uiSession` 在内存里维护一个 `completionUnread` 集合：某会话从 `running` 变成空闲、且它不是当前正在看的会话时加入；当它成为主视图、再次开始运行、或从列表消失时删除。
- `@deepseek-ai/dsh-client-ui-workspace` 把它渲染成行首的完成状态点（`completed: status?.completionUnread === true`）。
- 这个集合**没有公开 setter、不落盘、不上报宿主**。`ui-sidebar` 的 Known Limitations 原文即：

  > "New task completed" unread marking is local viewing state — completion-time > last-seen never reaches the host.

所以「读过的会话再标回未读」这件事，在 DSH 里目前没有任何入口。本插件用官方给第三方插件的公开槽位把它补上，**不碰**官方包、不碰 `app.asar`、不劫持 `completionUnread`。

## 行为

| 场景 | 行为 |
| --- | --- |
| 会话行「…」菜单 | 多一项 **标记为未读 / 标记为已读**（在官方 Archive 之后） |
| 已标记未读 | 行首渲染一个小圆点（官方完成点占位时由官方点优先，不会两个点并排） |
| 打开会话（它**变成**当前视图） | 自动清除标记，等同「你看过了」；只在**运行期间观察到跃迁**时清除 |
| 对**正开着**的会话标记未读 | **保留**标记，且**重启后依然在**（Codex #13115 的诉求：标了未读回来处理） |
| 重启 / 刷新页面 | 标记仍在（存 `localStorage`，键 `dsh.mark-unread.v1`）；启动时不清除任何标记 |
| 会话从列表消失（删除 / 列表暂时不完整） | 标记**保留**（孤儿条目不可见）；存储按最近 500 条封顶，不做「不在列表里就删」 |
| GUI 语言 | 文案跟随设置里的语言实时切换（向官方 `locale` 服务注册 `dsh-mark-unread` 命名空间） |
| 官方已提供置未读能力 | 插件转惰性：菜单项与圆点都不再渲染，控制台留下提示 |

## 安装

### 方式 A：plugin_manager（推荐）

在本机任意会话里对 agent 说，或直接用 `plugin_manager` 工具：

```
install_bundle  target=/绝对路径/dsh-plugin-mark-unread
```

也可以先把仓库推到 GitHub，再装：

```
install_bundle  target=github:<你的账号>/dsh-plugin-mark-unread
```

管理器会做：校验 DSH peer → `pnpm add` → 选中为 profile bundle。桌面 profile 是**启动期**加载的，装完需要重启 DSH 应用才生效。

### 方式 B：手工

```sh
cd ~/.dsh/profiles/desktop
pnpm add /绝对路径/dsh-plugin-mark-unread
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加上 `"dsh-plugin-mark-unread"`，重启应用。

> 不要往 `cordis.patch.yml` 里加本插件的 id 定向覆盖行：本插件自带 bundle patch，手工覆盖会让卸载后留下「patch 指向不存在 entry」的警告。

## 验收清单

装完重启后：

1. 侧栏某个会话行右侧「…」→ 应出现「标记为未读」（中文界面必须是中文，见第 6 条）；
2. 点它 → 该行行首出现小圆点，刷新页面后仍在；
3. 点开这个会话 → 圆点消失（视为已读）；
4. 在会话**开着**的情况下标记未读 → 圆点保留，**重启应用后仍然保留**；切到别的会话再切回来才消失；
5. 官方菜单里若已经出现「标记为未读」，说明该卸载了（见下）；
6. 设置里把语言在中文/English 之间切换 → 菜单项文案立即跟着变，不需要重装或刷新。

> 历史坑（0.1.1 修掉）：0.1.0 会在 apply 时读一次 `<html lang>` 决定文案，而页面初始的活跃语言是浏览器推断的临时值（宿主持久化偏好稍后才到），于是中文界面被锁成英文；同一版还会在启动时清除「当前会话」的标记、并按列表快照清理标记，导致重启后未读丢失。现在文案走官方 `locale` 座位，标记只在**运行期间观察到会话跃迁**时清除。

## 自动退休：官方支持了怎么及时撤掉

官方不会通知插件作者，所以把「该退休了」做成 4 层可自动判定的信号，而不是等消息：

### 第 1 层：peer 声明成跨 minor 区间（不锁死单版本）

`package.json` 把 DSH peer 声明成一个**跨 minor 区间**——既覆盖已逐契约验证过的运行时，也覆盖同系列的后续版本：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-api-session-controller": ">=0.1.7-rc.2 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-session": ">=0.1.7-rc.2 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-slots": ">=0.1.7-rc.2 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-workspace": ">=0.1.7-rc.2 <0.3.0-0"
}
```

（即本插件实际用到的四个官方包：`sessions` 服务、`uiSession` 服务、`slots` 服务、槽位声明方。）

**为什么既不是 `^0.1.x` 也不是精确锁死。** DSH 运行时是 `0.x`，而在 0.x 语义下：

| 写法 | 实际含义 | 结果 |
| --- | --- | --- |
| `^0.1.7-rc.2` | `>=0.1.7-rc.2 <0.2.0` | **DSH 每发一个 minor，插件就无故消失** |
| `0.2.0-rc.2`（精确） | 只认这一个版本 | 同上，而且更窄 |
| `>=0.1.7-rc.2 <0.3.0-0` | 跨 minor 区间 | 同系列升级不中断，只在跨大版本时退场 |

2026-09-29 的 `0.1.7-rc.2 → 0.2.0-rc.2` 正是这样一次性打掉了一半社区插件：插件市场的兼容性快照里，63 个插件中声明了 DSH peer 的 47 个，有 **23 个（48.9%）** 在 0.2.0-rc.2 下被拒——本插件当时也在其中。这层原本写成精确锁死，那意味着「DSH 每发一个 minor 就要人工重验一次」，代价是每次升级都先经历一段插件无故消失。

启动和每次 profile 重组时，DSH 用 `getDshRuntimeVersion()` 校验 bundle 的 DSH peers；**不匹配的 bundle 会被整个跳过**并列入 `skippedBundles`（启动打印，`--dump-config` 可查）。区间写法保留的底线是：**越过上界（例如 0.3.0）时依旧整包退场，不在未验证的运行时上硬跑。**

代价要讲清楚：落在区间内、但没被逐契约验证过的运行时（例如假设的 0.2.1）不再有门禁保护。所以**真正的退休信号是第 2 层的能力探测**（官方一提供 setter，插件立刻转惰性），第 3 层的巡检负责预警；第 1 层只负责「别跨大版本乱跑」。也**不要**为它写 `compatibility.json` 的 version-exemption——区间已经覆盖了当前系列，豁免只在日后跨出上界时才有意义，而那时更该做的是重新验证。

`tests/artifact.test.mjs` 会拦住精确锁死与 `^0.1.x` 两种写法回潮，并强制 `peerRange` 覆盖 `official-baseline.json` 里已验证的 `runtime`、且区间确实跨 minor。

`0.1.7-rc.2 → 0.2.0-rc.2` 这一次同步不是单纯改版本号：已按 0.2.0-rc.2 的官方产物逐项复核过本插件用到的每个契约——`window.__ModuleLoader__.load({ id, factory })`、baseline 模块表的 `react`、`ctx.slots.inject` / `slots.register({ name, id, order, locale, inject })` 调用形状（对照官方 `dsh-client-locale` 的同款调用）、两个槽位名与 props（`sidebar.session.row.leading` 收 `{ sessionId }`；`sidebar.workspaces.session.menu.item` 收 `{ sessionId, displayTitle }` 加 `useMenuOpenState`）、`locale.register(ns, { zh, en })`，以及 `sessions.list.getSnapshot()/subscribe()` + `row.retainedBy.mainView` 判据（与官方 `ui-session` 0.2.0-rc.2 的写法逐字一致）。改 `package.json` 的 peer 时必须同时改 `scripts/official-baseline.json`——那里是唯一的真源：`runtime`/`pins` 记「验证过的版本」，`peerRange` 记「声明的区间」，`tests/artifact.test.mjs` 强制 peer 与 `peerRange` 一致、`peerRange` 覆盖 `runtime`。

### 第 2 层：运行时能力探测（自我失效）

客户端半边在 `apply()` 里探测 `uiSession` 是否出现置未读入口（`markUnread` / `markAsUnread` / `setUnread` / `toggleUnread` / `setCompletionUnread` / `markSessionUnread`）。命中就调 `store.setInert()`：菜单项与圆点全部返回 `null`，并打印

```
[dsh-plugin-mark-unread] official support detected (...); this plugin is now inert and safe to remove
```

### 第 3 层：上游探测脚本（解决「没人通知」）

这些官方包都公开发布在 npm 上，元数据稳定，所以「官方支持了吗」可以是可自动判定的：

```sh
node scripts/watch-official.mjs                    # 人类可读
node scripts/watch-official.mjs --json             # 机器可读
node scripts/watch-official.mjs --profile desktop  # 顺带报告插件是否还挂着
node scripts/watch-official.mjs --no-scan          # 只看版本，不下载 tarball
```

它做三件事：读 registry 元数据（一次 GET/包）→ 发现比基线新的版本才下载 tarball → 扫描发布产物（`README*.md`、`lib/types/**/*.d.ts`、`lib/client.js`、`dist/assets/*.js`）里的置未读 setter 名与 `unread`/`未读` 字样。

退出码即为结论：

| 退出码 | 含义 | 动作 |
| --- | --- | --- |
| `0` | 官方无更新 | 继续用 |
| `2` | 有新版本，但没扫到 setter | 人工复核一眼 |
| `10` | 扫到强信号（setter 名） | 去官方 UI 验收，然后卸载 |
| `1` | 查询失败（离线等） | 忽略，下次再跑 |

挂到 cron / launchd，或做成 DSH 的定时任务，每周一次即可；`--json` 的输出很适合存档比对。

### 第 4 层：升级后的例行验收

DSH 更新后看一眼 `skippedBundles` / 插件页错误；若本插件被跳过，先验收再决定：

- 官方菜单里是否出现「标记为未读」；
- 标记后**刷新页面是否仍然未读**（这是比 UI 文案更硬的信号：官方当前实现是进程内状态，一旦持久化就说明真做了）。

## 卸载

```sh
# 1) 去掉 bundle（顺序：从 dsh.profile.bundles 移除 → 卸载运行时贡献 → pnpm remove）
plugin_manager  action=remove_bundle  target=dsh-plugin-mark-unread
```

桌面 profile 是启动期的，若在线移除被拒（"cannot remove packages used to start the current process"），退出应用后用 `dsh plugin`（子命令以 `dsh plugin --help` 为准）或在 profile 目录 `pnpm remove dsh-plugin-mark-unread` 并删掉 `dsh.profile.bundles` 里那一行。

2) 清掉浏览器残留（就一个键）：

```js
// 在 GUI 的开发者控制台执行
localStorage.removeItem('dsh.mark-unread.v1')
```

宿主侧零残留：本插件不写任何宿主存储，`cordis.patch.yml` 也只有一行 `insert`，随 bundle 一起消失。

## 开发

```sh
node scripts/build-client.mjs          # 由 src/ 生成 lib/client.js
node scripts/build-client.mjs --check  # 产物是否与 src/ 一致（CI 用）
node --test 'tests/*.test.mjs'         # 全部用例：store 逻辑、产物契约、槽位行为、探测脚本
```

无任何依赖需要安装。`lib/client.js` 是**生成物**：改 `src/`，不要手改产物；`npm run verify` = `--check` + 全量测试。

### 目录

```
package.json                 # dsh.bundle / dsh.client 声明 + 精确 DSH peer
cordis.patch.yml             # bundle patch：只 insert 一行自己的 entry
lib/index.js                 # Node half：无宿主行为，只满足契约
lib/client.js                # 生成物：__ModuleLoader__ 包装的浏览器 half
src/store.js                 # 纯逻辑：未读标记的持久状态（可单测）
src/plugin.js                # 槽位组件 + 会话监听 + 官方能力探测
scripts/build-client.mjs     # 无依赖拼接构建 + --check
scripts/watch-official.mjs   # 官方支持探测（registry + tarball 扫描）
scripts/official-baseline.json  # 验证过的运行时/包版本基线（与 peer 锁联动）
tests/                       # node:test
```

### 为什么不用私有 API

官方 `completionUnread` 是 `uiSession` 内部的进程内集合，没有 setter。要复用官方那颗点，只能劫持该 store——依赖私有结构、官方一改就静默失效。本插件选择：

- 状态自持（`localStorage`），与官方「本地查看状态」的口径一致；
- 只挂**文档化的**公开槽位（`sidebar.session.row.leading`、`sidebar.workspaces.session.menu.item`，官方自己的 pin/rename/fork/archive 就注册在这里）；
- 行首座位只在会话行「主状态为 idle」时渲染，所以自绘点不会与官方状态点抢位。

## 局限

- 只作用于 Web/桌面 GUI；CLI/headless 没有会话列表，不适用；
- 标记是**浏览器本地**的，不跨设备、不跨浏览器 profile；
- 已删除会话留下的孤儿标记**不会自动清理**（不可见，只按最近 500 条封顶）——这是刻意的：宁可留垃圾也不误删，清理走「标记为已读」或 `localStorage.removeItem`；
- 自动清除只认「会话成为当前视图」这一次跃迁，所以对正开着的会话标未读后，要靠切走再切回（或手动取消）才能清掉；
- 官方完成点占位时（该行正在运行/有待处理交互/官方未读）行首座位不渲染，此时自绘点不可见——语义上不冲突；
- 若官方未来实现的入口名不在 `OFFICIAL_SETTERS` 列表里，第 2 层探测可能漏判，此时靠第 1、3 层兜底；
- 插件只是临时桥。真正的修法是把「标记未读（含持久化）」提给上游：<https://github.com/deepseek-ai/deepseek-harness/issues>。

## 发布到 GitHub 前

- 填 `package.json` 的 `repository` / `homepage` / `bugs`；
- 若同时发 npm，注意包名可用性；
- 在仓库名与 README 顶部保留「非官方 / 过渡插件」的表述；
- 保持 `peerDependencies` 与 `scripts/official-baseline.json` 同步（`tests/artifact.test.mjs` 会强制）；
- 每次 DSH 升级后的维护动作：复核行为 → 更新 `official-baseline.json` 与 peer 锁 → `npm run verify`。
