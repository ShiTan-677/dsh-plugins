/**
 * Desktop-entry operations shared by every surface of this plugin.
 *
 * Installation is deliberately NOT reimplemented here. The Host half runs this
 * repository's own `install.sh` — the same script the standalone path ships and
 * `tools/selftest.sh` exercises — so the shell surface and the plugin surface
 * cannot drift apart. This module only locates the package, runs those scripts
 * with a bounded timeout, and normalizes what they report.
 *
 * Nothing here writes to the desktop on its own: `install` and `uninstall` run
 * only when a user action or an agent tool asks for them.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root: this module lives in `<package>/lib/`. */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The vendored copy of the shell kit is the only implementation of installing,
 * removing and launching this desktop entry; this plugin never reimplements it.
 * `PROVENANCE.md` records the upstream commit it was taken from, and the plugin
 * self-test compares this tree against the sibling repository when it is present.
 */
export const VENDOR_ROOT = join(PACKAGE_ROOT, 'vendor', 'linux-dsh-web-entry');

const INSTALLER = join(VENDOR_ROOT, 'install.sh');
const LAUNCHER = join(VENDOR_ROOT, 'bin', 'dsh-web-open.sh');

/** Longest child output kept in a result; the rest is dropped, not buffered. */
const MAX_OUTPUT_CHARS = 8000;

/** The actions every surface exposes. */
export const ACTIONS = ['status', 'install', 'uninstall', 'open'];

/**
 * The files `install.sh` owns, which together are "the desktop entry".
 *
 * `launchLog` is deliberately absent: the launcher creates it on first start, so
 * an installed desktop entry with no log yet is complete, not broken.
 */
const INSTALLED_KEYS = ['launcher', 'appEntry', 'desktopEntry', 'icon'];

/**
 * Why this host cannot have a desktop entry, or `undefined` when it can.
 *
 * The launcher and the installer are POSIX shell plus an XDG desktop file; no
 * other platform is claimed rather than silently mis-handled.
 */
export function unsupportedReason() {
  if (process.platform !== 'linux') {
    return `desktop entries are Linux-only; this host is ${process.platform}`;
  }
  return undefined;
}

function home() {
  return process.env.HOME || homedir();
}

/**
 * Run one child process and collect a bounded result.
 *
 * Never rejects: a missing binary, a non-zero exit, and a timeout are all
 * outcomes the caller reports rather than exceptions the runtime swallows.
 */
