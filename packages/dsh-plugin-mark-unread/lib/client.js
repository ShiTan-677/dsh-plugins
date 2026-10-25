// 生成物，请勿手改：改 src/ 后运行 `node scripts/build-client.mjs`。
// 契约：window.__ModuleLoader__.load({ id, factory }) → factory(require) 返回 { name, inject, apply }。
window.__ModuleLoader__.load({
	id: "dsh-plugin-mark-unread",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');

// ---- src/store.js ------------------------------------------------
/**
 * 手动「未读」标记的持久状态。
 *
 * 设计约束：
 * - 纯逻辑：不接触 DOM、不 import 任何模块。它同时被 lib/client.js 内联（构建时拼接）
 *   和 tests 直接 import，因此这里只允许 `export function` / `export const` 形式。
 * - 快照稳定：getSnapshot() 只在状态真正变化时返回新对象，可直接交给
 *   React.useSyncExternalStore。
 * - 存储损坏 / 版本不符一律当作空状态，绝不因为坏数据让会话列表渲染失败。
 * - 键名带版本前缀，卸载本插件时清理目标明确（见 README「卸载」）。
 */

/** localStorage 键：`dsh.mark-unread.v1`。 */
const STORAGE_KEY = 'dsh.mark-unread.v1'

/** 载荷 schema 版本；不匹配即弃用旧数据，不做迁移猜测。 */
const SCHEMA = 1

/**
 * 条目上限：按标记时间保留最近的 N 条。
 *
 * 为什么不做「会话从列表消失就删」的清理：会话列表在启动/重连瞬间可能给出不完整的
 * 快照，那时清理会误删仍然有效的标记（实测丢过一次）。孤儿条目不可见（没有行就没有
 * 点），所以只做容量封顶，永不做「看起来不在列表里就删」。
 */
const MAX_ENTRIES = 500

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isValidId(id) {
  return typeof id === 'string' && id !== ''
}

/** 读一块存储位，返回 `{ schema, ids }`；任何异常路径都退化成空状态。 */
function readState(storage) {
  const empty = { schema: SCHEMA, ids: {} }
  if (storage === null || storage === undefined) return empty
  let raw = null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return empty
  }
  if (typeof raw !== 'string' || raw === '') return empty
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!isPlainObject(parsed) || parsed.schema !== SCHEMA || !isPlainObject(parsed.ids)) return empty
  const ids = {}
  for (const [id, at] of Object.entries(parsed.ids)) {
    if (isValidId(id) && typeof at === 'number' && Number.isFinite(at)) ids[id] = at
  }
  return { schema: SCHEMA, ids }
}

/**
 * 创建未读标记存储。
 *
 * @param {{ storage?: { getItem(key: string): string | null, setItem(key: string, value: string): void } | null, now?: () => number, log?: (message: string) => void }} [options]
 *   `storage` 通常为 `window.localStorage`（不可用时传 null，退化成进程内状态）。
 * @returns 存储句柄：`getSnapshot`/`subscribe` 供 React，`has`/`mark`/`clear`/`toggle`/`prune`
 *   为行为接口，`setInert`/`isInert` 供「官方已支持」时的自我退休，`key` 为清理用的键名。
 */
