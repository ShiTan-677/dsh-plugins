# Changelog

## 0.1.0 — 2026-10-14 (public preview)

- Add a one-click Linux desktop entrance for the DeepSeek Harness Web GUI: an XDG desktop
  file plus a launcher that probes the port, opens a running server, and starts `dsh web`
  in a terminal window when nothing is listening.
- Recover the per-process launch token from the server console (terminal mode) so the GUI
  opens authenticated even on a browser profile that has no signed cookie yet.
- Add an opt-in `install.sh --systemd` mode: a generated `systemd --user` unit starts the
  server at login, and the launcher then reads the token back out of journald instead of
  opening a terminal window.
- Compose the desktop icon from the locally installed DSH frontend favicon, so no
  third-party artwork is vendored and the icon follows the installed DSH version.
- Ship `tools/selftest.sh`: 36 checks over loopback stub servers, a stub `dsh`, stub
  `systemctl`/`journalctl`, and a sandboxed install/uninstall. `docs/VALIDATION.md`
  records what was and was not exercised on the real desktop.
- Scope the project to Linux: the launcher depends on XDG desktop files, `xdg-open`, and a
  Linux terminal emulator.
