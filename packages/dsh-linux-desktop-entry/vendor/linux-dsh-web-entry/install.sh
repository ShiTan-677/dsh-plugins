#!/usr/bin/env bash
# Install (or remove) the DSH Web desktop entrance for the current user.
#
#   ./install.sh              install into ~/.local and the desktop directory
#   ./install.sh --systemd    also install + enable a systemd --user service,
#                             so the GUI is served from login onwards
#   ./install.sh --uninstall  remove everything it installed
#
# Overrides:
#   DSH_WEB_PREFIX              install prefix for the launcher (default ~/.local)
#   DSH_WEB_DESKTOP_DIR         desktop directory (default: xdg-user-dir DESKTOP)
#   DSH_WEB_SYSTEMD_UNIT_DIR    unit directory (default $XDG_CONFIG_HOME/systemd/user)
#   DSH_WEB_PORT                port baked into the unit (default 3080)
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${DSH_WEB_PREFIX:-$HOME/.local}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_DIR="$PREFIX/bin"
APP_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons"
LAUNCHER="$BIN_DIR/dsh-web-open.sh"
ICON_PATH="$ICON_DIR/dsh-web.svg"
ENTRY_NAME="dsh-web.desktop"
APP_ENTRY="$APP_DIR/$ENTRY_NAME"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dsh-web"
SYSTEMD_DIR="${DSH_WEB_SYSTEMD_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
UNIT_NAME="dsh-web.service"
UNIT_PATH="$SYSTEMD_DIR/$UNIT_NAME"
PORT="${DSH_WEB_PORT:-3080}"

desktop_dir() {
  if command -v xdg-user-dir >/dev/null 2>&1; then
    xdg-user-dir DESKTOP 2>/dev/null || printf '%s\n' "$HOME/Desktop"
  else
    printf '%s\n' "$HOME/Desktop"
  fi
}
DESKTOP_DIR="${DSH_WEB_DESKTOP_DIR:-$(desktop_dir)}"
DESKTOP_ENTRY="$DESKTOP_DIR/$ENTRY_NAME"

render_entry() {
  sed -e "s|__EXEC__|$LAUNCHER|" -e "s|__ICON__|$1|" "$REPO_DIR/share/dsh-web.desktop.in"
}

render_unit() {
  sed -e "s|__LAUNCHER__|$LAUNCHER|" -e "s|__PORT__|$PORT|" "$REPO_DIR/share/dsh-web.service.in"
}

# The user manager is a session bus client; without a bus we can still write the
# unit file, and the user runs daemon-reload/enable themselves.
have_user_manager() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user list-units >/dev/null 2>&1
}

port_code() {
  "$LAUNCHER" --status 2>/dev/null | tr -d '\n' || true
}

install_systemd_unit() {
  mkdir -p "$SYSTEMD_DIR"
  render_unit >"$UNIT_PATH"
  chmod 0644 "$UNIT_PATH"
  printf 'installed:\n  unit       %s\n' "$UNIT_PATH"

  local default_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if [ "$SYSTEMD_DIR" != "$default_dir" ]; then
    printf 'systemd:  custom unit directory, so nothing was enabled; run:\n'
    printf '            systemctl --user enable --now %s\n' "$UNIT_NAME"
    return 0
  fi
  if ! have_user_manager; then
    cat <<EOF
systemd:  no user manager reachable from this shell, so the unit is installed
          but not enabled. Run this from your desktop session:
            systemctl --user daemon-reload
            systemctl --user enable --now $UNIT_NAME
EOF
    return 0
  fi

  systemctl --user daemon-reload || true
  if ! systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1; then
    printf 'systemd:  could not enable %s automatically; run:\n' "$UNIT_NAME"
    printf '            systemctl --user enable --now %s\n' "$UNIT_NAME"
    return 0
  fi
  printf 'systemd:  %s enabled (starts at login)\n' "$UNIT_NAME"

  local code
  code="$(port_code)"
  if [ "$code" = "000" ]; then
    if systemctl --user start "$UNIT_NAME" >/dev/null 2>&1; then
      printf 'systemd:  started now\n'
    else
      printf 'systemd:  could not start %s now; run: systemctl --user status %s\n' "$UNIT_NAME" "$UNIT_NAME"
    fi
  else
    cat <<EOF
systemd:  port $PORT is already served by another process (HTTP $code), so the
          unit was NOT started to avoid a bind loop. Stop that instance, then:
            systemctl --user start $UNIT_NAME
          It will start by itself at your next login.
EOF
  fi
}

remove_systemd_unit() {
  if [ ! -e "$UNIT_PATH" ]; then
    return 0
  fi
  if have_user_manager; then
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT_PATH"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  else
    rm -f "$UNIT_PATH"
  fi
  printf 'removed: %s\n' "$UNIT_PATH"
}

install_all() {
  local with_systemd="${1:-0}"
  mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR" "$DESKTOP_DIR"
  install -m 0755 "$REPO_DIR/bin/dsh-web-open.sh" "$LAUNCHER"

  local icon="$ICON_PATH"
  if command -v python3 >/dev/null 2>&1 &&
    python3 "$REPO_DIR/tools/compose-icon.py" --output "$ICON_PATH"; then
    :
  else
    rm -f "$ICON_PATH"
    icon="web-browser"
    printf 'install: icon composition unavailable, falling back to the %s theme icon\n' "$icon" >&2
  fi

  render_entry "$icon" >"$APP_ENTRY"
  chmod 0644 "$APP_ENTRY"
  render_entry "$icon" >"$DESKTOP_ENTRY"
  chmod 0755 "$DESKTOP_ENTRY"

  # A launcher on the desktop has to be marked trusted before the file manager
  # will run it, and only the metadata service knows that.
  if command -v gio >/dev/null 2>&1; then
    gio set -t string "$DESKTOP_ENTRY" metadata::trusted true >/dev/null 2>&1 || true
  fi
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 &&
    gtk-update-icon-cache -f -t "$ICON_DIR" >/dev/null 2>&1 || true

  cat <<EOF
installed:
  launcher   $LAUNCHER
  app entry  $APP_ENTRY
  desktop    $DESKTOP_ENTRY
  icon       $icon
EOF

  if [ "$with_systemd" = "1" ]; then
    install_systemd_unit
  elif [ -e "$UNIT_PATH" ]; then
    printf 'note:      %s exists; re-run with --systemd to regenerate it\n' "$UNIT_PATH"
  fi

  cat <<EOF

Double-click "DSH Web" on the desktop (or launch it from Activities).
Without a unit the launcher starts dsh web in a terminal window when nothing is
listening; with a unit the launcher starts the unit instead.
Remove everything with: $REPO_DIR/install.sh --uninstall
EOF
}

uninstall_all() {
  local removed=0 target
  for target in "$DESKTOP_ENTRY" "$APP_ENTRY" "$LAUNCHER" "$ICON_PATH"; do
    if [ -e "$target" ]; then
      rm -f "$target"
      printf 'removed: %s\n' "$target"
      removed=1
    fi
  done
  if [ -e "$UNIT_PATH" ]; then
    remove_systemd_unit
    removed=1
  fi
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
  [ "$removed" = 1 ] || printf 'nothing to remove\n'
  printf 'kept: %s (start logs; remove by hand if you want)\n' "$STATE_DIR"
}

case "${1:-}" in
  --uninstall) uninstall_all ;;
  "" | --install) install_all 0 ;;
  --systemd) install_all 1 ;;
  *)
    printf 'usage: %s [--install|--systemd|--uninstall]\n' "$0" >&2
    exit 2
    ;;
esac
