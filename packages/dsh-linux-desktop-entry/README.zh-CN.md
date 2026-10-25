# DSH Linux Desktop Entry

[English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把
[Linux DSH Web Entry](https://github.com/ShiTan-677/linux-dsh-web-entry) 的桌面启动器纳入
harness 自身的控制：设置页、agent 工具、`/desktop-entry` 命令——三个入口驱动同一套实现。

桌面入口本身——启动器、应用菜单项、受信任的桌面图标，以及可选的 `systemd --user` 服务
——来自 Linux DSH Web Entry 项目。本插件携带该 shell 套件的一份副本并调用它，绝不重新实现
安装、卸载或启动逻辑。

```text
设置 → 桌面入口                 agent: desktop_entry            输入框: /desktop-entry
  [已安装]                        {"action": "status"}            /desktop-entry status
  安装 · 卸载                     {"action": "install",           /desktop-entry install
  用应用窗口打开                    "systemd": false}             /desktop-entry open
```

## 这个插件能做什么、不能做什么

边界是结构性的，不是投入程度问题，所以说清楚。

| | |
| --- | --- |
| **能做** | 在运行中的 harness 内安装、修复、卸载、查看桌面入口；用浏览器应用窗口打开 GUI；选择常驻服务；以上任何一项都可交给 agent 执行。 |
| **不能做** | 在 DSH 未运行时把 DSH 启动起来。那是桌面文件的职责，发生在进程之外。 |

所以插件是同一个桌面入口的**第二个投递面**，而不是它的替代品。如果你只想要启动器、不想碰插件，
直接用 shell 项目——它是一个自包含的 `git clone && ./install.sh`。

## 安装

```sh
git clone https://github.com/ShiTan-677/dsh-linux-desktop-entry
```

然后用 Plugin Manager 把 bundle 装进你的 profile，指向这份 clone：

```text
plugin_manager install_bundle /absolute/path/to/dsh-linux-desktop-entry
```

三个前置条件，缺哪一个都会产生明确的报错：

- **Linux。** 其他平台会明确回报 unsupported，而不是给出无法执行的操作。
- **一个 DSH profile**，且 DSH 进程的 `PATH` 上有 `pnpm`。`install_bundle` 用 `pnpm add`
  安装包；没有它会在这一步失败。
- **clone 必须留在原地。** `install_bundle` 记录的是 `link:` 依赖，profile 直接指向你的
  检出目录。移动或删除它会让插件失效；请先用 Plugin Manager 移除 bundle。

安装时**不会**向你的桌面写入任何东西。设置页只显示磁盘现状，等你点击。

## 你会得到什么

### 设置 → 桌面入口

一个页面报告状态并提供操作：每个已安装文件是否存在、端口上是否有服务在监听，以及常驻单元的
**真实**状态——路径加上 `is-enabled` / `is-active`，或者它为何没被使用。按钮：**安装**
（已安装时为**重新安装**，用于修复）、**卸载**、**用应用窗口打开**、**刷新**。

### `desktop_entry` agent 工具

一个带 `action` 参数的工具——`status`、`install`、`uninstall`、`open`——以及可选的
`systemd` 标志。让 agent「给 harness Web GUI 装一下桌面入口」，它会先查看、再动手，并回传
安装脚本自己的输出。

`status` 不改变任何东西，所以是安全的第一步。

### `/desktop-entry` 命令

```text
/desktop-entry                      # 查看状态
/desktop-entry install              # 只装桌面入口
/desktop-entry install --systemd    # 再加一个常驻的 systemd --user 服务
/desktop-entry uninstall            # 存在单元时一并移除
/desktop-entry open                 # 立即打开 GUI
```

## 常驻服务是可选项

**所有入口都默认关闭。** 勾选复选框——或传入 `--systemd`——才会写入并启用一个
`systemd --user` 单元，让 GUI 从登录起就被服务。

代价在界面上写清楚了：这会让一个 node 进程常驻并占用资源，即使没有窗口打开。默认路径在首次
双击时启动服务，空闲时零开销。按机器自行取舍。

卸载会同时停止并移除该单元，因此卸载插件的桌面入口不会留下一个在背后运行的服务。

如果你要挪动单元，请为两个面一起挪：安装器写到 `DSH_WEB_SYSTEMD_UNIT_DIR`，而启动器只读
`DSH_WEB_SYSTEMD_UNIT_FILE`。两者不一致时，页面会明确指出来，且打开时仍会退回终端窗口
——一个启动器从不读取的单元文件不是常驻服务。

只有一个单元文件也不够：启动器还需要可达的 `systemd --user` 管理器，所以 `status` 报告的是
`is-enabled` / `is-active`，而不是文件是否存在。

## vendor 的 shell 套件

`vendor/linux-dsh-web-entry/` 是
[linux-dsh-web-entry](https://github.com/ShiTan-677/linux-dsh-web-entry) **运行时载荷**的
逐字节副本：安装脚本、启动器、两个模板、图标合成脚本、载荷自带的自检，以及许可证。
Host 半侧运行其中的 `install.sh` 与 `bin/dsh-web-open.sh`。

选择两个仓库而非一个，是为了让各自独立：任何一个未发布、不可用或被移动，都不会影响另一个。
独立的代价是漂移，所以漂移被做成**可检测**而不是只写在文档里——只要存在同源的
`../linux-dsh-web-entry` 检出，`tools/selftest-plugin.mjs` 就会逐项核对每个载荷文件：必须存在
且逐字节一致，且副本中不得出现清单之外的文件；独立 clone 则跳过该比对并明确说明。

`PROVENANCE.md` 记录了上游 commit、版本，以及重新 vendor 意味着什么。

## 测试

```sh
node tools/selftest-plugin.mjs     # 57 项：本插件的表面
vendor/linux-dsh-web-entry/tools/selftest.sh   # 36 项：vendor 的 shell 套件
```

插件自检用假的 Cordis context 直接驱动 Host 半侧的 HTTP 处理器、agent 工具与命令，因此在没有
浏览器、没有 cookie 的情况下也能检查路由契约（信任围栏、方法、content-type、请求体上限、
action 校验）与三个调用者。

所有安装路径——包括 `systemd --user` 单元目录——在任何处理器运行之前都被重定向到临时目录，
因此安装/卸载循环会用真实的 `install.sh` 打到沙箱上，不触碰你的任何东西。同样出于这个原因，
测试从不向安装脚本请求 `--systemd`：那条路径最终会走 `systemctl --user`，而它是按**名字**
通过活的用户管理器解析单元的。

浏览器中设置页的**视觉**验证不在自动测试范围内；见下节。

### 已知边界

- 设置页的验证到「live slot 注册（`settings.section`）」、语法与解析检查、以及其按钮所调用的
  路由契约为止；没有通过读取渲染后的浏览器页面来验证。
- 页面文字只有英文。尚未接入 harness 的 locale 服务；插件自身的显示元数据同时提供
  `locale/en.json` 与 `locale/zh.json`。
- `systemd` 安装路径只由 vendor 的 shell 套件自检覆盖，未经过本插件的路由。

## 依赖

- Linux、符合桌面入口规范的桌面环境，以及用于应用窗口的 Chromium 系浏览器——细节由 shell
  项目负责。
- 带 profile 的 DSH，且 DSH 进程可达 `pnpm`。

## 许可

[MIT](LICENSE)。vendor 的 shell 套件保留其自己的副本：
`vendor/linux-dsh-web-entry/LICENSE`。