function run(command, args, { timeoutMs = 60_000, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: env === undefined ? process.env : { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_CHARS) return current;
      return (current + String(chunk)).slice(0, MAX_OUTPUT_CHARS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({ code: null, stdout, stderr: stderr || String(error?.message ?? error), timedOut });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

/** `xdg-user-dir` is what `install.sh` uses to pick the desktop directory. */
async function desktopDirectory() {
  if (process.env.DSH_WEB_DESKTOP_DIR) return process.env.DSH_WEB_DESKTOP_DIR;
  const result = await run('xdg-user-dir', ['DESKTOP'], { timeoutMs: 5000 });
  const reported = result.code === 0 ? result.stdout.trim() : '';
  return reported || join(home(), 'Desktop');
}

/**
 * Where `install.sh` writes, computed with the same rules it uses.
 *
 * This is a report, not a second implementation: it resolves paths so `status`
 * can name the files a user should look for, and never writes anything.
 */
export async function installPaths() {
  const prefix = process.env.DSH_WEB_PREFIX || join(home(), '.local');
  const dataHome = process.env.XDG_DATA_HOME || join(home(), '.local', 'share');
  const stateHome = process.env.XDG_STATE_HOME || join(home(), '.local', 'state');
  const entry = 'dsh-web.desktop';
  return {
    launcher: join(prefix, 'bin', 'dsh-web-open.sh'),
    appEntry: join(dataHome, 'applications', entry),
    icon: join(dataHome, 'icons', 'dsh-web.svg'),
    desktopEntry: join(await desktopDirectory(), entry),
    launchLog: join(stateHome, 'dsh-web', 'launch.log'),
  };
}

/** Port the launcher probes and passes to `dsh web`. */
function port() {
  return process.env.DSH_WEB_PORT || '3080';
}

/** Unit name the launcher starts; `install.sh` hard-codes the same default. */
function systemdUnitName() {
  return process.env.DSH_WEB_SYSTEMD_UNIT || 'dsh-web.service';
}

/**
 * The path whose existence is the launcher's systemd opt-in.
 *
 * This follows the *launcher's* rule (`bin/dsh-web-open.sh`), which is not the
 * installer's: `install.sh` can be pointed at a custom directory with
 * `DSH_WEB_SYSTEMD_UNIT_DIR`, and the launcher does not follow that unless
 * `DSH_WEB_SYSTEMD_UNIT_FILE` says so. Reporting the installer's path as
 * "resident" would claim a service the launcher will never start.
 */
export function systemdUnitPath() {
  const configHome = process.env.XDG_CONFIG_HOME || join(home(), '.config');
  return process.env.DSH_WEB_SYSTEMD_UNIT_FILE
    || join(configHome, 'systemd', 'user', systemdUnitName());
}

/** Where `install.sh --systemd` writes the unit. */
export function systemdInstallPath() {
  const configHome = process.env.XDG_CONFIG_HOME || join(home(), '.config');
  const unitDir = process.env.DSH_WEB_SYSTEMD_UNIT_DIR || join(configHome, 'systemd', 'user');
  return join(unitDir, 'dsh-web.service');
}

/**
 * Whether the resident service is real, in the launcher's own terms.
 *
 * The launcher's `use_systemd()` needs the unit file *and* a reachable user
 * manager, so both are reported rather than only the file. The manager is asked
 * only when the file exists: that is the only case in which the launcher consults
 * it at all, and it keeps an ordinary `status` from paying for extra processes.
 */
async function systemdState() {
  const unit = systemdUnitName();
  const path = systemdUnitPath();
  const installPath = systemdInstallPath();
  const present = await fileExists(path);
  const installPresent = installPath === path ? present : await fileExists(installPath);
  const common = { unit, path, installPath, present, installPresent, pathMismatch: installPath !== path };
  if (!present) {
    return { ...common, managerReachable: null, enabled: null, active: null, resident: false };
  }
  const script = [
    'systemctl --user list-units >/dev/null 2>&1 || { printf "manager=0\\n"; exit 0; }',
    'printf "manager=1\\n"',
    'printf "enabled=%s\\n" "$(systemctl --user is-enabled "$1" 2>/dev/null)"',
    'printf "active=%s\\n" "$(systemctl --user is-active "$1" 2>/dev/null)"',
  ].join('\n');
  const queried = await run('bash', ['-c', script, 'bash', unit], { timeoutMs: 15_000 });
  const fields = Object.fromEntries(
    queried.stdout
      .split('\n')
      .map((line) => line.trim().split('=', 2))
      .filter((pair) => pair.length === 2),
  );
  const managerReachable = fields.manager === '1';
  return {
    ...common,
    managerReachable,
    enabled: managerReachable ? fields.enabled || 'unknown' : null,
    active: managerReachable ? fields.active || 'unknown' : null,
    resident: managerReachable,
  };
}

/** `--status` prints 200 (credential accepted), 401 (serving, no cookie) or 000. */
async function probe() {
  const result = await run('bash', [LAUNCHER, '--status'], {
    timeoutMs: 20_000,
    env: { DSH_WEB_PORT: port() },
  });
  return result.stdout.trim().split('\n').pop()?.trim() || '000';
}

/** Which of the installed files currently exist, keyed as `installPaths()` names them. */
async function presence(paths) {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, value]) => [key, await fileExists(value)]),
  );
  return Object.fromEntries(entries);
}

/** Report what is installed and whether anything is listening, without writing. */
export async function status() {
  const reason = unsupportedReason();
  const paths = await installPaths();
  const present = reason === undefined ? await presence(paths) : {};
  // Always computed, so the shape a caller reads does not depend on the platform.
  const systemd = await systemdState();
  const httpStatus = reason === undefined ? await probe() : '000';
  return {
    supported: reason === undefined,
    reason: reason ?? null,
    platform: process.platform,
    port: port(),
    httpStatus,
    listening: httpStatus === '200' || httpStatus === '401',
    credentialAccepted: httpStatus === '200',
    // A complete installation is every file the installer owns; the launch log
    // is the launcher's to create, so its absence is not an incomplete install.
    installed: INSTALLED_KEYS.every((key) => present[key] === true),
    present,
    // The opt-in resident service is reported beside the installation, not as
    // part of it: keeping a server running from login is the user's decision.
    systemd,
    paths,
  };
}

function summarize(runResult) {
  const parts = [runResult.stdout.trim(), runResult.stderr.trim()].filter(Boolean);
  const text = parts.join('\n');
  if (runResult.timedOut) {
    return `${text}\n(timed out and was stopped)`.trim();
  }
  return text;
}

