# dsh-plugins

Self-maintained [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins and their companion tools: one repository, one CI, and **one npm package per plugin with its own version**.

## Packages

| Package | What it does | Form |
| --- | --- | --- |
| [`dsh-plugin-mark-unread`](packages/dsh-plugin-mark-unread) | Adds a manual "mark as unread" action to workspace session rows, with a self-retiring mechanism for when upstream ships it | host + Web UI |

Coming next: `linux-dsh-web-entry` + `dsh-linux-desktop-entry` as a pair (the launcher kit and the plugin that drives it).

## Rules every package follows

These exist because a broken metadata field silently breaks discovery for everyone downstream — npm, the plugin catalog, and the in-app market all read them.

1. **Directory name equals the package name.** For scoped packages, drop the scope: `packages/dsh-foo` for `@scope/dsh-foo`.
2. **`repository` carries both `url` and `directory`.** Write `"repository": { "type": "git", "url": "git+https://github.com/ShiTan-677/dsh-plugins.git", "directory": "packages/<name>" }`. The catalog derives the source link from `repository.url` + `repository.directory`, so a missing `directory` points readers at the repository root — or at nothing.
3. **`homepage` points at the package directory**, not the repository root.
4. **Every package ships its own bilingual README, its own SemVer, and its own npm publish.** A release only touches the packages that changed.
5. **Every package must pass `npm run verify` from its own directory.** The root `pnpm verify` fans out to all of them.

## Usage

```sh
# verify every package (Node only — no dependency install needed)
pnpm verify

# install one package into a DSH profile
dsh plugin --profile web add dsh-plugin-mark-unread
```

Each package's README documents its own behaviour, settings, and compatibility range.

## License

MIT — see [LICENSE](LICENSE).
