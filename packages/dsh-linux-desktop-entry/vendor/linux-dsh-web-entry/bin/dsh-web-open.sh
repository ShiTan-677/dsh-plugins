#!/usr/bin/env bash
# dsh-web-open.sh — one-click entrance to the DeepSeek Harness Web GUI (Linux).
#
#   * server already listening  → open the GUI in a browser app window
#   * systemd unit installed    → start it with `systemctl --user start`, then
#                                 open the GUI (recovering the process token from
#                                 journald when the browser has no cookie yet)
#   * otherwise                 → start `dsh web` in a terminal window, wait for
#                                 its one-time token URL, then open that URL
#   * --serve                   → internal: run the server in the foreground;
#                                 this is what the systemd unit executes
#   * --status                  → print 200, 401 or 000 for the configured port
#
# The launcher never restarts or stops a server that is already running, so it
# is safe to use while a DSH session is live.
#
# Environment overrides:
#   DSH_WEB_PORT               listen port (default 3080)
#   DSH_WEB_BROWSER            browser binary for the app window (default google-chrome)
#   DSH_WEB_START_TIMEOUT      seconds to wait for the server or token (default 60)
#   DSH_WEB_DRY_RUN=1          print the planned actions instead of taking them
#   DSH_WEB_SYSTEMD_UNIT       unit name (default dsh-web.service)
#   DSH_WEB_SYSTEMD_UNIT_FILE  unit path (default $XDG_CONFIG_HOME/systemd/user/<unit>)
set -uo pipefail

PORT="${DSH_WEB_PORT:-3080}"
URL="http://127.0.0.1:${PORT}/"
BROWSER="${DSH_WEB_BROWSER:-google-chrome}"
START_TIMEOUT="${DSH_WEB_START_TIMEOUT:-60}"
DRY_RUN="${DSH_WEB_DRY_RUN:-0}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dsh-web"
LAUNCH_LOG="$STATE_DIR/launch.log"
UNIT_NAME="${DSH_WEB_SYSTEMD_UNIT:-dsh-web.service}"
UNIT_FILE="${DSH_WEB_SYSTEMD_UNIT_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME}"
# The token line `dsh web` prints once per process; everything else is noise.
TOKEN_PATTERN="http://127\.0\.0\.1:${PORT}/\?token=[^[:space:]]+"
DSH_CMD=()

log() { printf '[dsh-web] %s\n' "$*" >&2; }

notify() {
  command -v notify-send >/dev/null 2>&1 || return 0
  if [ "$DRY_RUN" = "1" ]; then
    log "notify-send: $*"
    return 0
  fi
  notify-send -a "DSH Web" "$1" "${2:-}" >/dev/null 2>&1 || true
}

die() {
  notify "DSH Web" "$1"
  log "$1"
  exit 1
}

usage() { sed -n '2,21p' "$0"; }

# nvm is loaded by ~/.bashrc, which a non-interactive shell returns from early,
# so a desktop-launched process has to load it explicitly.
load_node_env() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  fi
}

