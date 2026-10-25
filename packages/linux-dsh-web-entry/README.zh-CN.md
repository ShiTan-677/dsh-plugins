# Linux DSH Web Entry

[English](README.md)

Linux 桌面上一键进入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
网页版（Web GUI）的入口：一个桌面启动器，直接用浏览器应用窗口打开 Web GUI；如果端口上没有服务，它会替你把 `dsh web` 起起来。

```text
双击桌面上的 "DSH Web"
  ├─ 127.0.0.1:3080 已有服务          → 直接打开 GUI
  ├─ 已安装 systemd 单元（--systemd） → systemctl --user start 后打开 GUI
  └─ 端口上没有服务                   → 在终端窗口里启动 dsh web，
                                        读出它打印的一次性 token URL 并打开
```

启动器**永远不会重启或停止正在运行的服务**，因此在你正开着 DSH 会话时使用也是安全的。卸载只需一条命令，会删掉它写过的每个文件。

**范围：仅 Linux。** 启动器由 XDG desktop 文件加一个 shell 脚本组成，依赖 `xdg-open`、Linux 终端模拟器，以及可选服务模式下的 `systemctl --user`。Windows 与 macOS 刻意不在范围内。

## 为什么不能只放一个书签

`dsh web` 用「每进程一次性 token」保护 GUI：直接请求 `http://127.0.0.1:3080/` 会得到
`401 dsh web authentication required`；只有启动时打印的
`http://127.0.0.1:3080/?token=…` 才能换到签名的浏览器 Cookie。

该 Cookie 由持久化在 `$DSH_HOME/.credentials.yaml` 的密钥签名，并绑定请求的 authority，
所以它能跨服务重启存活，干净的 URL 在 Cookie 过期（约 30 天）前一直可用。而 token 是每个进程随机生成、从不落盘的，所以启动器选择从服务控制台（终端模式）或 journald（systemd 模式）里把它捞回来，而不是去伪造。

## 安装

```sh
git clone https://github.com/ShiTan-677/linux-dsh-web-entry
cd linux-dsh-web-entry
./install.sh              # 启动器 + 桌面图标 + 应用菜单项
./install.sh --systemd    # 额外安装并启用 systemd --user 服务
./install.sh --uninstall  # 删除它安装的一切
```

不需要 root。安装器会写入：

| 路径 | 内容 |
| --- | --- |
| `~/.local/bin/dsh-web-open.sh` | 启动器 |
| `~/.local/share/applications/dsh-web.desktop` | 应用菜单 / Activities 入口 |
| `~/Desktop/dsh-web.desktop` | 桌面图标（通过 `gio` 标记为 trusted） |
| `~/.local/share/icons/dsh-web.svg` | 图标：Harness 字形 + 深色圆角底板 |
| `~/.config/systemd/user/dsh-web.service` | 仅 `--systemd` 时写入 |

图标在安装时从**你自己 DSH 安装里的** `dsh-web-frontend` favicon 组合而成：本仓库不内置任何第三方美术资源，图标会跟随你运行的 DSH 版本。

### 依赖

- 遵循 desktop entry 规范的 Linux 桌面（已在 Ubuntu 22.04 / GNOME 42 / Wayland 实测），以及一个 Chromium 系浏览器用于 `--app` 窗口。
- `dsh` 在 `PATH` 上，或 `npx`，或已存在的 `~/.npm/_npx/*` 缓存安装。启动器优先使用已解析的 npx 缓存，因此离线也能工作。
- `curl`（缺失时回退到 bash `/dev/tcp`），以及可选的 `notify-send`、`gio`。
- `--systemd` 需要 `systemd --user`，主流桌面发行版都具备。

## 两种服务模式

| | 终端模式（默认） | `--systemd` 模式 |
| --- | --- | --- |
| 启动时机 | 首次双击 | 登录时 |
| 窗口 | 一个终端窗口承载服务 | 无 |
| 日志 | 终端窗口，同时 tee 到 `~/.local/state/dsh-web/launch.log` | `journalctl --user -u dsh-web` |
| 停止 | 关闭终端窗口 | `systemctl --user stop dsh-web` |
| 常驻开销 | 空闲时为 0 | 一个 node 进程 |
| token | 从 tee 出来的控制台日志读取 | 浏览器无 Cookie 时从 journald 读取 |

安装器**不会**在端口已被其他进程占用时启动单元：它只 enable 并提示你在停掉那个实例后再 start，从而避免绑定失败的重启循环。当 `DSH_WEB_SYSTEMD_UNIT_DIR` 指向标准目录之外时，它也拒绝替你 enable。

## 配置项

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_WEB_PORT` | `3080` | 启动器探测的端口，同时传给 `dsh web` 并写入单元 |
| `DSH_WEB_BROWSER` | `google-chrome` | `--app` 窗口使用的浏览器 |
| `DSH_WEB_START_TIMEOUT` | `60` | 等待服务或其 token 的秒数 |
| `DSH_WEB_DRY_RUN` | `0` | `1` 只打印计划动作而不真正执行 |
| `DSH_WEB_SYSTEMD_UNIT` | `dsh-web.service` | 启动器要启动的单元名 |
| `DSH_WEB_SYSTEMD_UNIT_FILE` | XDG 配置目录 | 启动器检查 opt-in 用的单元路径 |
| `DSH_WEB_PREFIX` | `~/.local` | 安装前缀（安装器） |
| `DSH_WEB_DESKTOP_DIR` | XDG 桌面目录 | 桌面图标复制到哪（安装器） |
| `DSH_WEB_SYSTEMD_UNIT_DIR` | XDG 配置目录 | 单元文件写到哪（安装器） |

`dsh-web-open.sh` 还接受 `--status`（打印 `200`、`401` 或 `000`）与 `--help`。

## 测试

```sh
tools/selftest.sh
```

共 36 项检查：回环桩服务返回 `200`/`401`、用真实的 `wait_for_token` 解析 `dsh web` 控制台的真实输出形状、桩 `dsh` 验证 `--serve` 的 argv 与 tee、桩 `systemctl`/`journalctl` 覆盖 systemd 模式及其「没有用户管理器」的回退路径，以及在沙箱里安装/卸载并对生成的单元跑 `systemd-analyze verify`。它不会碰你的真实桌面、DSH home 或用户管理器。

[`docs/VALIDATION.md`](docs/VALIDATION.md) 记录了验证环境、每条结论背后的证据，以及**尚未**实测的部分。

## 路线图

- 第二个交付面已作为独立的公开仓库发布：[`dsh-linux-desktop-entry`](https://github.com/ShiTan-677/dsh-linux-desktop-entry)
  把同一套 `install.sh` 操作暴露为设置页、agent 工具与 `/desktop-entry` 命令。它携带本套件的一份副本而不是依赖本仓库，因此两个仓库中的任何一个都可以独立使用、移动或停止发布。
- 非 GNOME 终端：先尝试 `gnome-terminal`，再尝试 `x-terminal-emulator`；其他终端需要各自的调用方式。
- 端口是契约的一部分（浏览器 Cookie 绑定 `host:port`），所以改动 `DSH_WEB_PORT` 后需要用打印出的 token URL 重新登录一次。

## 许可

[MIT](LICENSE)