/**
 * Install or repair the launcher, app-menu entry, desktop icon and icon file.
 *
 * `systemd` additionally writes and enables a `systemd --user` unit, so the GUI
 * is served from login onwards. That keeps a server resident, which is a
 * resource decision, so it stays off unless the caller asks for it.
 */
export async function install({ systemd = false } = {}) {
  const reason = unsupportedReason();
  if (reason !== undefined) return { ok: false, action: 'install', message: reason };
  const result = await run('bash', [INSTALLER, systemd ? '--systemd' : '--install'], { timeoutMs: 120_000 });
  const output = summarize(result);
  if (result.code !== 0) {
    return { ok: false, action: 'install', message: `install.sh exited with ${result.code}\n${output}`.trim() };
  }
  return { ok: true, action: 'install', message: output || 'installed' };
}

/**
 * Remove exactly what `install.sh` installed, leaving the launch log in place.
 *
 * This stops and removes the resident unit too when one exists, so uninstalling
 * never leaves a server running behind the user's back.
 */
export async function uninstall() {
  const reason = unsupportedReason();
  if (reason !== undefined) return { ok: false, action: 'uninstall', message: reason };
  const result = await run('bash', [INSTALLER, '--uninstall'], { timeoutMs: 60_000 });
  const output = summarize(result);
  if (result.code !== 0) {
    return { ok: false, action: 'uninstall', message: `install.sh --uninstall exited with ${result.code}\n${output}`.trim() };
  }
  return { ok: true, action: 'uninstall', message: output || 'nothing to remove' };
}

/**
 * Open the GUI through the launcher, which reuses a running server and starts
 * one in a terminal window when nothing is listening.
 *
 * A cold start blocks until the launcher has the one-time token URL (its own
 * `DSH_WEB_START_TIMEOUT`, 60s by default), so the budget here exceeds it.
 */
export async function open() {
  const reason = unsupportedReason();
  if (reason !== undefined) return { ok: false, action: 'open', message: reason };
  const result = await run('bash', [LAUNCHER], {
    timeoutMs: 100_000,
    env: { DSH_WEB_PORT: port() },
  });
  const output = summarize(result);
  if (result.code !== 0) {
    return { ok: false, action: 'open', message: `launcher exited with ${result.code}\n${output}`.trim() };
  }
  return { ok: true, action: 'open', message: output || 'launcher finished' };
}

/**
 * One entry point for the HTTP routes, the agent tool and the command, so all
 * three surfaces share exactly one implementation of every action.
 */
export async function perform(action, options = {}) {
  switch (action) {
    case 'status': {
      const current = await status();
      return { ok: true, action: 'status', message: summarizeStatus(current), details: current };
    }
    case 'install':
      return install(options);
    case 'uninstall':
      return uninstall();
    case 'open':
      return open();
    default:
      return { ok: false, action: String(action), message: `unknown action; expected one of ${ACTIONS.join(', ')}` };
  }
}

/** Human-readable one-paragraph summary of a status snapshot. */
function summarizeStatus(current) {
  if (!current.supported) return current.reason;
  const missing = INSTALLED_KEYS.filter((key) => current.present[key] !== true);
  const server = current.listening
    ? `a server is listening on port ${current.port} (HTTP ${current.httpStatus})`
    : `nothing is listening on port ${current.port}`;
  const installation = missing.length === 0
    ? 'the desktop entry is installed'
    : `the desktop entry is not installed (missing: ${missing.join(', ')})`;
  return `${installation}; ${server}${systemdClause(current.systemd)}`;
}

/**
 * The resident-service sentence, in the launcher's own terms.
 *
 * A unit file alone is not residency: the launcher also needs a reachable user
 * manager, and the installer can be pointed at a directory the launcher never
 * reads. Both cases are reported as what they are instead of as "installed".
 */
function systemdClause(systemd) {
  if (systemd.resident) {
    return `; the systemd --user unit ${systemd.unit} is ${systemd.active ?? 'unknown'}`
      + ` (${systemd.enabled ?? 'unknown'}) and starts at login`;
  }
  // Not resident, so name which of the two conditions is missing. The file the
  // launcher reads and the file the installer writes can differ, and a user cannot
  // fix what the summary does not name.
  if (systemd.present) {
    return '; note: a unit file exists but no user manager is reachable, so opening still starts a terminal window';
  }
  if (systemd.installPresent) {
    return `; note: the installer wrote ${systemd.installPath}, but the launcher reads ${systemd.path},`
      + ' so opening still starts a terminal window';
  }
  return '';
}

async function fileExists(path) {
  const { lstat } = await import('node:fs/promises');
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
