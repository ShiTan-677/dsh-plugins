# dsh-plugin-mark-unread

Adds a manual **“Mark as unread”** action to the DSH Web GUI session list.

> **Stopgap plugin.** DSH today derives unread state automatically and exposes no way to set it back, while the Codex desktop app has exactly that action. This plugin adds it — and is built to **retire itself** once upstream ships the feature. See [Self-retirement](#self-retirement).

- Target runtime: DSH `0.2.0-rc.2` (`@deepseek-ai/dsh-desktop-runtime`)
- Dependencies: none. The runtime only uses React from the platform baseline; the dev scripts use Node ≥ 20 built-ins only
- License: MIT

## Why

DSH does have “unread”, but it is derived, in-memory, and read-only:

- The client service `uiSession` (from `@deepseek-ai/dsh-client-ui-session`) keeps an in-memory `completionUnread` set. It gains a session when that session goes from running to idle while it is not the main view, and loses it when the session becomes the main view, starts running again, or disappears.
- `@deepseek-ai/dsh-client-ui-workspace` renders it as the row's completion dot (`completed: status?.completionUnread === true`).
- There is no public setter, no persistence, and nothing reaches the host. The `ui-sidebar` README states it plainly:

  > "New task completed" unread marking is local viewing state — completion-time > last-seen never reaches the host.

This plugin fills that gap using only documented, third-party-facing slots. It does **not** patch `app.asar`, does not modify official packages, and does not hijack `completionUnread`.

## Behaviour

| Situation | Result |
| --- | --- |
| Row “…” menu | Adds **Mark as unread / Mark as read**, after the shipped Archive action |
| Marked unread | A small dot in the row's leading seat (the official dot keeps its own cell) |
| Opening a session (it *becomes* the main view) | Mark is cleared — only on a transition observed **while running** |
| Marking the **currently open** session unread | The mark **sticks**, and **survives a restart** ([openai/codex#13115](https://github.com/openai/codex/issues/13115) is exactly this request) |
| Restart / page reload | Mark survives (`localStorage` key `dsh.mark-unread.v1`); startup never clears a mark |
| Session disappears from the list | Mark is **kept** (an orphan is invisible); storage is capped at the newest 500 entries, never pruned by list membership |
| GUI language | Labels follow the app's language setting live (registers the `dsh-mark-unread` namespace with the official `locale` service) |
| Official setter appears | Plugin goes inert: no menu item, no dot, one console notice |

> Fixed in 0.1.1: 0.1.0 read `<html lang>` once at `apply()` to pick its strings. The page's initial active locale is a browser-derived provisional value, so a Chinese GUI was locked to English. The same version also cleared the current session's mark at startup and pruned marks against list snapshots, which lost marks across restarts. Labels now ride the official `locale` seat, and marks are cleared only on an observed session transition.

## Install

```sh
# via the plugin manager tool
install_bundle  target=/absolute/path/to/dsh-plugin-mark-unread
# or, after pushing to GitHub
install_bundle  target=github:<you>/dsh-plugin-mark-unread
```

The manager validates DSH peers, runs `pnpm add`, and selects the bundle. The desktop profile loads at startup, so restart DSH to activate.

Manual equivalent: `pnpm add /abs/path` inside `~/.dsh/profiles/desktop`, add `"dsh-plugin-mark-unread"` to `dsh.profile.bundles`, restart. Do not add id-targeted rows for this plugin in `cordis.patch.yml` — it ships its own bundle patch, and a hand-written override would dangle after uninstall.

## Self-retirement

Upstream will not notify plugin authors, so “time to remove this plugin” is turned into automatable signals:

1. **A peer range that spans minors, instead of a pinned version.** `peerDependencies` declares a span — `>=0.1.7-rc.2 <0.3.0-0` — over the four official packages this plugin actually uses (`api-session-controller` for the `sessions` service, `client-ui-session` for `uiSession`, `client-ui-slots` for `slots`, `client-ui-workspace` for the slot declarations). DSH validates bundle peers against `getDshRuntimeVersion()` at startup and on every recomposition; a manifest outside the span is **skipped whole** and listed in `skippedBundles`. The span keeps the floor of that guard (crossing the upper bound, e.g. 0.3.0, still retires the plugin) without the cost of an outage on every minor: under 0.x semantics `^0.1.7-rc.2` means `>=0.1.7-rc.2 <0.2.0`, and an exact pin is narrower still — both make the plugin vanish on each DSH minor. That is exactly what the `0.1.7-rc.2 → 0.2.0-rc.2` bump did on 2026-09-29: in the plugin market's compatibility snapshot, 23 of the 47 peer-declaring plugins (48.9%) were refused on 0.2.0-rc.2, this one included. Be explicit about the trade-off: a runtime inside the span but not verified contract by contract (say 0.2.1) gets no gate protection — which is why layer 2, not layer 1, is the real retirement signal. Do not grant a `compatibility.json` version exemption for the current series; the span already covers it. The `0.1.7-rc.2 → 0.2.0-rc.2` move itself was verified contract by contract against the 0.2.0-rc.2 artifacts (`window.__ModuleLoader__.load({ id, factory })`, `react` in the baseline module table, the `ctx.slots.inject` / `slots.register({ name, id, order, locale, inject })` call shape as used by the official `dsh-client-locale`, both slot names and their props, `locale.register(ns, { zh, en })`, and the `sessions.list.getSnapshot()/subscribe()` + `row.retainedBy.mainView` predicate that mirrors the official `ui-session` 0.2.0-rc.2 code). `official-baseline.json` is the single source of truth: `runtime`/`pins` record the verified versions, `peerRange` records the declared span, and `tests/artifact.test.mjs` enforces that the peers equal `peerRange`, that `peerRange` covers `runtime`, and that the span really crosses minors.
2. **Runtime capability probe.** The client half looks for a plausible official setter on `uiSession` (`markUnread`, `markAsUnread`, `setUnread`, `toggleUnread`, `setCompletionUnread`, `markSessionUnread`). If found, the store goes inert (components render `null`) and logs `official support detected … safe to remove`.
3. **Upstream watcher.** `node scripts/watch-official.mjs` reads npm registry metadata for the official packages, downloads the tarball only when a newer version exists, and scans `README*.md`, `lib/types/**/*.d.ts`, `lib/client.js`, `dist/assets/*.js` for those setter names. Exit codes: `0` no update, `2` update without setter, `10` strong signal (verify, then uninstall), `1` network error. Add `--json` for machine output and `--profile desktop` to also report whether the bundle is still selected. Schedule it weekly (cron/launchd, or a DSH schedule task).
4. **Post-upgrade review.** After a DSH update, check `skippedBundles` / the plugin page, then verify upstream: is there a “Mark as unread” menu item, and does the mark survive a page reload? Persistence across reload is the hard signal — the current implementation is process-local.

## Uninstall

```sh
plugin_manager  action=remove_bundle  target=dsh-plugin-mark-unread
```

Removal order is: drop the bundle from `dsh.profile.bundles` → unload its runtime contributions → `pnpm remove`. The desktop profile is startup-loaded; if online removal is refused ("cannot remove packages used to start the current process"), quit the app and use `dsh plugin` (see `dsh plugin --help`) or `pnpm remove` plus a manifest edit.

Then clear the single browser key:

```js
localStorage.removeItem('dsh.mark-unread.v1')
```

No host-side residue: the plugin writes no host storage, and its patch file only inserts one row.

## Development

```sh
node scripts/build-client.mjs          # generate lib/client.js from src/
node scripts/build-client.mjs --check  # fail if the artifact is stale (CI)
node --test 'tests/*.test.mjs'         # store logic, artifact contract, slot behaviour, watcher
```

No dependencies to install. `lib/client.js` is a **generated artifact** — edit `src/`, never the artifact.

```
package.json                    # dsh.bundle / dsh.client declarations + exact DSH peer pins
cordis.patch.yml                # bundle patch: one insert row
lib/index.js                    # host half: no behaviour, satisfies the contract
lib/client.js                   # generated: browser half wrapped in __ModuleLoader__.load
src/store.js                    # pure state logic (unit-tested)
src/plugin.js                   # slot components, session watcher, official-capability probe
scripts/build-client.mjs        # dependency-free concatenating builder + --check
scripts/watch-official.mjs      # upstream support detector
scripts/official-baseline.json  # validated runtime/package pins (kept in sync by tests)
tests/                          # node:test
```

## Limitations

- Web/desktop GUI only; the session list does not exist in CLI/headless surfaces.
- The mark is browser-local: not cross-device, not cross-profile.
- While the official status dot occupies the cell (running, pending interaction, or official unread), the leading seat is not rendered, so the custom dot is not visible.
- If upstream names its entry point outside `OFFICIAL_SETTERS`, layer 2 may miss it; layers 1 and 3 still cover the retirement.
- This is a bridge. The real fix belongs upstream: <https://github.com/deepseek-ai/deepseek-harness/issues>.
