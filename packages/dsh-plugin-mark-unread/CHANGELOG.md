# Changelog

本文件记录本插件的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> **历史说明**：本仓库在 0.1.2 之前**没有打 tag、也没有 CHANGELOG**，提交历史被压缩成单个 commit，
> 因此无法逐次还原准确的版本边界。为保证可信，下面只记录**有据可查**的内容；
> 早期版本的完整行为以 [README.md](./README.md) 的「行为」与「历史坑」两节为准。

## [Unreleased]

### Added

- `package.json` 补齐 `repository` / `homepage` / `bugs` —— 即 README「发布到 GitHub 前」一节列出的待办。
- `packageManager: pnpm@11.7.0`，与 DSH 桌面版随附的 pnpm 版本一致，让本地安装可复现。
- GitHub Actions CI（`.github/workflows/ci.yml`）：在 Node 22 与 24 上运行 `npm run verify`
  （产物一致性校验 + 全量 `node:test`）。工作流零依赖、不启用缓存。

### Changed

- `engines.node` 由 `>=20` 收紧为 `^22.19.0 || >=24.0.0`。理由：Node 20 已于 2026-04 EOL，
  且 DSH 桌面版随附 Node 24（见 `runtime.json`）。README 的运行时说明同步更新。

## [0.1.2]

当前发布的版本。行为以 [README.md](./README.md) 为准，要点：

- 会话行「…」菜单提供「标记为未读 / 标记为已读」，行首渲染未读圆点。
- 标记持久化在 `localStorage`（键 `dsh.mark-unread.v1`），重启后仍在。
- 文案走官方 `locale` 服务注册的 `dsh-mark-unread` 命名空间，跨语言实时切换。
- 自带 4 层自动退休机制：跨 minor 的 peer 区间 / 运行时能力探测 /
  上游巡检脚本 `scripts/watch-official.mjs` / 升级后例行验收。
- 不触碰官方私有 API，不劫持 `uiSession.completionUnread`，宿主侧零残留。

## 0.1.0 – 0.1.1

**未逐条记录。** 据 README「历史坑（0.1.1 修掉）」一节，0.1.0 存在两个缺陷，0.1.1 修复：

1. 在 `apply` 时读一次 `<html lang>` 决定文案 —— 页面初始活跃语言是浏览器推断的临时值，
   导致中文界面被永久锁成英文。0.1.1 改为使用官方 `locale` 服务的投影座位。
2. 启动时清除「当前会话」的标记、并按列表快照清理标记 —— 导致重启后未读丢失。
   0.1.1 起只在**运行期间观察到会话跃迁**时清除。
