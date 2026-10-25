/**
 * Client half of the Linux desktop-entry bundle: one page in Settings.
 *
 * The page calls the Host half over the two same-origin routes that
 * `index.js` registers, so the button and the `desktop_entry` tool run the very
 * same operation. It renders through `settings.section`, which is the slot the
 * settings shell renders one page per entry, and styles only with theme tokens
 * so it reads correctly in both themes.
 *
 * Installing writes outside the workspace (`~/.local`, the desktop directory),
 * and the opt-in resident service keeps a server running from login. That is why
 * neither happens automatically: the page shows what is on disk and waits for an
 * explicit click.
 */
window.__ModuleLoader__.load({
  id: 'dsh-linux-desktop-entry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATUS_URL = '/desktop-entry/status';
    const ACTION_URL = '/desktop-entry/action';
    const SECTION_ID = 'desktop-entry';

    const CSS = `
      .dsh-desktop-entry { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 18px; max-width: 640px; }
      .dsh-desktop-entry__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .dsh-desktop-entry__title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
      .dsh-desktop-entry__pill { font-size: 11px; line-height: 1; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
      .dsh-desktop-entry__pill--on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .dsh-desktop-entry__pill--off { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .dsh-desktop-entry__pill--bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .dsh-desktop-entry__text { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin: 0; }
      .dsh-desktop-entry__paths { display: flex; flex-direction: column; gap: 4px; margin: 0; }
      .dsh-desktop-entry__path { display: flex; gap: 8px; align-items: baseline; font-size: 11px; }
      .dsh-desktop-entry__path dt { color: var(--dsw-alias-label-secondary); min-width: 84px; margin: 0; }
      .dsh-desktop-entry__path dd { color: var(--dsw-alias-label-primary); margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
      .dsh-desktop-entry__path dd[data-missing="true"] { color: var(--dsw-alias-label-secondary); text-decoration: line-through; }
      .dsh-desktop-entry__actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .dsh-desktop-entry__button { font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .dsh-desktop-entry__button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
      .dsh-desktop-entry__button:disabled { opacity: 0.55; cursor: default; }
      .dsh-desktop-entry__button--primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
      .dsh-desktop-entry__message { font-size: 12px; line-height: 1.5; margin: 0; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); }
      .dsh-desktop-entry__message--bad { color: var(--dsw-alias-state-error-primary); }
      .dsh-desktop-entry__message--ok { color: var(--dsw-alias-state-success-primary); }
      .dsh-desktop-entry__message--warn { color: var(--dsw-alias-state-warn-primary); }
      .dsh-desktop-entry__toggle { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
      .dsh-desktop-entry__toggle input { margin: 1px 0 0; }
      .dsh-desktop-entry__toggle--disabled { cursor: default; opacity: 0.7; }
    `;

    const PATH_LABELS = [
      ['launcher', 'Launcher'],
      ['appEntry', 'App menu'],
      ['desktopEntry', 'Desktop'],
      ['icon', 'Icon'],
    ];

    async function requestJson(url, init) {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload && payload.message ? payload.message : `request failed (HTTP ${response.status})`);
      }
      return payload;
    }

    /** The unit's real state, not just whether a file is there. */
    function systemdSummary(systemd) {
      if (!systemd.present) return `none at ${systemd.path}`;
      if (systemd.managerReachable === false) return `${systemd.path} — no user manager reachable`;
      return `${systemd.path} — ${systemd.enabled ?? 'unknown'}, ${systemd.active ?? 'unknown'}`;
    }

    /** Cases where a unit file exists but the launcher will not use it. */
    function systemdNotes(systemd) {
      if (systemd.resident) return [];
      if (systemd.present) {
        return ['A unit file exists but no user manager is reachable, so opening still starts a terminal window.'];
      }
      if (systemd.installPresent) {
        return [`The installer wrote ${systemd.installPath}, but the launcher reads ${systemd.path}. Set DSH_WEB_SYSTEMD_UNIT_FILE to the installer's path so opening uses the service.`];
      }
      return [];
    }

    function DesktopEntrySection() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      // Opt-in and off by default: a resident server is a resource decision.
      const [systemd, setSystemd] = React.useState(false);

      const reload = React.useCallback(async () => {
        try {
          setSnapshot(await requestJson(STATUS_URL, { headers: { accept: 'application/json' } }));
          setError(null);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        }
      }, []);

      React.useEffect(() => {
        reload();
      }, [reload]);

      const act = React.useCallback(async (action, options) => {
        setPending(action);
        setOutcome(null);
        setError(null);
        try {
          const result = await requestJson(ACTION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...(options ?? {}) }),
          });
          setOutcome(result);
          if (!result.ok) setError(result.message);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setPending(null);
          await reload();
        }
      }, [reload]);

      const supported = snapshot ? snapshot.supported : true;
      const installed = snapshot ? snapshot.installed : false;
      const tone = snapshot === null ? '' : !supported ? ' dsh-desktop-entry__pill--bad' : installed ? ' dsh-desktop-entry__pill--on' : ' dsh-desktop-entry__pill--off';
      const label = snapshot === null
        ? 'Checking…'
        : !supported
          ? 'Unsupported host'
          : installed
            ? 'Installed'
            : 'Not installed';

      const busy = pending !== null;
      const children = [
        h('style', { key: 'style' }, CSS),
        h('div', { className: 'dsh-desktop-entry__head', key: 'head' }, [
          h('h2', { className: 'dsh-desktop-entry__title', key: 'title' }, 'Desktop entry'),
          h('span', { className: `dsh-desktop-entry__pill${tone}`, key: 'pill' }, label),
        ]),
      ];

      if (snapshot === null && error === null) {
        children.push(h('p', { className: 'dsh-desktop-entry__text', key: 'loading' }, 'Reading the desktop entry state…'));
      }

      if (snapshot !== null && !supported) {
        children.push(h('p', { className: 'dsh-desktop-entry__text', key: 'unsupported' }, snapshot.reason));
      }

      if (snapshot !== null && supported) {
        children.push(h('p', { className: 'dsh-desktop-entry__text', key: 'server' },
          snapshot.listening
            ? `A server is listening on port ${snapshot.port} (HTTP ${snapshot.httpStatus}).`
            : snapshot.systemd.resident
              ? `Nothing is listening on port ${snapshot.port}; opening starts the systemd unit.`
              : `Nothing is listening on port ${snapshot.port}; opening starts one in a terminal window.`));
        children.push(h('dl', { className: 'dsh-desktop-entry__paths', key: 'paths' }, [
          ...PATH_LABELS.map(([key, text]) => h('div', { className: 'dsh-desktop-entry__path', key },
            h('dt', null, text),
            h('dd', { 'data-missing': String(snapshot.present[key] !== true) }, snapshot.paths[key]))),
          h('div', { className: 'dsh-desktop-entry__path', key: 'systemd' },
            h('dt', null, 'Service unit'),
            h('dd', { 'data-missing': String(snapshot.systemd.present !== true) }, systemdSummary(snapshot.systemd))),
        ]));
        systemdNotes(snapshot.systemd).forEach((note, index) => {
          children.push(h('p', {
            className: 'dsh-desktop-entry__message dsh-desktop-entry__message--warn',
            key: `systemd-note-${index}`,
          }, note));
        });
        children.push(h('label', {
          className: `dsh-desktop-entry__toggle${busy ? ' dsh-desktop-entry__toggle--disabled' : ''}`,
          key: 'systemd-toggle',
        }, [
          h('input', {
            type: 'checkbox',
            checked: systemd,
            disabled: busy,
            onChange: (event) => setSystemd(event.target.checked),
          }),
          h('span', null,
            'Also start the server at login (systemd --user service). '
            + 'This keeps a server resident and using resources even while the GUI is closed.'),
        ]));
        children.push(h('div', { className: 'dsh-desktop-entry__actions', key: 'actions' }, [
          h('button', {
            className: 'dsh-desktop-entry__button dsh-desktop-entry__button--primary',
            key: 'install',
            disabled: busy,
            onClick: () => act('install', { systemd }),
          }, pending === 'install' ? 'Installing…' : installed ? 'Reinstall' : 'Install'),
          h('button', {
            className: 'dsh-desktop-entry__button',
            key: 'uninstall',
            disabled: busy || !installed,
            onClick: () => act('uninstall'),
          }, pending === 'uninstall' ? 'Removing…' : 'Uninstall'),
          h('button', {
            className: 'dsh-desktop-entry__button',
            key: 'open',
            disabled: busy,
            onClick: () => act('open'),
          }, pending === 'open' ? 'Opening…' : 'Open in app window'),
          h('button', {
            className: 'dsh-desktop-entry__button',
            key: 'refresh',
            disabled: busy,
            onClick: () => reload(),
          }, 'Refresh'),
        ]));
        children.push(h('p', { className: 'dsh-desktop-entry__text', key: 'note' },
          'Installing writes outside your workspace: the launcher in ~/.local/bin, an app-menu entry, the icon, and a trusted copy on your desktop. '
          + 'Opening a stopped server can take up to a minute while it prints its one-time URL.'));
      }

      if (outcome !== null && outcome.ok && outcome.message) {
        children.push(h('p', { className: 'dsh-desktop-entry__message dsh-desktop-entry__message--ok', key: 'outcome' }, outcome.message));
      }
      if (error !== null) {
        children.push(h('p', { className: 'dsh-desktop-entry__message dsh-desktop-entry__message--bad', key: 'error' }, error));
      }

      return h('div', { className: 'dsh-desktop-entry' }, children);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 60,
          label: 'Desktop entry',
        }, DesktopEntrySection));
      },
    };
  },
});
