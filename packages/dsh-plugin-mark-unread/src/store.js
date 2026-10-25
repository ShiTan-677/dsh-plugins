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
export function createUnreadStore(options) {
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
