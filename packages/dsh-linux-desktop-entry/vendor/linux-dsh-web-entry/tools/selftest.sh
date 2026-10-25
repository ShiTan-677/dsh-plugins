#!/usr/bin/env bash
# Self-test for the DSH Web desktop entrance.
#
# Everything runs against throwaway directories and loopback stub servers: the
# real desktop files, the real install prefix and the real GUI are untouched.
#
#   tools/selftest.sh
set -uo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="$REPO_DIR/bin/dsh-web-open.sh"
TMP="$(mktemp -d)"
PORT_UP=38080
PORT_401=38081
SRV_PIDS=()

cleanup() {
  local pid
  for pid in ${SRV_PIDS[@]+"${SRV_PIDS[@]}"}; do kill "$pid" 2>/dev/null; done
  pkill -f "$TMP/stub/dsh" 2>/dev/null
  pkill -f "$TMP/stub/http401.py" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

pass=0
fail=0
check() { # check <label> <expected substring> <actual>
  if [[ "$3" == *"$2"* ]]; then
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n       expected to contain: %s\n       actual: %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}
ok_if() { # ok_if <label> <exit status>
  if [ "$2" -eq 0 ]; then check "$1" "ok" "ok"; else check "$1" "ok" "not ok"; fi
}
check_not() { # check_not <label> <substring that must be absent> <actual>
  if [[ "$3" != *"$2"* ]]; then
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n       expected NOT to contain: %s\n       actual: %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}
check_eq() { # check_eq <label> <expected> <actual>
  if [ "$3" = "$2" ]; then
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n       expected exactly: %s\n       actual:          %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

run_launcher() { # run_launcher <port> [extra launcher args...]
  local port="$1"
  shift
  DSH_WEB_PORT="$port" \
    DSH_WEB_DRY_RUN=1 \
    XDG_STATE_HOME="$TMP/state" \
    "$LAUNCHER" "$@" 2>&1
}

start_stub() { # start_stub <port> <http status>
  python3 -c '
import http.server, sys
code = int(sys.argv[2])

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(code)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass

http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
' "$1" "$2" &
  SRV_PIDS+=("$!")
}

wait_for_port() {
  local i
  for i in $(seq 1 50); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 1
}

# The browser is launched detached, so its side effect can land just after the
# launcher exits; give it a moment instead of racing it.
wait_for_file() {
  local i
  for i in $(seq 1 50); do
    [ -s "$1" ] && return 0
    sleep 0.1
  done
  return 1
}

printf '== syntax ==\n'
if bash -n "$LAUNCHER" "$REPO_DIR/install.sh" "$REPO_DIR/tools/selftest.sh" 2>"$TMP/bash.err"; then
  check "bash scripts parse" "ok" "ok"
else
  check "bash scripts parse" "ok" "$(cat "$TMP/bash.err")"
fi
if python3 -m py_compile "$REPO_DIR/tools/compose-icon.py" 2>"$TMP/py.err"; then
  check "icon composer parses" "ok" "ok"
else
  check "icon composer parses" "ok" "$(cat "$TMP/py.err")"
fi

printf '\n== launcher branches (dry run) ==\n'
start_stub "$PORT_UP" 200
start_stub "$PORT_401" 401
wait_for_port "$PORT_UP" && wait_for_port "$PORT_401" && ok_if "stub servers are listening" 0
out="$(run_launcher "$PORT_UP")"
check "running server opens the app window" "would open: http://127.0.0.1:$PORT_UP/" "$out"
out="$(run_launcher "$PORT_401")"
check "missing cookie still opens the window" "would open: http://127.0.0.1:$PORT_401/" "$out"
check "missing cookie warns the user" "no valid credential" "$out"
out="$(DSH_WEB_PORT="$PORT_UP" DSH_WEB_DRY_RUN=1 XDG_STATE_HOME="$TMP/state" "$LAUNCHER" --status 2>&1 | tr -d '\n')"
check_eq "--status is machine-readable (plugin contract)" "200" "$out"
out="$(DSH_WEB_PORT=1 DSH_WEB_DRY_RUN=1 XDG_STATE_HOME="$TMP/state" "$LAUNCHER" --status 2>&1 | tr -d '\n')"
check_eq "--status reports a down port as 000" "000" "$out"
out="$(run_launcher 1)"
check "no server starts one in a terminal" "would run in a terminal window" "$out"
check "no server says so" "nothing is listening on port 1" "$out"

printf '\n== token extraction (real wait_for_token) ==\n'
mkdir -p "$TMP/state/dsh-web" "$TMP/stub"
# Feed the helper the exact stdout shape of `dsh web` and check which URL it
# would open; DSH_WEB_LIB_ONLY sources the launcher without running main.
printf 'dsh web: http://127.0.0.1:38099/?token=stubtoken (LAN: http://10.0.0.9:38099/?token=stubtoken)\n' \
  >"$TMP/state/dsh-web/launch.log"
token_out="$(DSH_WEB_LIB_ONLY=1 \
  DSH_WEB_PORT=38099 \
  DSH_WEB_DRY_RUN=1 \
  DSH_WEB_START_TIMEOUT=5 \
  XDG_STATE_HOME="$TMP/state" \
  bash -c '. "$1"; wait_for_token; echo "exit=$?"' bash "$LAUNCHER" 2>&1)"
check "opens the process-token URL" "would open: http://127.0.0.1:38099/?token=stubtoken" "$token_out"
check_not "does not swallow the LAN suffix" "(LAN" "$token_out"
check "reports success" "exit=0" "$token_out"
: >"$TMP/state/dsh-web/launch.log"
timeout_out="$(DSH_WEB_LIB_ONLY=1 \
  DSH_WEB_PORT=38099 \
  DSH_WEB_DRY_RUN=1 \
  DSH_WEB_START_TIMEOUT=2 \
  XDG_STATE_HOME="$TMP/state" \
  bash -c '. "$1"; wait_for_token; echo "exit=$?"' bash "$LAUNCHER" 2>&1)"
check "a silent server times out" "exit=1" "$timeout_out"

printf '\n== serve path with a stub dsh ==\n'
mkdir -p "$TMP/home"
cat >"$TMP/stub/dsh" <<'STUB'
#!/usr/bin/env bash
printf 'stub dsh argv: %s\n' "$*" >&2
printf 'dsh web: http://127.0.0.1:3080/?token=stubserve\n'
sleep 10
STUB
chmod +x "$TMP/stub/dsh"
PATH="$TMP/stub:/usr/local/bin:/usr/bin:/bin" \
  HOME="$TMP/home" \
  XDG_STATE_HOME="$TMP/state" \
  DSH_WEB_PORT=3080 \
  "$LAUNCHER" --serve >"$TMP/serve.out" 2>&1 &
serve_pid=$!
for _ in $(seq 1 40); do
  [ -s "$TMP/state/dsh-web/launch.log" ] && break
  sleep 0.1
done
kill "$serve_pid" 2>/dev/null
check "serve passes web --port --no-open" "stub dsh argv: web --port 3080 --no-open" "$(cat "$TMP/serve.out")"
check "serve tees the server console to the log" "token=stubserve" "$(cat "$TMP/state/dsh-web/launch.log")"

printf '\n== systemd mode (stub systemctl + journalctl) ==\n'
PORT_SYS=38082
UNIT_STUB="$TMP/systemd/user/dsh-web.service"
mkdir -p "$TMP/systemd/user" "$TMP/browser"
: >"$UNIT_STUB" # the unit file's presence is the opt-in

cat >"$TMP/stub/http401.py" <<'PY'
import http.server, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass

http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY

# The stub manager binds the port on `start`; the stub journal holds the token
# line the real unit would print into journald.
cat >"$TMP/stub/systemctl" <<EOF
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >>"$TMP/systemctl.log"
if [ "\${STUB_SYSTEMCTL_FAIL:-0}" = "1" ]; then exit 1; fi
case "\$*" in
  *" start "*)
    setsid python3 "$TMP/stub/http401.py" "$PORT_SYS" >/dev/null 2>&1 &
    sleep 0.3
    ;;
esac
exit 0
EOF
cat >"$TMP/stub/journalctl" <<EOF
#!/usr/bin/env bash
printf 'dsh web: http://127.0.0.1:$PORT_SYS/?token=journaltoken (LAN: http://10.0.0.9:$PORT_SYS/?token=journaltoken)\n'
EOF
cat >"$TMP/stub/fake-browser" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$TMP/browser.log"
EOF
chmod +x "$TMP/stub/systemctl" "$TMP/stub/journalctl" "$TMP/stub/fake-browser"

rm -f "$TMP/systemctl.log" "$TMP/browser.log"
sys_out="$(DSH_WEB_PORT="$PORT_SYS" \
  DSH_WEB_SYSTEMD_UNIT_FILE="$UNIT_STUB" \
  DSH_WEB_BROWSER="$TMP/stub/fake-browser" \
  DSH_WEB_START_TIMEOUT=10 \
  XDG_STATE_HOME="$TMP/state" \
  PATH="$TMP/stub:$PATH" \
  "$LAUNCHER" 2>&1)"
check "systemd mode starts the unit" "systemctl --user start dsh-web.service" "$(cat "$TMP/systemctl.log" 2>/dev/null)"
wait_for_file "$TMP/browser.log" || true
check "systemd mode opens the journal token URL" \
  "--app=http://127.0.0.1:$PORT_SYS/?token=journaltoken" "$(cat "$TMP/browser.log" 2>/dev/null)"
check_not "systemd mode opens no terminal window" "terminal window" "$sys_out"

# A unit file without a reachable user manager must fall back, not fail.
fallback_out="$(DSH_WEB_PORT=1 \
  DSH_WEB_DRY_RUN=1 \
  DSH_WEB_SYSTEMD_UNIT_FILE="$UNIT_STUB" \
  STUB_SYSTEMCTL_FAIL=1 \
  XDG_STATE_HOME="$TMP/state" \
  PATH="$TMP/stub:$PATH" \
  "$LAUNCHER" 2>&1)"
check "no user manager falls back to the terminal path" "would run in a terminal window" "$fallback_out"

printf '\n== systemd unit rendering ==\n'
UNIT_DIR="$TMP/systemd-rendered"
systemd_install_out="$(DSH_WEB_PREFIX="$TMP/prefix" \
  XDG_DATA_HOME="$TMP/share" \
  DSH_WEB_DESKTOP_DIR="$TMP/Desktop" \
  DSH_WEB_SYSTEMD_UNIT_DIR="$UNIT_DIR" \
  "$REPO_DIR/install.sh" --systemd 2>&1)"
test -s "$UNIT_DIR/dsh-web.service"; ok_if "unit file written" $?
unit_text="$(cat "$UNIT_DIR/dsh-web.service" 2>/dev/null)"
check "unit execs the launcher in serve mode" "ExecStart=$TMP/prefix/bin/dsh-web-open.sh --serve" "$unit_text"
check "unit carries the configured port" "Environment=DSH_WEB_PORT=3080" "$unit_text"
if grep -qE '__[A-Z_]+__' "$UNIT_DIR/dsh-web.service"; then
  check "unit placeholders resolved" "clean" "$(grep -oE '__[A-Z_]+__' "$UNIT_DIR/dsh-web.service" | sort -u | tr '\n' ' ')"
else
  check "unit placeholders resolved" "clean" "clean"
fi
check "custom unit dir is not enabled behind the user's back" "custom unit directory" "$systemd_install_out"
if command -v systemd-analyze >/dev/null 2>&1; then
  if systemd-analyze verify "$UNIT_DIR/dsh-web.service" 2>"$TMP/verify.err"; then
    check "systemd-analyze verify accepts the unit" "ok" "ok"
  else
    check "systemd-analyze verify accepts the unit" "ok" "$(cat "$TMP/verify.err")"
  fi
else
  printf 'skip systemd-analyze verify (not installed)\n'
fi

printf '\n== install / uninstall in a sandbox ==\n'
install_out="$(DSH_WEB_PREFIX="$TMP/prefix" \
  XDG_DATA_HOME="$TMP/share" \
  DSH_WEB_DESKTOP_DIR="$TMP/Desktop" \
  DSH_WEB_SYSTEMD_UNIT_DIR="$TMP/systemd-none" \
  "$REPO_DIR/install.sh" 2>&1)"
check "installer reports the desktop file" "$TMP/Desktop/dsh-web.desktop" "$install_out"
test -x "$TMP/prefix/bin/dsh-web-open.sh"; ok_if "launcher is executable" $?
app_entry="$(cat "$TMP/share/applications/dsh-web.desktop" 2>&1)"
check "app entry points at the launcher" "Exec=$TMP/prefix/bin/dsh-web-open.sh" "$app_entry"
if grep -qE '__[A-Z_]+__' "$TMP/share/applications/dsh-web.desktop"; then
  check "no placeholders left" "clean" "$(grep -oE '__[A-Z_]+__' "$TMP/share/applications/dsh-web.desktop" | sort -u | tr '\n' ' ')"
else
  check "no placeholders left" "clean" "clean"
fi
test -s "$TMP/share/icons/dsh-web.svg"; ok_if "icon file written" $?
test -x "$TMP/Desktop/dsh-web.desktop"; ok_if "desktop entry is executable" $?

uninstall_out="$(DSH_WEB_PREFIX="$TMP/prefix" \
  XDG_DATA_HOME="$TMP/share" \
  DSH_WEB_DESKTOP_DIR="$TMP/Desktop" \
  DSH_WEB_SYSTEMD_UNIT_DIR="$UNIT_DIR" \
  "$REPO_DIR/install.sh" --uninstall 2>&1)"
check "uninstall reports the desktop file" "$TMP/Desktop/dsh-web.desktop" "$uninstall_out"
test ! -e "$TMP/prefix/bin/dsh-web-open.sh"; ok_if "uninstall removes the launcher" $?
test ! -e "$TMP/share/icons/dsh-web.svg"; ok_if "uninstall removes the icon" $?
test ! -e "$UNIT_DIR/dsh-web.service"; ok_if "uninstall removes the systemd unit" $?

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
