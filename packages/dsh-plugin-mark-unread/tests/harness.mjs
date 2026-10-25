/**
 * 测试夹具：在 Node 里跑真正的浏览器 half 产物。
 *
 * - `loadClient()` 用 vm 执行 lib/client.js，捕获 __ModuleLoader__.load 的 factory；
 * - 假 React 只实现用到的那几个 API，组件因此可以被当普通函数调用；
 * - 假 ctx 实现本插件用到的 slots / sessions / effect / inject 契约。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLIENT_PATH = join(ROOT, 'lib', 'client.js')

/** 收集 console 输出的假控制台。 */
export function createRecorder() {
  const lines = []
  return {
    lines,
    console: {
      info: (message) => lines.push({ level: 'info', message: String(message) }),
      warn: (message) => lines.push({ level: 'warn', message: String(message) }),
      error: (message) => lines.push({ level: 'error', message: String(message) }),
    },
    text: () => lines.map((line) => line.level + ': ' + line.message).join('\n'),
  }
}

/** 只满足本插件用法的 DOM。 */
export function createFakeDocument(lang = 'zh-CN') {
  const styles = []
  const document = {
    styles,
    documentElement: { getAttribute: (name) => (name === 'lang' ? lang : null) },
    head: { append: (element) => styles.push(element) },
    querySelector(selector) {
      const match = /^style\[(.+)\]$/.exec(selector)
      if (match === null) return null
      return styles.find((element) => element.attrs[match[1]] !== undefined) ?? null
    },
    createElement(tag) {
      const element = {
        tag,
        attrs: {},
        textContent: '',
        setAttribute(name, value) {
          element.attrs[name] = value
        },
        remove() {
          const index = styles.indexOf(element)
          if (index !== -1) styles.splice(index, 1)
        },
      }
      return element
    },
  }
  return document
}

/** 只实现本插件用到的 React API。 */
export function createFakeReact() {
  const unsubscribes = []
  const calls = { syncExternalStore: 0 }
  return {
    calls,
    unsubscribes,
    createElement(type, props, ...children) {
      const childrenValue = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), children: childrenValue } }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      calls.syncExternalStore += 1
      const unsubscribe = subscribe(() => {})
      if (typeof unsubscribe === 'function') unsubscribes.push(unsubscribe)
      return getSnapshot()
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useMemo(factory) {
      return factory()
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
    Fragment: Symbol('Fragment'),
  }
}

/**
 * 造一份会话列表快照。
 *
 * @param {{ id: string, mainView?: boolean, running?: boolean }[]} entries 行。
 * @param {'pending' | 'ready'} [phase] 列表阶段。
 * @returns {{ phase: string, ids: string[], byId: Record<string, object> }} 快照。
 */
export function sessionList(entries, phase = 'ready') {
  const byId = {}
  for (const entry of entries) {
    byId[entry.id] = {
      id: entry.id,
      running: entry.running === true,
      retainedBy: { mainView: entry.mainView === true ? 1 : 0 },
    }
  }
  return { phase, ids: entries.map((entry) => entry.id), byId }
}

