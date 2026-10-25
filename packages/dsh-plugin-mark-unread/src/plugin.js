/**
 * 浏览器 half：工作区会话行上的「标记为未读」。
 *
 * 拼接源（scripts/build-client.mjs 把本文件与 store.js 一起放进
 * `window.__ModuleLoader__.load({ factory })` 的闭包里）：
 * - 不允许 import / export / 顶层 await；
 * - 依赖闭包里的 `React`（平台 baseline 模块表提供）与 store.js 的 `createUnreadStore`；
 * - `__PLUGIN_VERSION__` 由构建脚本替换为 package.json 的 version。
 *
 * 职责边界：
 * - 只注册官方公开槽位，不读写官方 `uiSession.completionUnread`（那是只读的进程内集合）；
 * - 状态存 localStorage（与官方「本地查看状态」口径一致），不碰宿主存储；
 * - 官方一旦提供置未读能力，本插件自动转惰性（见 setInert 探测）。
 */

const name = 'dsh-plugin-mark-unread'
const version = '__PLUGIN_VERSION__'

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