# Prefer an already-resolved npx cache install: it needs no registry round trip
# and matches the version the user launched before.
resolve_dsh() {
  local candidate
  for candidate in "$HOME"/.npm/_npx/*/node_modules/.bin/dsh; do
    if [ -x "$candidate" ]; then
      DSH_CMD=("$candidate")
      return 0
    fi
  done
  if command -v dsh >/dev/null 2>&1; then
    DSH_CMD=("$(command -v dsh)")
    return 0
  fi
  if command -v npx >/dev/null 2>&1; then
    DSH_CMD=(npx --yes @deepseek-ai/dsh)
    return 0
  fi
  return 1
}

# Prints 200 (cookie accepted), 401 (serving, but no valid cookie) or 000 (down).
probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null --max-time 3 -w '%{http_code}' "$URL" 2>/dev/null || true
  elif (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    printf '200'
  else
    printf '000'
  fi
}

open_browser() {
  local target="$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "would open: $target"
    return 0
  fi
  if command -v "$BROWSER" >/dev/null 2>&1; then
    setsid "$BROWSER" --app="$target" >/dev/null 2>&1 &
  else
    setsid xdg-open "$target" >/dev/null 2>&1 &
  fi
}

spawn_terminal() {
  local self cmd
  self="$(readlink -f "$0")"
  cmd="$(printf '%q ' "$self" --serve)"
  if [ "$DRY_RUN" = "1" ]; then
    log "would run in a terminal window: $cmd"
    return 0
  fi
  if command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal --window --title="dsh web — $URL" -- bash -lc "$cmd"
  elif command -v x-terminal-emulator >/dev/null 2>&1; then
    x-terminal-emulator -e bash -lc "$cmd"
  else
    return 1
  fi
}

# --- systemd mode -----------------------------------------------------------

# The unit file is the user's opt-in; without it the launcher stays terminalless.
systemd_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user list-units >/dev/null 2>&1
}

use_systemd() {
  [ -f "$UNIT_FILE" ] || return 1
  systemd_available
}

start_unit() {
  if [ "$DRY_RUN" = "1" ]; then
    log "would run: systemctl --user start $UNIT_NAME"
    return 0
  fi
  if ! systemctl --user start "$UNIT_NAME" >/dev/null; then
    log "systemctl --user start $UNIT_NAME failed"
    return 1
  fi
}

# The unit prints the token to journald; the newest match belongs to the live
# process, because each process mints exactly one token.
token_from_journal() {
  command -v journalctl >/dev/null 2>&1 || return 0
  journalctl --user -u "$UNIT_NAME" -o cat --no-pager 2>/dev/null |
    grep -oE "$TOKEN_PATTERN" | tail -n1
}

# Wait until the port answers, then print its HTTP code.
wait_for_server() {
  local deadline=$((SECONDS + START_TIMEOUT)) code
  while [ "$SECONDS" -lt "$deadline" ]; do
    code="$(probe)"
    case "$code" in
      200 | 401)
        printf '%s' "$code"
        return 0
        ;;
    esac
    sleep 0.5
  done
  return 1
}

# A 401 means the server is healthy but this browser has no signed cookie yet;
# the token URL mints one, so prefer it over the clean URL in that case.
gui_url_for() {
  local code="$1" url
  if [ "$code" = "401" ]; then
    url="$(token_from_journal)"
    if [ -n "$url" ]; then printf '%s' "$url"; return 0; fi
  fi
  printf '%s' "$URL"
}

open_served_gui() {
  local code="$1" url
  url="$(gui_url_for "$code")"
  if [ "$code" = "401" ] && [ "$url" = "$URL" ]; then
    notify "DSH Web" "The server is up but this browser has no valid credential; restart dsh web to mint a fresh URL."
  fi
  open_browser "$url"
}

# --- terminal mode ----------------------------------------------------------

# The launch token is random per server process and only ever printed to the
# server's console, so read it out of the tee'd log instead of guessing.
wait_for_token() {
  local deadline url=""
  deadline=$((SECONDS + START_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if grep -qE 'EADDRINUSE|address already in use' "$LAUNCH_LOG" 2>/dev/null; then
      notify "DSH Web" "Port $PORT is in use by another process; see the terminal window."
      log "port $PORT is taken by a process that is not answering as the GUI"
      return 1
    fi
    url="$(grep -m1 -oE "$TOKEN_PATTERN" "$LAUNCH_LOG" 2>/dev/null | head -n1)"
    if [ -n "$url" ]; then
      open_browser "$url"
      return 0
    fi
    sleep 0.5
  done
  notify "DSH Web" "The server did not report a URL within ${START_TIMEOUT}s; see the terminal window."
  log "timed out waiting for the token URL in $LAUNCH_LOG"
  return 1
}

serve() {
  load_node_env
  if ! resolve_dsh; then
    printf 'dsh-web: no dsh, npx, or cached @deepseek-ai/dsh found on PATH\n' >&2
    printf 'Press Enter to close this window.\n'
    read -r _
    return 1
  fi
  mkdir -p "$STATE_DIR"
  : > "$LAUNCH_LOG"
  printf 'dsh-web: %s web --port %s --no-open\n' "${DSH_CMD[*]}" "$PORT"
  printf 'dsh-web: serving %s — close this window to stop the server.\n\n' "$URL"
  "${DSH_CMD[@]}" web --port "$PORT" --no-open 2>&1 | tee -a "$LAUNCH_LOG"
  printf '\ndsh-web: server stopped. Press Enter to close this window.\n'
  read -r _
}

main() {
  case "${1:-}" in
    --serve) serve; return $? ;;
    --status) probe; printf '\n'; return 0 ;;
    --help | -h) usage; return 0 ;;
  esac

  local code
  code="$(probe)"
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then
    log "server on port $PORT is up (HTTP $code); opening the GUI"
    open_served_gui "$code"
    return 0
  fi

  if use_systemd; then
    log "nothing is listening on port $PORT; starting $UNIT_NAME"
    start_unit || die "systemctl --user start $UNIT_NAME failed; see systemctl --user status $UNIT_NAME"
    if [ "$DRY_RUN" = "1" ]; then
      log "dry run: not waiting for the port"
      return 0
    fi
    if ! code="$(wait_for_server)"; then
      notify "DSH Web" "$UNIT_NAME did not listen on port $PORT within ${START_TIMEOUT}s."
      log "timed out waiting for $UNIT_NAME to listen on port $PORT"
      return 1
    fi
    open_served_gui "$code"
    return 0
  fi

  log "nothing is listening on port $PORT; starting dsh web"
  mkdir -p "$STATE_DIR"
  : > "$LAUNCH_LOG"
  exec 9>"$STATE_DIR/start.lock"
  if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
    log "another launcher is already starting the server; waiting for its URL"
    wait_for_token
    return $?
  fi
  spawn_terminal || die "Could not open a terminal window (install gnome-terminal or x-terminal-emulator)."
  if [ "$DRY_RUN" = "1" ]; then
    log "dry run: not waiting for the token URL"
    return 0
  fi
  wait_for_token
}

# Sourced by tools/selftest.sh to exercise single helpers without running main.
if [ "${DSH_WEB_LIB_ONLY:-0}" = "1" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

main "$@"
