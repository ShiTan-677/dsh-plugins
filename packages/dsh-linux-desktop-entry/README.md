# DSH Linux Desktop Entry

[简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts the
[Linux DSH Web Entry](https://github.com/ShiTan-677/linux-dsh-web-entry) desktop launcher
under the harness's own controls: a page in Settings, an agent tool, and a `/desktop-entry`
command — all three driving one implementation.

The desktop entry itself — the launcher, the app-menu entry, the trusted desktop icon, and
the optional `systemd --user` service — comes from the Linux DSH Web Entry project. This
plugin carries a copy of that shell kit and runs it; it never reimplements installing,
removing, or launching.

```text
Settings → Desktop entry        agent: desktop_entry              composer: /desktop-entry
  [Installed]                     {"action": "status"}              /desktop-entry status
  Install · Uninstall             {"action": "install",             /desktop-entry install
  Open in app window                "systemd": false}              /desktop-entry open
```

## What this plugin can and cannot do

Be clear about the boundary, because it is structural rather than a limitation of effort.

| | |
| --- | --- |
| **Can** | Install, repair, remove and inspect the desktop entry from inside a running harness; open the GUI in a browser app window; opt into a resident service; let the agent do any of it. |
| **Cannot** | Be the thing that starts DSH when DSH is not running. That is the desktop file's job, and it happens outside this process. |

So the plugin is a *second delivery surface* for the same desktop entry, not a replacement
for it. If you only want the launcher and never touch plugins, use the shell project
directly — it is a self-contained `git clone && ./install.sh`.

## Install

```sh
git clone https://github.com/ShiTan-677/dsh-linux-desktop-entry
```

Then install the bundle into your profile with the Plugin Manager, pointing at the clone:

```text
plugin_manager install_bundle /absolute/path/to/dsh-linux-desktop-entry
```

Three prerequisites, each of which produces a specific error when missing:

- **Linux.** The plugin reports an unsupported host on other platforms instead of offering
  actions that cannot work.
- **A DSH profile**, and `pnpm` on the `PATH` of the DSH process. `install_bundle` installs
  the package with `pnpm add`; without it the install fails at that step.
- **The clone must stay where you put it.** `install_bundle` records a `link:` dependency, so
  the profile points at your checkout. Moving or deleting it breaks the plugin; use the
  Plugin Manager to remove the bundle first.

Nothing is written to your desktop at install time. The Settings page shows what is on disk
and waits for a click.

## What you get

### Settings → Desktop entry

One page that reports the state and offers the actions: whether each installed file is
present, whether anything is listening on the port, and what the resident unit is really
doing — its path plus `is-enabled` / `is-active`, or the reason it is not in use. Buttons:
**Install** (or **Reinstall** to repair), **Uninstall**, **Open in app window**, **Refresh**.

### `desktop_entry` agent tool

One tool with an `action` parameter — `status`, `install`, `uninstall`, `open` — and an
optional `systemd` flag. Ask the agent to "install the desktop entry for the harness Web GUI"
and it can inspect first, then act, reporting the installer's own output.

`status` changes nothing, so it is the safe first call.

### `/desktop-entry` command

```text
/desktop-entry                      # status
/desktop-entry install              # desktop entry only
/desktop-entry install --systemd    # plus a resident systemd --user service
/desktop-entry uninstall            # removes the unit too, when one exists
/desktop-entry open                 # open the GUI now
```

## The resident service is opt-in

**Off by default, in every surface.** Ticking the box — or passing `--systemd` — writes and
enables a `systemd --user` unit so the GUI is served from login onwards.

The cost is honest and stated in the UI: this keeps a node process resident and using
resources even while no window is open. The default path starts a server on the first
double-click and costs nothing when idle. Pick per machine.

Uninstall stops and removes the unit as well, so removing the plugin's desktop entry never
leaves a server running behind you.

If you move the unit, move it for both surfaces: the installer writes it under
`DSH_WEB_SYSTEMD_UNIT_DIR`, while the launcher only reads `DSH_WEB_SYSTEMD_UNIT_FILE`. When
the two disagree, the page says so and opening still falls back to a terminal window — a unit
file the launcher never reads is not a resident service.

A unit file is also not enough on its own: the launcher needs a reachable `systemd --user`
manager, which is why `status` reports `is-enabled` / `is-active` instead of file existence.

## The vendored shell kit

`vendor/linux-dsh-web-entry/` is a verbatim copy of the
[linux-dsh-web-entry](https://github.com/ShiTan-677/linux-dsh-web-entry) runtime payload: the
installer, the launcher, both templates, the icon composer, the payload's own self-test, and
the license. The Host half runs its `install.sh` and `bin/dsh-web-open.sh`.

Two repositories were chosen over one so each stands alone: neither breaks when the other is
unpublished, unavailable, or moved. The price of that independence is drift, so it is made
detectable rather than merely documented — `tools/selftest-plugin.mjs` checks every payload file
against the sibling checkout at `../linux-dsh-web-entry` whenever it exists: each must be
present and byte-identical, and nothing outside the list may appear in the copy. A standalone
clone skips that comparison and says so.

`PROVENANCE.md` records the upstream commit and version, and what re-vendoring means.

## Tests

```sh
node tools/selftest-plugin.mjs     # 57 checks: this plugin's surface
vendor/linux-dsh-web-entry/tools/selftest.sh   # 36 checks: the vendored shell kit
```

The plugin self-test drives the Host half's HTTP handlers, the agent tool and the command
against a fake Cordis context, so the route contract (trust fence, method, content-type, body
ceiling, action validation) and all three callers are checked without a browser or a cookie.

Every installer path — including the `systemd --user` unit directory — is redirected into a
temporary directory before any handler runs, so the install/uninstall cycle exercises the real
`install.sh` against a sandbox and touches nothing of yours. For the same reason the test
never asks the installer for `--systemd`: that path ends in `systemctl --user`, which resolves
the unit by name through the live user manager.

Visual verification of the Settings page in a browser is **not** part of the automated test;
see [Limits](#limits).

### Limits

- The Settings page is verified as a live slot registration (`settings.section`), by parse and
  syntax checks, and by the route contract its buttons call. It has not been verified by
  reading a rendered browser page.
- Visible page text is English only. The harness locale service is not wired up yet; the
  plugin's own display metadata ships in `locale/en.json` and `locale/zh.json`.
- The `systemd` install path is exercised only by the vendored shell kit's own self-test, not
  through this plugin's route.

## Requirements

- Linux, a desktop entry spec compliant desktop, and a Chromium-family browser for the app
  window — see the shell project for the details it owns.
- DSH with a profile, and `pnpm` reachable from the DSH process.

## License

[MIT](LICENSE). The vendored shell kit keeps its own copy at
`vendor/linux-dsh-web-entry/LICENSE`.
