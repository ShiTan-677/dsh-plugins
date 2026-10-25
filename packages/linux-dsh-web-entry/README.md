# Linux DSH Web Entry

[简体中文](README.zh-CN.md)

One-click entrance to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web GUI on Linux desktops: a desktop launcher that opens the GUI in a browser app window
and, when nothing is listening, starts `dsh web` for you.

```text
double-click "DSH Web"
  ├─ server already on 127.0.0.1:3080        → open the GUI
  ├─ systemd unit installed (--systemd)      → systemctl --user start, then open the GUI
  └─ nothing listening                       → start `dsh web` in a terminal window,
                                               read its one-time token URL, open that
```

The launcher **never restarts or stops a server that is already running**, so it is safe to
use while a DSH session is live. Uninstall is one command and removes every file it wrote.

**Scope: Linux only.** The launcher is an XDG desktop file plus a shell script that relies
on `xdg-open`, a Linux terminal emulator, and `systemctl --user` for the optional service
mode. Windows and macOS are deliberately out of scope.

## Why a bookmark is not enough

`dsh web` protects the GUI with a per-process launch token. A bare request to
`http://127.0.0.1:3080/` answers `401 dsh web authentication required`; only the URL printed
at startup — `http://127.0.0.1:3080/?token=…` — is exchanged for a signed browser cookie.

That cookie is signed with a secret persisted in `$DSH_HOME/.credentials.yaml` and bound to
the request authority, so it survives server restarts and the clean URL keeps working until
the cookie expires (about 30 days). The token itself is random per process and is never
written to disk, which is why the launcher recovers it from the server console
(terminal mode) or from journald (systemd mode) instead of trying to construct it.

## Install

```sh
git clone https://github.com/ShiTan-677/linux-dsh-web-entry
cd linux-dsh-web-entry
./install.sh              # launcher + desktop icon + app-menu entry
./install.sh --systemd    # also install and enable a systemd --user service
./install.sh --uninstall  # remove everything it installed
```

No root is required. The installer writes:

| Path | What |
| --- | --- |
| `~/.local/bin/dsh-web-open.sh` | the launcher |
| `~/.local/share/applications/dsh-web.desktop` | Activities / app-menu entry |
| `~/Desktop/dsh-web.desktop` | the desktop icon, marked trusted via `gio` |
| `~/.local/share/icons/dsh-web.svg` | icon: the Harness glyph on an app tile |
| `~/.config/systemd/user/dsh-web.service` | only with `--systemd` |

The icon is composed at install time from the `dsh-web-frontend` favicon inside your own
DSH installation, so no third-party artwork is vendored here and the icon tracks whatever
DSH version you run.

### Requirements

- A Linux desktop that follows the desktop entry spec (tested on Ubuntu 22.04 / GNOME 42,
  Wayland) and a Chromium-family browser for the `--app` window.
- `dsh` on `PATH`, or `npx`, or an existing `~/.npm/_npx/*` cache install of
  `@deepseek-ai/dsh`. The launcher prefers the resolved npx cache so it works offline.
- `curl` (falls back to bash `/dev/tcp`), plus optional `notify-send` and `gio`.
- For `--systemd`: `systemd --user`, which every mainstream desktop distribution provides.

## Server modes

| | Terminal mode (default) | `--systemd` mode |
| --- | --- | --- |
| Starts at | the first double-click | login |
| Window | one terminal window holds the server | none |
| Logs | the terminal window, tee'd to `~/.local/state/dsh-web/launch.log` | `journalctl --user -u dsh-web` |
| Stop | close the terminal window | `systemctl --user stop dsh-web` |
| Resident cost | 0 when idle | one node process |
| Token | read from the tee'd console log | read from journald when the browser has no cookie |

The installer will **not** start the unit while another process already serves the port; it
enables the unit and tells you to start it after stopping that instance, which avoids a
bind-failure restart loop. It also refuses to enable anything when
`DSH_WEB_SYSTEMD_UNIT_DIR` points outside the standard unit directory.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_WEB_PORT` | `3080` | Port the launcher probes, passes to `dsh web`, and bakes into the unit |
| `DSH_WEB_BROWSER` | `google-chrome` | Browser used for the `--app` window |
| `DSH_WEB_START_TIMEOUT` | `60` | Seconds to wait for the server or its token |
| `DSH_WEB_DRY_RUN` | `0` | `1` prints the planned actions instead of taking them |
| `DSH_WEB_SYSTEMD_UNIT` | `dsh-web.service` | Unit name the launcher starts |
| `DSH_WEB_SYSTEMD_UNIT_FILE` | XDG config dir | Unit path the launcher checks for the opt-in |
| `DSH_WEB_PREFIX` | `~/.local` | Install prefix (installer) |
| `DSH_WEB_DESKTOP_DIR` | XDG desktop dir | Where the desktop icon is copied (installer) |
| `DSH_WEB_SYSTEMD_UNIT_DIR` | XDG config dir | Where the unit file is written (installer) |

`dsh-web-open.sh` also accepts `--status` (prints `200`, `401`, or `000`) and `--help`.

## Tests

```sh
tools/selftest.sh
```

36 checks: loopback stub servers answering `200` and `401`, the real `wait_for_token`
against the exact `dsh web` console shape, a stub `dsh` verifying the `--serve` argv and
tee, stub `systemctl`/`journalctl` for systemd mode and its no-user-manager fallback, and a
sandboxed install/uninstall that also runs `systemd-analyze verify` on the generated unit.
It touches nothing in your real desktop, DSH home, or user manager.

[`docs/VALIDATION.md`](docs/VALIDATION.md) records the environment, the evidence behind each
claim, and what has **not** been exercised.

## Roadmap

- The second delivery surface is published as a separate, independent repository:
  [`dsh-linux-desktop-entry`](https://github.com/ShiTan-677/dsh-linux-desktop-entry) exposes
  the same `install.sh` operations as a settings page, an agent tool, and a
  `/desktop-entry` command. It carries its own copy of this kit rather than depending on it,
  so either repository can be used, moved, or unpublished without the other.
- Non-GNOME terminals: `gnome-terminal` is tried first, then `x-terminal-emulator`; other
  emulators need their own invocation.
- The port is fixed by contract (the browser cookie is bound to `host:port`), so changing
  `DSH_WEB_PORT` means logging in once more through the printed token URL.

## License

[MIT](LICENSE)
