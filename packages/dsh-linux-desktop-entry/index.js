/**
 * Host half of the desktop-entry bundle.
 *
 * Three surfaces call one implementation. The settings page fetches the HTTP
 * routes below, the `desktop_entry` tool drives the same actions from a
 * conversation, and `/desktop-entry` does it from the composer. Every one of
 * them ends in `perform()` from `lib/desktop-entry.js`, which runs this
 * repository's own `install.sh` — so the standalone shell path and the plugin
 * can never disagree about what "installed" means.
 *
 * Routes live on the same origin as the Web GUI and are behind its trust fence:
 * a request the connection service rejects is answered with its status code and
 * never reaches an action.
 */
import { ACTIONS, perform, status } from './lib/desktop-entry.js';

/** Cordis function-plugin name. */
export const name = 'dsh-desktop-entry';

/** The route carrier and the trust fence guarding every route. */
export const inject = ['webServer', 'connection'];

const STATUS_PATH = '/desktop-entry/status';
const ACTION_PATH = '/desktop-entry/action';

/** Request bodies here are a single action name; anything larger is hostile. */
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // Availability and installation facts are live, never cacheable.
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

/** Collect a bounded UTF-8 body; `null` once the ceiling is passed. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Answer an untrusted or unauthenticated request; true when it was rejected. */
function rejected(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.statusCode = rejection;
  res.end();
  return true;
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return;
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
      }
      sendJson(res, 200, await status());
    },
  }), `desktop-entry: GET ${STATUS_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return;
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST');
        return;
      }
      if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' });
        return;
      }
      let text;
      try {
        text = await readBoundedBody(req);
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' });
        return;
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' });
        return;
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON' });
        return;
      }
      const action = typeof body?.action === 'string' ? body.action : '';
      if (!ACTIONS.includes(action)) {
        sendJson(res, 400, {
          code: 'bad-request',
          message: `"action" must be one of ${ACTIONS.join(', ')}`,
        });
        return;
      }
      if (body?.systemd !== undefined && typeof body.systemd !== 'boolean') {
        sendJson(res, 400, { code: 'bad-request', message: '"systemd" must be a boolean when present' });
        return;
      }
      const result = await perform(action, { systemd: body?.systemd === true });
      // The action ran: a refusal from the OS or a missing desktop is reported
      // as the outcome, not as a transport failure.
      sendJson(res, 200, result);
    },
  }), `desktop-entry: POST ${ACTION_PATH}`);

  registerTool(ctx);
  registerCommand(ctx);
}

/**
 * The agent-facing surface. Present only where a tool registry exists, so the
 * plugin still activates in a composition without one.
 */
function registerTool(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined) return;
  ctx.effect(() => tools.register({
    name: 'desktop_entry',
    description: [
      'Inspect, install, remove or open the DeepSeek Harness Web desktop entrance for the current user.',
      'This is a Linux desktop launcher (XDG desktop file plus a shell launcher) that opens the Web GUI in a browser app window,',
      'starting `dsh web` in a terminal window when nothing is listening on the port.',
      'Use action "status" first: it reports what is installed and whether a server is listening, and changes nothing.',
      'Takes effect on the real desktop of the machine running this Harness.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'status reads current state; install and uninstall change the desktop; open launches the GUI.',
        },
        systemd: {
          type: 'boolean',
          description: 'With action "install": also write and enable a systemd --user service so the server starts at login and stays resident. Off by default, because keeping a server running is a resource decision. Ignored by the other actions.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'Whether the action completed.' },
          action: { type: 'string', description: 'The action that ran.' },
          message: { type: 'string', description: 'Human-readable outcome, including script output.' },
        },
        required: ['ok', 'action', 'message'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.message ?? '') }];
      },
    },
    async execute(args) {
      const supplied = typeof args === 'object' && args !== null ? args : {};
      const action = typeof supplied.action === 'string' ? supplied.action : '';
      const result = await perform(action, { systemd: supplied.systemd === true });
      return { ok: result.ok, action: result.action, message: result.message };
    },
  }), 'desktop-entry: tool');
}

/**
 * The human-facing surface: `/desktop-entry [status|install|uninstall|open]`,
 * where `install` also accepts `--systemd`. Registered from a plain context, so
 * it is global rather than per-agent.
 */
function registerCommand(ctx) {
  const commands = ctx.get('commands');
  if (commands === undefined) return;
  ctx.effect(() => commands.register({
    name: 'desktop-entry',
    description: 'Install, repair, remove or open the DSH Web desktop entrance',
    input: { hint: 'status | install [--systemd] | uninstall | open' },
    async handler(invocation) {
      const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
      const requested = tokens.find((token) => !token.startsWith('-')) ?? 'status';
      if (!ACTIONS.includes(requested)) {
        return { kind: 'error', text: `unknown action "${requested}"; expected one of ${ACTIONS.join(', ')}` };
      }
      const result = await perform(requested, { systemd: tokens.includes('--systemd') });
      return result.ok
        ? { kind: 'success', text: result.message }
        : { kind: 'error', text: result.message };
    },
  }), 'desktop-entry: command');
}
