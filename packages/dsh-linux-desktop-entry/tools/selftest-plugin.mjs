/**
 * Self-test for the plugin surface, the counterpart of `tools/selftest.sh`.
 *
 * `selftest.sh` covers the shell surface. This drives the Host half's HTTP
 * handlers, agent tool and slash command against a fake Cordis context, so the
 * route contract (trust fence, method, content-type, body ceiling, action
 * validation) and all three callers are checked without a running browser or a
 * cookie.
 *
 * Every installer path — the prefix, the data home, the desktop directory and
 * the `systemd --user` unit directory — is redirected into a temporary directory
 * *before* any handler is invoked, so a mutating action reached by this test
 * writes to the sandbox and never to the user's desktop or user services. That
 * redirect is deliberate rather than incidental: the tests below really do run
 * `install.sh`.
 *
 * For the same reason this test never asks the installer for `--systemd`. That
 * path ends in `systemctl --user`, which resolves the unit *by name* through the
 * live user manager and could therefore stop a service this test did not create.
 * The option's plumbing is checked here; its effect on a real user manager is
 * left to a human running it on purpose.
 *
 *   node tools/selftest-plugin.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { apply } from '../index.js';
import { PACKAGE_ROOT, VENDOR_ROOT, perform, status, systemdInstallPath, systemdUnitPath } from '../lib/desktop-entry.js';

// Redirect the installer before anything can act, and put it back afterwards.
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-desktop-entry-selftest-'));
const REDIRECTED = [
  'DSH_WEB_PREFIX',
  'XDG_DATA_HOME',
  'DSH_WEB_DESKTOP_DIR',
  'DSH_WEB_SYSTEMD_UNIT_DIR',
  'XDG_CONFIG_HOME',
];
const restored = Object.fromEntries(REDIRECTED.map((key) => [key, process.env[key]]));
process.env.DSH_WEB_PREFIX = join(sandbox, 'prefix');
process.env.XDG_DATA_HOME = join(sandbox, 'share');
process.env.DSH_WEB_DESKTOP_DIR = join(sandbox, 'Desktop');
process.env.DSH_WEB_SYSTEMD_UNIT_DIR = join(sandbox, 'config', 'systemd', 'user');
process.env.XDG_CONFIG_HOME = join(sandbox, 'config');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
  }
}

function ok(name, condition, detail = '') {
  check(name + (detail ? ` (${detail})` : ''), condition === true, true);
}

/** A request as the route handler sees it: method, headers, async body. */
function makeRequest({ method = 'GET', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    headers,
    resume() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A response that records what the handler wrote. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(text) {
      if (text !== undefined) this.body = String(text);
    },
  };
}

/** A Cordis context that records registrations instead of starting a server. */
function makeContext({ rejection } = {}) {
  const routes = new Map();
  const tools = new Map();
  const commands = new Map();
  apply({
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => {};
      },
    },
    connection: { requestRejection: () => rejection },
    effect(effect) {
      effect();
      return () => {};
    },
    get(name) {
      if (name === 'tools') return { register: (definition) => { tools.set(definition.name, definition); return () => {}; } };
      if (name === 'commands') return { register: (definition) => { commands.set(definition.name, definition); return () => {}; } };
      return undefined;
    },
  });
  return { routes, tools, commands };
}

/** Recursively list regular files under `root`, relative to it and sorted. */
async function listFiles(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // VCS metadata and Python bytecode are not part of the vendored payload.
        if (entry.name !== '.git' && entry.name !== '__pycache__') await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        found.push(relative(root, join(dir, entry.name)));
      }
    }
  }
  await walk(root);
  return found.sort();
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