function createUnreadStore(options) {
  const storage = options?.storage ?? null
  const now = options?.now ?? (() => Date.now())
  const log = options?.log ?? (() => {})

  let state = readState(storage)
  let inert = false
  let inertReason = ''
  let revision = 0
  let snapshot = buildSnapshot()
  const listeners = new Set()

  function buildSnapshot() {
    return Object.freeze({
      revision,
      inert,
      inertReason,
      ids: Object.freeze(Object.keys(state.ids)),
    })
  }

  function publish() {
    revision += 1
    snapshot = buildSnapshot()
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        log('listener failed: ' + String(error))
      }
    }
  }

  function persist() {
    if (storage === null) return
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (error) {
      log('persist failed: ' + String(error))
    }
  }

  function has(id) {
    return isValidId(id) && hasOwn(state.ids, id)
  }

  function mark(id) {
    if (!isValidId(id) || hasOwn(state.ids, id)) return false
    state = { schema: SCHEMA, ids: capEntries({ ...state.ids, [id]: now() }) }
    persist()
    publish()
    return true
  }

  function clear(id) {
    if (!isValidId(id) || !hasOwn(state.ids, id)) return false
    const ids = { ...state.ids }
    delete ids[id]
    state = { schema: SCHEMA, ids }
    persist()
    publish()
    return true
  }

  /** 反转标记并返回**新状态**（true = 现在标记为未读）。 */
  function toggle(id) {
    if (has(id)) {
      clear(id)
      return false
    }
    mark(id)
    return has(id)
  }

  /**
   * 容量封顶：超过 MAX_ENTRIES 时按标记时间丢弃最旧的条目。
   *
   * @param {Record<string, number>} ids 当前条目。
   * @returns {Record<string, number>} 封顶后的条目（未超限时原样返回）。
   */
  function capEntries(ids) {
    const entries = Object.entries(ids)
    if (entries.length <= MAX_ENTRIES) return ids
    entries.sort((left, right) => right[1] - left[1])
    const kept = {}
    for (const [id, at] of entries.slice(0, MAX_ENTRIES)) kept[id] = at
    return kept
  }

  /** 清空所有标记（卸载/重置用）。 */
  function clearAll() {
    if (Object.keys(state.ids).length === 0) return 0
    const dropped = Object.keys(state.ids).length
    state = { schema: SCHEMA, ids: {} }
    persist()
    publish()
    return dropped
  }

  /**
   * 进入「惰性」模式：官方已提供置未读能力时，本插件的 UI 全部不再渲染。
   * 惰性状态只在进程内，不落盘——下次启动若官方能力仍在，会再次判定。
   *
   * @param {string} reason 触发原因（写进日志与快照，便于排查）。
   * @returns 本次是否真的改变了状态。
   */
  function setInert(reason) {
    if (inert) return false
    inert = true
    inertReason = typeof reason === 'string' ? reason : ''
    log('official support detected (' + inertReason + '); this plugin is now inert and safe to remove')
    publish()
    return true
  }

  return {
    key: STORAGE_KEY,
    schema: SCHEMA,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    has,
    mark,
    clear,
    toggle,
    clearAll,
    maxEntries: MAX_ENTRIES,
    isInert: () => inert,
    setInert,
    size: () => Object.keys(state.ids).length,
    dispose() {
      listeners.clear()
    },
  }
}


// ---- src/plugin.js -----------------------------------------------
/**
 * 浏览器 half：工作区会话行上的「标记为未读」。
 *
 * 拼接源（scripts/build-client.mjs 把本文件与 store.js 一起放进
 * `window.__ModuleLoader__.load({ factory })` 的闭包里）：
 * - 不允许 import / export / 顶层 await；
 * - 依赖闭包里的 `React`（平台 baseline 模块表提供）与 store.js 的 `createUnreadStore`；
 * - `0.1.2` 由构建脚本替换为 package.json 的 version。
 *
 * 职责边界：
 * - 只注册官方公开槽位，不读写官方 `uiSession.completionUnread`（那是只读的进程内集合）；
 * - 状态存 localStorage（与官方「本地查看状态」口径一致），不碰宿主存储；
 * - 官方一旦提供置未读能力，本插件自动转惰性（见 setInert 探测）。
 */

const name = 'dsh-plugin-mark-unread'
const version = '0.1.2'

/** 依赖的客户端服务：槽位系统 + 会话列表（用于「会话成为当前视图」时自动清除标记）+ 官方语言服务。 */
const inject = ['slots', 'sessions', 'locale']

/** 语言命名空间：文案由官方 locale 服务投影，跟随 GUI 的语言设置实时切换。 */
const LOCALE_NS = 'dsh-mark-unread'

/** 行首座位：仅在会话行主状态为 idle 时渲染，因此不会与官方完成点抢同一个格子。 */
const DOT_SLOT = 'sidebar.session.row.leading'

/** 「…」菜单项：官方的 pin(100) / rename(200) / fork(300) / archive(400) 之后。 */
const MENU_SLOT = 'sidebar.workspaces.session.menu.item'

/** 菜单项顺序：紧跟官方 Archive，排在插件组的第一位。 */
const MENU_ORDER = 450

/** 行首座位的顺序（同座位可能还有 ui-schedule 的时钟标记等占位）。 */
const DOT_ORDER = 100

const STYLE_ATTR = 'data-dsh-mark-unread-style'