/** 可手动推进的会话列表服务（对应 ctx.sessions）。 */
export function createSessionsService(initial) {
  let snapshot = initial ?? { phase: 'ready', ids: [], byId: {} }
  const listeners = new Set()
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

/** 记录注册结果的假 client ctx，并按官方框架的方式投影 locale 座位。 */
export function createCtx(options = {}) {
  const registrations = []
  const injectCalls = []
  const effects = []
  const serviceWaits = []
  const dictionaries = new Map()
  const locale = {
    /** 记下插件注册的字典，供假框架投影 `t`。 */
    register(namespace, dict) {
      dictionaries.set(namespace, dict)
    },
    /** 取某个命名空间在当前活跃语言下的翻译函数（框架 `ctx.locale.bind(ns)` 的等价物）。 */
    bind(namespace, active = options.locale ?? 'zh') {
      const dict = dictionaries.get(namespace)
      return (key) => {
        if (dict === undefined) return key
        return dict[active]?.[key] ?? dict.en?.[key] ?? key
      }
    },
    setActive(id) {
      options.locale = id
    },
  }
  return {
    sessions: options.sessions,
    locale,
    slots: {
      inject(key, callback) {
        injectCalls.push(key)
        callback()
      },
      register(declaration, Component) {
        const entry = { declaration, Component }
        registrations.push(entry)
        return () => {
          const index = registrations.indexOf(entry)
          if (index !== -1) registrations.splice(index, 1)
        }
      },
    },
    effect(callback, label) {
      effects.push({ callback, label })
    },
    inject(deps, callback) {
      serviceWaits.push(deps)
      if (options.uiSession !== undefined) callback({ uiSession: options.uiSession })
    },
    /** 测试内切换活跃语言（等价于用户在设置里改语言）。 */
    setLocale(id) {
      locale.setActive(id)
    },
    __test: { registrations, injectCalls, effects, serviceWaits, dictionaries },
  }
}

/** 内存版 localStorage（默认注入，模拟真实浏览器）。 */
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
  }
}

/**
 * 在 vm 里执行 lib/client.js 并取回 factory。
 *
 * @param {{ console?: object, lang?: string, document?: object, storage?: object | null }} [options] 选项。
 * @returns {{ definition: { id: string, factory: Function }, sandbox: object, document: object, storage: object | null }}
 */
export function loadClient(options = {}) {
  const code = readFileSync(CLIENT_PATH, 'utf8')
  const document = options.document ?? createFakeDocument(options.lang ?? 'zh-CN')
  const storage = options.storage === undefined ? createMemoryStorage() : options.storage
  const captured = []
  const sandbox = {
    console: options.console ?? console,
    document,
    navigator: { language: options.lang ?? 'zh-CN' },
  }
  sandbox.window = {
    __ModuleLoader__: { load: (definition) => captured.push(definition) },
    localStorage: storage,
  }
  vm.createContext(sandbox)
  new vm.Script(code, { filename: CLIENT_PATH }).runInContext(sandbox)
  if (captured.length !== 1) throw new Error('expected exactly one module definition, got ' + captured.length)
  return { definition: captured[0], sandbox, document, storage }
}

/**
 * 执行 factory，得到模块导出（{ name, inject, apply }）。
 *
 * @param {{ factory: Function }} definition loadClient 的 definition。
 * @param {object} react 假 React（见 createFakeReact）。
 * @returns {{ name: string, inject: string[], apply: Function }} 模块导出。
 */
export function materialize(definition, react) {
  const moduleExports = definition.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })
  if (moduleExports === null || typeof moduleExports !== 'object') throw new Error('factory returned no exports')
  return moduleExports
}

/**
 * 按框架的方式渲染一个已注册组件：declaration.inject() 的载荷 + 运行时 props。
 *
 * 声明了 `locale` 命名空间时，框架会额外投影翻译函数 `t`；传入 ctx 即可复现这一行为，
 * 且 `t` 在每次渲染时按当前活跃语言求值（和官方一样随语言切换实时更新）。
 *
 * @param {{ declaration: object, Component: Function }} entry 注册项。
 * @param {object} [runtimeProps] 该槽位的 owner props。
 * @param {object} [ctx] createCtx 造的假 ctx（用于 locale 投影）。
 * @returns {any} 组件的渲染结果。
 */
export function renderRegistration(entry, runtimeProps = {}, ctx) {
  const injected = typeof entry.declaration.inject === 'function' ? entry.declaration.inject() : {}
  const props = { ...injected, ...runtimeProps }
  if (props.t === undefined && typeof entry.declaration.locale === 'string' && ctx?.locale !== undefined) {
    props.t = ctx.locale.bind(entry.declaration.locale)
  }
  return entry.Component(props)
}