try {
  console.log('== sandbox guard ==');
  ok('the unit path is redirected into the sandbox', systemdUnitPath().startsWith(sandbox), systemdUnitPath().replace(sandbox, '<sandbox>'));
  ok('the installer resolves to the vendored copy', existsSync(join(VENDOR_ROOT, 'install.sh')));
  ok('the vendored launcher is present', existsSync(join(VENDOR_ROOT, 'bin', 'dsh-web-open.sh')));

  console.log('\n== registration ==');
  const trusted = makeContext({ rejection: undefined });
  check('both routes are registered', [...trusted.routes.keys()].sort(), ['/desktop-entry/action', '/desktop-entry/status']);
  check('status route is exact', trusted.routes.get('/desktop-entry/status').kind, 'exact');
  check('action route is exact', trusted.routes.get('/desktop-entry/action').kind, 'exact');
  check('the agent tool is registered', [...trusted.tools.keys()], ['desktop_entry']);
  check('the human command is registered', [...trusted.commands.keys()], ['desktop-entry']);

  const STATUS = trusted.routes.get('/desktop-entry/status');
  const ACTION = trusted.routes.get('/desktop-entry/action');

  console.log('\n== trust fence ==');
  for (const rejection of [401, 403]) {
    const guarded = makeContext({ rejection });
    const res = makeResponse();
    await guarded.routes.get('/desktop-entry/status').handler(makeRequest(), res);
    check(`a ${rejection} from the connection service is answered with no body`, [res.statusCode, res.body], [rejection, '']);
  }

  console.log('\n== status route ==');
  {
    const res = makeResponse();
    await STATUS.handler(makeRequest({ method: 'POST' }), res);
    check('a non-GET method is refused', [res.statusCode, res.headers.allow], [405, 'GET']);
  }
  {
    const res = makeResponse();
    await STATUS.handler(makeRequest(), res);
    const payload = JSON.parse(res.body);
    check('GET answers 200 JSON', [res.statusCode, res.headers['content-type']], [200, 'application/json; charset=utf-8']);
    ok('the payload reports support and path facts', typeof payload.supported === 'boolean' && typeof payload.paths?.launcher === 'string');
    ok('the payload carries per-file presence', Object.keys(payload.present ?? {}).length > 0);
    ok('status answers from the redirected prefix', payload.paths.launcher.startsWith(sandbox), payload.paths.launcher.replace(sandbox, '<sandbox>'));
  }

  console.log('\n== action route ==');
  const jsonHeaders = { 'content-type': 'application/json' };
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'GET' }), res);
    check('a non-POST method is refused', [res.statusCode, res.headers.allow], [405, 'POST']);
  }
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), res);
    check('a non-JSON content-type is refused', res.statusCode, 415);
  }
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'POST', headers: jsonHeaders, body: 'x'.repeat(20 * 1024) }), res);
    check('an oversized body is refused', res.statusCode, 413);
  }
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'POST', headers: jsonHeaders, body: '{not json' }), res);
    check('a malformed body is refused', res.statusCode, 400);
  }
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'destroy' }) }), res);
    check('an unknown action is refused', res.statusCode, 400);
  }
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'status' }) }), res);
    const payload = JSON.parse(res.body);
    check('a known action runs and answers 200', [res.statusCode, payload.ok, payload.action], [200, true, 'status']);
    ok('the JSON response is marked uncacheable', res.headers['cache-control'] === 'no-store');
  }
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'status', systemd: 'yes' }) }), res);
    check('a non-boolean systemd flag is refused', res.statusCode, 400);
  }
  {
    const res = makeResponse();
    await ACTION.handler(makeRequest({ method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'status', systemd: true }) }), res);
    const payload = JSON.parse(res.body);
    check('a boolean systemd flag is accepted', [res.statusCode, payload.ok], [200, true]);
    const unit = payload.details?.systemd ?? {};
    check('status reports the whole unit state', Object.keys(unit).sort(), [
      'active', 'enabled', 'installPath', 'installPresent',
      'managerReachable', 'path', 'pathMismatch', 'present', 'resident', 'unit',
    ]);
    ok('both unit paths stay inside the sandbox', unit.path.startsWith(sandbox) && unit.installPath.startsWith(sandbox));
    check(
      'an absent unit file is not residency, and the manager is not asked',
      [unit.present, unit.resident, unit.managerReachable, unit.enabled, unit.active],
      [false, false, null, null, null],
    );
  }

  console.log('\n== launcher vs installer unit paths ==');
  {
    const aligned = join(sandbox, 'config', 'systemd', 'user', 'dsh-web.service');
    check('the sandbox aligns both unit paths', [systemdUnitPath(), systemdInstallPath()], [aligned, aligned]);

    // With nothing on disk and the paths aligned, there is nothing to warn about.
    check('an uninstalled unit adds no note', /note:/.test((await perform('status')).message), false);

    // Now diverge *first*, then let the installer's own path hold the file. In the
    // aligned case those are the same path, so the situation cannot be expressed at
    // all — a unit that exists and can never make anything resident.
    const installerPath = systemdInstallPath();
    const previousUnitFile = process.env.DSH_WEB_SYSTEMD_UNIT_FILE;
    process.env.DSH_WEB_SYSTEMD_UNIT_FILE = join(sandbox, 'elsewhere', 'dsh-web.service');
    await mkdir(dirname(installerPath), { recursive: true });
    await writeFile(installerPath, '# sandbox placeholder, not a real unit\n');
    const invisible = await status();
    check(
      'a unit the launcher cannot see is not residency',
      [invisible.systemd.pathMismatch, invisible.systemd.installPresent, invisible.systemd.present, invisible.systemd.resident],
      [true, true, false, false],
    );
    ok(
      'the summary names the path the launcher actually reads',
      /but the launcher reads/.test((await perform('status')).message),
    );

    // Point the launcher at that file: this is the opt-in, so the user manager is
    // consulted and residency follows its answer rather than the file's existence.
    process.env.DSH_WEB_SYSTEMD_UNIT_FILE = installerPath;
    const optedIn = await status();
    const asked = optedIn.systemd.managerReachable === true;
    check(
      'residency follows the reachable user manager, not the file alone',
      [optedIn.systemd.present, optedIn.systemd.pathMismatch, optedIn.systemd.resident],
      [true, false, asked],
    );
    check(
      'enabled and active are reported only when the manager answered',
      [optedIn.systemd.enabled === null, optedIn.systemd.active === null],
      [!asked, !asked],
    );
    if (previousUnitFile === undefined) delete process.env.DSH_WEB_SYSTEMD_UNIT_FILE;
    else process.env.DSH_WEB_SYSTEMD_UNIT_FILE = previousUnitFile;
  }

  console.log('\n== agent tool ==');
  const tool = trusted.tools.get('desktop_entry');
  {
    const result = await tool.execute({ action: 'status' });
    check('the tool runs the shared operation', [result.ok, result.action], [true, 'status']);
    ok('the tool reports the same facts as the route', /listening|installed/.test(result.message), result.message.slice(0, 64));
    const content = tool.output.render({ action: 'status' }, result);
    check('the tool renders its result as text content', [content.length, content[0].type], [1, 'text']);
  }
  {
    const result = await tool.execute({});
    check('a missing action is reported, not thrown', [result.ok, result.action], [false, '']);
  }
  check('the tool declares the four actions', tool.parameters.properties.action.enum, ['status', 'install', 'uninstall', 'open']);
  check('the tool declares the systemd flag', tool.parameters.properties.systemd.type, 'boolean');
  check('the systemd flag is optional', tool.parameters.required, ['action']);
  check('the tool output schema is closed', tool.output.schema.additionalProperties, false);

  console.log('\n== slash command ==');
  const command = trusted.commands.get('desktop-entry');
  {
    const result = await command.handler({ rawInput: '' });
    check('an empty argument defaults to status', [result.kind, typeof result.text], ['success', 'string']);
  }
  {
    const result = await command.handler({ rawInput: 'destroy' });
    check('an unknown action is an error result', result.kind, 'error');
  }
  {
    const result = await command.handler({ rawInput: 'status --systemd' });
    check('the command tolerates a trailing --systemd', result.kind, 'success');
  }
  {
    const result = await command.handler({ rawInput: '--systemd' });
    check('a flag-only input defaults to status', result.kind, 'success');
  }

  console.log('\n== vendored installer capabilities ==');
  const installerText = await readFile(join(VENDOR_ROOT, 'install.sh'), 'utf8');
  ok('the vendored installer accepts --systemd', /--systemd\)\s*install_all 1/.test(installerText));
  ok('the vendored installer removes the unit on uninstall', /remove_systemd_unit/.test(installerText));
  ok('the vendored installer names the unit', /UNIT_NAME="dsh-web\.service"/.test(installerText));

  console.log('\n== install / uninstall (redirected) ==');
  check('the sandbox starts uninstalled', (await status()).installed, false);
  {
    // A mutating action through the command, which is why the sandbox exists.
    const result = await command.handler({ rawInput: 'install' });
    check('the command installs', result.kind, 'success');
  }
  const afterInstall = await status();
  check('every installer-owned file exists', Object.fromEntries(Object.entries(afterInstall.present).filter(([key]) => key !== 'launchLog')), {
    launcher: true,
    appEntry: true,
    icon: true,
    desktopEntry: true,
  });
  ok('the status summary agrees with the presence map', /the desktop entry is installed/.test((await perform('status')).message));
  check('uninstall reports success', (await perform('uninstall')).ok, true);
  check('nothing is left installed', (await status()).installed, false);

  console.log('\n== vendored copy vs upstream ==');
  // The vendored payload is the runtime kit, not the shell project's documentation.
  // Comparing prose byte-for-byte would fail on every upstream README edit, which is
  // noise; a change to any file below is the drift that actually matters, and listing
  // the payload catches an upstream *addition* that the copy never picked up.
  const VENDORED_PAYLOAD = [
    '.gitignore',
    'LICENSE',
    'VERSION',
    'install.sh',
    'bin/dsh-web-open.sh',
    'share/dsh-web.desktop.in',
    'share/dsh-web.service.in',
    'tools/compose-icon.py',
    'tools/selftest.sh',
  ];
  const upstream = join(dirname(PACKAGE_ROOT), 'linux-dsh-web-entry');
  if (!existsSync(join(upstream, '.git'))) {
    console.log('skip: no sibling checkout at ../linux-dsh-web-entry (this is a standalone clone)');
  } else {
    check('the vendored tree is exactly the payload', await listFiles(VENDOR_ROOT), [...VENDORED_PAYLOAD].sort());
    const upstreamFiles = await listFiles(upstream);
    check('every payload file still exists upstream', VENDORED_PAYLOAD.filter((file) => !upstreamFiles.includes(file)), []);
    const differing = [];
    for (const file of VENDORED_PAYLOAD) {
      if (!upstreamFiles.includes(file)) continue;
      if ((await digest(join(VENDOR_ROOT, file))) !== (await digest(join(upstream, file)))) differing.push(file);
    }
    check('no payload file differs from upstream', differing, []);
  }
} finally {
  for (const [key, value] of Object.entries(restored)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