const CSS = [
  '.dsh-mu-dot{display:inline-block;box-sizing:border-box;width:7px;height:7px;border-radius:50%;background:var(--dsh-mu-accent,#4d6bfe);flex:none;}',
  '.dsh-mu-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 12px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;}',
  '.dsh-mu-menu-item:hover{background:rgba(127,127,127,.14);}',
  '.dsh-mu-menu-item:focus-visible{outline:2px solid var(--dsh-mu-accent,#4d6bfe);outline-offset:-2px;}',
  '.dsh-mu-menu-item .dsh-mu-dot{background:currentColor;}',
].join('\n')

/**
 * 语言字典（`ctx.locale.register(LOCALE_NS, ...)` 的载荷）。
 *
 * 为什么必须走官方 locale 服务：GUI 的语言是官方设置项，页面刚加载时活跃语言是
 * 浏览器推断出来的「临时值」，宿主持久化的偏好稍后才覆盖它。任何在 apply 时读一次
 * `<html lang>` 的做法都可能把英文永久锁死（实测踩过），而框架投影的 `t` 座位会随
 * 语言切换实时更新。
 */
const DICTIONARIES = {
  zh: { markUnread: '标记为未读', markRead: '标记为已读', unread: '未读' },
  en: { markUnread: 'Mark as unread', markRead: 'Mark as read', unread: 'Unread' },
}

/** 官方可能使用的置未读入口名；命中即认为官方已支持，本插件转惰性。 */
const OFFICIAL_SETTERS = [
  'markUnread',
  'markAsUnread',
  'markSessionUnread',
  'setUnread',
  'toggleUnread',
  'setCompletionUnread',
]

function log(message) {
  try {
    console.info('[dsh-plugin-mark-unread] ' + message)
  } catch {
    // 控制台不可用时静默。
  }
}

function warn(message) {
  try {
    console.warn('[dsh-plugin-mark-unread] ' + message)
  } catch {
    // 控制台不可用时静默。
  }
}

/**
 * 取翻译函数：优先官方框架投影的 `t` 座位（随语言切换实时更新）；
 * 座位缺失时退回「渲染时读一次文档语言」的自带字典，保证文案至少跟随当前语言。
 *
 * @param {unknown} seat 注册声明 `locale: LOCALE_NS` 时框架注入的 `t`。
 * @returns {(key: string) => string} 按键取文案。
 */
function translator(seat) {
  if (typeof seat === 'function') return (key) => String(seat(key))
  let lang = ''
  try {
    lang = document.documentElement.getAttribute('lang') ?? ''
  } catch {
    lang = ''
  }
  if (lang === '') {
    try {
      lang = navigator.language ?? ''
    } catch {
      lang = ''
    }
  }
  const fallback = /^zh/i.test(lang) ? DICTIONARIES.zh : DICTIONARIES.en
  return (key) => fallback[key] ?? key
}

/** localStorage 在隐私模式/被禁用时会抛错；取不到就退化成进程内状态。 */
function safeStorage() {
  try {
    const storage = window.localStorage
    // 触摸一次，确认真的可读写（Safari 的某些配置只在写入时抛错）。
    storage.getItem('dsh.mark-unread.probe')
    return storage
  } catch {
    return null
  }
}

/** 幂等注入样式；重复 apply（HMR 重跑）不会叠加 <style>。 */
function installStyles() {
  try {
    if (document.querySelector('style[' + STYLE_ATTR + ']') !== null) return null
    const element = document.createElement('style')
    element.setAttribute(STYLE_ATTR, '')
    element.setAttribute('data-plugin', name)
    element.textContent = CSS
    document.head.append(element)
    return element
  } catch (error) {
    warn('styles skipped: ' + String(error))
    return null
  }
}

function listSnapshot(sessions) {
  try {
    return sessions?.list?.getSnapshot?.() ?? undefined
  } catch {
    return undefined
  }
}

/** 当前会话 = 被 mainView retain 的那一行（与 ui-workspace / ui-session 同一判据）。 */
function findMainSessionId(sessions) {
  const byId = listSnapshot(sessions)?.byId
  if (byId === null || typeof byId !== 'object') return undefined
  for (const row of Object.values(byId)) {
    if (row !== null && typeof row === 'object' && (row.retainedBy?.mainView ?? 0) > 0) return row.id
  }
  return undefined
}

function subscribeSessions(sessions, listener) {
  try {
    const dispose = sessions?.list?.subscribe?.(listener)
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
    warn('session watch skipped: ' + String(error))
    return () => {}
  }
}

function detectOfficialSetter(service) {
  if (service === null || typeof service !== 'object') return null
  for (const key of OFFICIAL_SETTERS) {
    if (typeof service[key] === 'function') return key
  }
  return null
}

