import test from 'node:test'
import assert from 'node:assert/strict'

import { createUnreadStore } from '../src/store.js'

/** 内存版 localStorage。 */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

test('标记 / 取消 / 切换的基本行为', () => {
  const store = createUnreadStore({ storage: memoryStorage(), now: () => 123 })
  assert.equal(store.key, 'dsh.mark-unread.v1')
  assert.equal(store.has('s1'), false)

  assert.equal(store.mark('s1'), true)
  assert.equal(store.mark('s1'), false, '重复标记不再变化')
  assert.equal(store.has('s1'), true)
  assert.equal(store.size(), 1)

  assert.equal(store.toggle('s1'), false, 'toggle 返回新状态：已取消')
  assert.equal(store.has('s1'), false)
  assert.equal(store.toggle('s1'), true)
  assert.equal(store.has('s1'), true)

  assert.equal(store.clear('s1'), true)
  assert.equal(store.clear('s1'), false, '重复清除返回 false')
  assert.equal(store.clear(''), false, '空 id 不是合法会话')
  assert.equal(store.mark(undefined), false)
})

test('标记写进存储，重启后仍在（同一存储位）', () => {
  const storage = memoryStorage()
  const first = createUnreadStore({ storage, now: () => 1 })
  first.mark('s1')
  first.mark('s2')
  assert.equal(storage.map.get('dsh.mark-unread.v1'), JSON.stringify({ schema: 1, ids: { s1: 1, s2: 1 } }))

  const second = createUnreadStore({ storage })
  assert.deepEqual(second.getSnapshot().ids, ['s1', 's2'])
})

test('坏数据 / 版本不符退化成空状态，不抛错', () => {
  const cases = [
    'not json at all',
    'null',
    '{"schema":1}',
    '{"schema":99,"ids":{"s1":1}}',
    '{"schema":1,"ids":{"s1":"yesterday","s2":2,"":3}}',
    '[]',
  ]
  for (const raw of cases) {
    const store = createUnreadStore({ storage: memoryStorage({ 'dsh.mark-unread.v1': raw }) })
    assert.ok(store.getSnapshot().ids.length <= 1, '坏数据不产生多余标记：' + raw)
  }
  const kept = createUnreadStore({ storage: memoryStorage({ 'dsh.mark-unread.v1': '{"schema":1,"ids":{"s1":5,"bad":"x","":9}}' }) })
  assert.deepEqual(kept.getSnapshot().ids, ['s1'], '只保留合法条目')
})

test('存储不可用（null / setItem 抛错）时退化成进程内状态，不抛错', () => {
  const silent = createUnreadStore({ storage: null })
  assert.equal(silent.mark('s1'), true)
  assert.equal(silent.has('s1'), true)

  const logs = []
  const throwing = createUnreadStore({
    storage: {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    },
    log: (message) => logs.push(message),
  })
  assert.deepEqual(throwing.getSnapshot().ids, [])
  assert.equal(throwing.mark('s1'), true, '写失败不影响内存状态')
  assert.ok(logs.some((line) => line.includes('persist failed')))
})

test('快照只在变化时换对象，可直接喂 useSyncExternalStore', () => {
  const store = createUnreadStore({ storage: memoryStorage() })
  const before = store.getSnapshot()
  assert.equal(store.getSnapshot(), before, '未变化时同一对象')
  assert.equal(before.revision, 0)

  store.mark('s1')
  const after = store.getSnapshot()
  assert.notEqual(after, before)
  assert.equal(after.revision, 1)
  assert.deepEqual(after.ids, ['s1'])
  assert.ok(Object.isFrozen(after))

  store.clear('s1')
  assert.equal(store.getSnapshot().revision, 2)
  store.clear('s1')
  assert.equal(store.getSnapshot().revision, 2, '无效操作不发布')
})

test('容量封顶：超过上限时按标记时间丢弃最旧的条目', () => {
  let clock = 1
  const store = createUnreadStore({ storage: memoryStorage(), now: () => clock++ })
  const max = store.maxEntries
  assert.ok(max > 0 && Number.isInteger(max))

  for (let index = 0; index < max + 20; index += 1) store.mark('s' + String(index).padStart(4, '0'))

  assert.equal(store.size(), max, '条目数被压到上限')
  assert.equal(store.has('s0000'), false, '最旧的被丢弃')
  assert.equal(store.has('s' + String(max + 19).padStart(4, '0')), true, '最新的保留')
  assert.equal(store.has('s0019'), false)
  assert.equal(store.has('s0020'), true)
})

test('clearAll 清空并返回数量', () => {
  const store = createUnreadStore({ storage: memoryStorage() })
  assert.equal(store.clearAll(), 0)
  store.mark('s1')
  store.mark('s2')
  assert.equal(store.clearAll(), 2)
  assert.deepEqual(store.getSnapshot().ids, [])
})

test('setInert 是幂等的一次性退休开关', () => {
  const logs = []
  const store = createUnreadStore({ storage: memoryStorage(), log: (message) => logs.push(message) })
  assert.equal(store.getSnapshot().inert, false)
  assert.equal(store.setInert('uiSession.markUnread() is available'), true)
  assert.equal(store.getSnapshot().inert, true)
  assert.equal(store.getSnapshot().inertReason, 'uiSession.markUnread() is available')
  assert.equal(store.setInert('again'), false, '第二次调用不再变化')
  assert.equal(store.isInert(), true)
  assert.ok(logs.some((line) => line.includes('inert')))
})

test('订阅者在状态变化时被通知，dispose 后不再通知', () => {
  const store = createUnreadStore({ storage: memoryStorage() })
  let calls = 0
  const unsubscribe = store.subscribe(() => {
    calls += 1
  })
  store.mark('s1')
  assert.equal(calls, 1)
  unsubscribe()
  store.mark('s2')
  assert.equal(calls, 1)

  const second = createUnreadStore({ storage: memoryStorage() })
  second.subscribe(() => {
    throw new Error('listener blew up')
  })
  const logs = []
  second.subscribe(() => {})
  assert.doesNotThrow(() => second.mark('s1'), '监听器异常不应影响状态写入')
  assert.equal(second.has('s1'), true)
  assert.equal(logs.length, 0)
})