/**
 * 自我退休探测（尽力而为）：官方若在 uiSession 上暴露置未读入口，本插件立即转惰性。
 * 拿不到 uiSession 或探测本身出错时保持工作，不影响主功能。
 */
function probeOfficial(ctx, store) {
  const check = (scope) => {
    const service = (scope ?? ctx)?.uiSession
    const hit = detectOfficialSetter(service)
    if (hit !== null) store.setInert('uiSession.' + hit + '() is available')
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['uiSession'], check)
      return
    }
    check(ctx)
  } catch (error) {
    warn('official probe skipped: ' + String(error))
  }
}

/** 行首未读点。 */
function LeadingDot(props) {
  const { store, sessionId } = props
  const t = translator(props.t)
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (snapshot.inert) return null
  if (typeof sessionId !== 'string' || snapshot.ids.indexOf(sessionId) === -1) return null
  return React.createElement('span', {
    className: 'dsh-mu-dot',
    'data-dsh-mark-unread': 'dot',
    role: 'img',
    'aria-label': t('unread'),
    title: t('unread'),
  })
}

/** 「…」菜单项：在读/未读之间切换。 */
function MenuAction(props) {
  const { store, sessionId, displayTitle } = props
  const t = translator(props.t)
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  let closeMenu = () => {}
  try {
    if (typeof props.useMenuOpenState === 'function') {
      const pair = props.useMenuOpenState()
      if (Array.isArray(pair) && typeof pair[1] === 'function') closeMenu = pair[1]
    }
  } catch {
    // 菜单 hook 不可用时仍保留切换能力，只是不主动收起菜单。
  }
  if (snapshot.inert) return null
  const unread = typeof sessionId === 'string' && snapshot.ids.indexOf(sessionId) !== -1
  const label = t(unread ? 'markRead' : 'markUnread')
  return React.createElement(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      className: 'dsh-mu-menu-item',
      'data-dsh-mark-unread': 'menu-item',
      'aria-label': label,
      title: typeof displayTitle === 'string' ? displayTitle : undefined,
      onClick: () => {
        store.toggle(sessionId)
        closeMenu(false)
      },
    },
    React.createElement('span', { className: 'dsh-mu-dot', 'aria-hidden': 'true', style: { opacity: unread ? 1 : 0.3 } }),
    label,
  )
}

/**
 * 客户端入口。
 *
 * @param ctx - client 根上下文（`slots` / `sessions` / `locale` 服务由 inject 声明）。
 */
function apply(ctx) {
  const store = createUnreadStore({ storage: safeStorage(), log: warn })
  const styleElement = installStyles()

  try {
    ctx.locale.register(LOCALE_NS, { zh: DICTIONARIES.zh, en: DICTIONARIES.en })
  } catch (error) {
    warn('locale registration failed, falling back to document language: ' + String(error))
  }

  probeOfficial(ctx, store)

  // 与官方 completionUnread 同语义：会话「变成」当前视图时清除标记——但只在**运行期间
  // 观察到跃迁**时清除。启动时不对当前会话做清除：对正开着的会话标记未读（Codex #13115
  // 的诉求）必须活过重启，否则「标了未读回来处理」这个用法整个失效（实测踩过）。
  let lastMain = findMainSessionId(ctx.sessions)
  const unsubscribe = subscribeSessions(ctx.sessions, () => {
    const nextMain = findMainSessionId(ctx.sessions)
    if (nextMain !== undefined && nextMain !== lastMain) store.clear(nextMain)
    lastMain = nextMain
  })

  ctx.effect(() => () => {
    unsubscribe()
    if (styleElement !== null) styleElement.remove()
    store.dispose()
  }, name + ': teardown')

  ctx.slots.inject(DOT_SLOT, () => ctx.slots.register({
    name: DOT_SLOT,
    id: name + '-dot',
    order: DOT_ORDER,
    locale: LOCALE_NS,
    inject: () => ({ store }),
  }, LeadingDot))

  ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
    name: MENU_SLOT,
    id: name + '-menu',
    order: MENU_ORDER,
    locale: LOCALE_NS,
    inject: () => ({ store }),
  }, MenuAction))

  log('v' + version + ' active — 会话行「…」菜单可标记未读，行首圆点表示未读')
}


		module.exports = { name, inject, apply };
		return module.exports;
	}
});
