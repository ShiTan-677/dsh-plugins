import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCtx,
  createFakeDocument,
  createFakeReact,
  createMemoryStorage,
  createRecorder,
  createSessionsService,
  loadClient,
  materialize,
  renderRegistration,
  sessionList,
} from './harness.mjs'

/** 起一套「已 apply 的插件」环境。 */
function bootstrap(options = {}) {
  const recorder = options.recorder ?? createRecorder()
  const sessions = options.sessions ?? createSessionsService(sessionList([]))
  const ctx = createCtx({ sessions, uiSession: options.uiSession })
  const loaded = loadClient({
    console: recorder.console,
    lang: options.lang,
    document: options.document,
    storage: options.storage,
  })
  const react = createFakeReact()
  const moduleExports = materialize(loaded.definition, react)
  moduleExports.apply(ctx)
  return { moduleExports, ctx, sessions, recorder, document: loaded.document, react }
}

function registrationFor(ctx, slotKey) {
  const entry = ctx.__test.registrations.find((item) => item.declaration.name === slotKey)
  assert.ok(entry !== undefined, 'missing registration for ' + slotKey)
  return entry
}

test('模块导出符合 client 内核契约', () => {
  const { moduleExports } = bootstrap()
  assert.equal(moduleExports.name, 'dsh-plugin-mark-unread')
  // 跨 vm realm 的数组原型不同，先转成宿主数组再比较。
  assert.deepEqual(Array.from(moduleExports.inject), ['slots', 'sessions', 'locale'])
  assert.equal(typeof moduleExports.apply, 'function')
})

test('apply 注册行首点与菜单项，且只注册公开槽位', () => {
  const { ctx } = bootstrap()
  assert.deepEqual(ctx.__test.injectCalls.filter((key) => key !== 'service:uiSession'), [
    'sidebar.session.row.leading',
    'sidebar.workspaces.session.menu.item',
  ])

  const dot = registrationFor(ctx, 'sidebar.session.row.leading')
  assert.equal(dot.declaration.id, 'dsh-plugin-mark-unread-dot')
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.declaration.id, 'dsh-plugin-mark-unread-menu')
  assert.ok(menu.declaration.order > 400, '菜单项排在官方 Archive(400) 之后')
})

test('apply 向官方 locale 服务注册中英文字典，两个槽位都声明该命名空间', () => {
  const { ctx } = bootstrap()
  const dict = ctx.__test.dictionaries.get('dsh-mark-unread')
  assert.ok(dict !== undefined, '必须注册字典')
  assert.equal(dict.zh.markUnread, '标记为未读')
  assert.equal(dict.en.markUnread, 'Mark as unread')
  for (const slotKey of ['sidebar.session.row.leading', 'sidebar.workspaces.session.menu.item']) {
    assert.equal(registrationFor(ctx, slotKey).declaration.locale, 'dsh-mark-unread')
  }
})

test('菜单项切换标记并收起菜单；行首点只在标记存在时渲染', () => {
  const closed = []
  const { ctx } = bootstrap()
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const dot = registrationFor(ctx, 'sidebar.session.row.leading')

  assert.equal(renderRegistration(dot, { sessionId: 's1' }, ctx), null, '默认无点')

  const unreadState = renderRegistration(menu, {
    sessionId: 's1',
    displayTitle: '会话一',
    useMenuOpenState: () => [true, (value) => closed.push(value)],
  }, ctx)
  assert.equal(unreadState.type, 'button')
  assert.equal(unreadState.props['data-dsh-mark-unread'], 'menu-item')
  assert.equal(unreadState.props.role, 'menuitem')
  assert.match(unreadState.props['aria-label'], /未读/)
  assert.ok(unreadState.props.children.some((child) => typeof child === 'string' && child.includes('标记为未读')))

  unreadState.props.onClick()
  assert.deepEqual(closed, [false], '切换后收起菜单')

  const rendered = renderRegistration(dot, { sessionId: 's1' }, ctx)
  assert.equal(rendered.type, 'span')
  assert.equal(rendered.props['data-dsh-mark-unread'], 'dot')
  assert.match(rendered.props['aria-label'], /未读/)

  const readState = renderRegistration(menu, { sessionId: 's1', displayTitle: '会话一', useMenuOpenState: () => [true, () => {}] }, ctx)
  assert.ok(readState.props.children.some((child) => typeof child === 'string' && child.includes('标记为已读')))
  readState.props.onClick()
  assert.equal(renderRegistration(dot, { sessionId: 's1' }, ctx), null, '再点一次取消标记')
})

test('文案跟随官方 locale 座位：默认中文，切换语言立即变英文（不再锁死在 apply 时的语言）', () => {
  // lang: en-US 模拟「页面初始按浏览器推断成英文」，而 GUI 设置是中文——apply 时读语言会判错。
  const { ctx } = bootstrap({ lang: 'en-US' })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const props = { sessionId: 's1', useMenuOpenState: () => [false, () => {}] }

  const zhRender = renderRegistration(menu, props, ctx)
  assert.ok(zhRender.props.children.some((child) => child === '标记为未读'), '活跃语言是中文时必须显示中文')

  ctx.setLocale('en')
  const enRender = renderRegistration(menu, props, ctx)
  assert.ok(enRender.props.children.some((child) => child === 'Mark as unread'), '切到英文后无需重新注册即变英文')

  ctx.setLocale('zh')
  assert.ok(renderRegistration(menu, props, ctx).props.children.some((child) => child === '标记为未读'))
})

test('locale 座位缺失时退回自带字典（按文档语言），不抛错', () => {
  const { ctx } = bootstrap({ lang: 'en-US' })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const rendered = renderRegistration(menu, { sessionId: 's1', useMenuOpenState: () => [false, () => {}] })
  assert.ok(rendered.props.children.some((child) => child === 'Mark as unread'))
  assert.equal(ctx.__test.dictionaries.size, 1, '字典仍然注册了')
})

test('会话「变成」当前视图时清除标记；对正开着的会话标记不会被立刻抹掉', () => {
  const sessions = createSessionsService(sessionList([{ id: 'a', mainView: true }, { id: 'b' }]))
  const { ctx } = bootstrap({ sessions })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const dot = registrationFor(ctx, 'sidebar.session.row.leading')
  const props = { sessionId: 'a', useMenuOpenState: () => [true, () => {}] }

  // a 正开着：标记它应保留（Codex #13115 的诉求）。
  renderRegistration(menu, props).props.onClick()
  assert.notEqual(renderRegistration(dot, { sessionId: 'a' }), null, '正开着的会话也能保持未读标记')

  // 切到 b：a 的标记保留（清除只针对新成为当前的会话）。
  sessions.set(sessionList([{ id: 'a' }, { id: 'b', mainView: true }]))
  assert.notEqual(renderRegistration(dot, { sessionId: 'a' }), null, '切走时标记保留')
  assert.equal(renderRegistration(dot, { sessionId: 'b' }), null)

  // 再切回 a：a 重新成为当前视图 → 标记被清除。
  sessions.set(sessionList([{ id: 'a', mainView: true }, { id: 'b' }]))
  assert.equal(renderRegistration(dot, { sessionId: 'a' }), null, '重新打开即视为已读')
})

test('会话从列表消失也不丢标记（孤儿条目不可见，靠容量封顶而非 prune）', () => {
  const sessions = createSessionsService(sessionList([{ id: 'a' }, { id: 'b', mainView: true }]))
  const { ctx } = bootstrap({ sessions })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const dot = registrationFor(ctx, 'sidebar.session.row.leading')

  renderRegistration(menu, { sessionId: 'a', useMenuOpenState: () => [true, () => {}] }).props.onClick()
  assert.notEqual(renderRegistration(dot, { sessionId: 'a' }), null)

  // 列表短暂不完整（重连/启动瞬间）时必须保留标记：实测 prune 在这里丢过数据。
  sessions.set(sessionList([{ id: 'b', mainView: true }]))
  assert.notEqual(renderRegistration(dot, { sessionId: 'a' }), null, '列表里暂时没有也不能删')

  sessions.set(sessionList([{ id: 'a' }, { id: 'b', mainView: true }]))
  assert.notEqual(renderRegistration(dot, { sessionId: 'a' }), null, '列表恢复后标记仍在')
})

test('重启（重新 apply）不清除当前会话的标记', () => {
  const document = createFakeDocument()
  const storage = createMemoryStorage()
  const sessions = createSessionsService(sessionList([{ id: 'a', mainView: true }, { id: 'b' }]))
  const first = bootstrap({ sessions, document, storage })
  const menu = registrationFor(first.ctx, 'sidebar.workspaces.session.menu.item')
  renderRegistration(menu, { sessionId: 'a', useMenuOpenState: () => [true, () => {}] }, first.ctx).props.onClick()
  assert.notEqual(renderRegistration(registrationFor(first.ctx, 'sidebar.session.row.leading'), { sessionId: 'a' }, first.ctx), null)

  // 模拟重启：同一存储、同一「a 是当前会话」的列表，重新 apply。
  const second = bootstrap({ sessions, document, storage })
  assert.notEqual(
    renderRegistration(registrationFor(second.ctx, 'sidebar.session.row.leading'), { sessionId: 'a' }, second.ctx),
    null,
    '对正开着的会话标记未读必须活过重启',
  )
})

test('标记不会被列表变化清掉（没有 prune 路径）', () => {
  const sessions = createSessionsService(sessionList([{ id: 'a' }, { id: 'b', mainView: true }]))
  const { ctx } = bootstrap({ sessions })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const dot = registrationFor(ctx, 'sidebar.session.row.leading')
  renderRegistration(menu, { sessionId: 'a', useMenuOpenState: () => [true, () => {}] }, ctx).props.onClick()

  sessions.set(sessionList([{ id: 'b', mainView: true }], 'pending'))
  assert.notEqual(renderRegistration(dot, { sessionId: 'a' }, ctx), null, 'pending 阶段不清理')
})

test('官方出现置未读 setter 时转惰性：不再渲染任何 UI，并留下日志', () => {
  const recorder = createRecorder()
  const { ctx } = bootstrap({ recorder, uiSession: { markUnread() {} } })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const dot = registrationFor(ctx, 'sidebar.session.row.leading')

  assert.equal(renderRegistration(menu, { sessionId: 's1', useMenuOpenState: () => [true, () => {}] }), null)
  assert.equal(renderRegistration(dot, { sessionId: 's1' }), null)
  assert.match(recorder.text(), /official support detected/)
  assert.match(recorder.text(), /uiSession\.markUnread/)
})

test('官方服务没有 setter 时保持工作', () => {
  const { ctx } = bootstrap({ uiSession: { observeRunning() {}, sessionStatus: {} } })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  assert.notEqual(renderRegistration(menu, { sessionId: 's1', useMenuOpenState: () => [false, () => {}] }), null)
})

test('样式只注入一次，teardown 会移除样式并退订会话列表', () => {
  const document = createFakeDocument()
  const storage = createMemoryStorage()
  const sessions = createSessionsService(sessionList([]))
  const recorder = createRecorder()
  const ctx = createCtx({ sessions })
  const first = loadClient({ console: recorder.console, document, storage })
  materialize(first.definition, createFakeReact()).apply(ctx)
  assert.equal(document.styles.length, 1)
  assert.equal(sessions.listenerCount(), 1)
  assert.equal(ctx.__test.effects.length, 1)
  assert.match(ctx.__test.effects[0].label, /teardown/)

  // 重复 apply（HMR 重跑）不叠加 <style>。
  const again = createCtx({ sessions })
  materialize(loadClient({ console: recorder.console, document, storage }).definition, createFakeReact()).apply(again)
  assert.equal(document.styles.length, 1, '第二次 apply 不再注入样式')

  ctx.__test.effects[0].callback()()
  assert.equal(document.styles.length, 0, 'teardown 移除样式')
  assert.equal(sessions.listenerCount(), 1, '另一实例仍持有订阅')
  again.__test.effects[0].callback()()
  assert.equal(sessions.listenerCount(), 0, '两个实例都退订')
})

test('标记写进 localStorage：重载（重新 apply）后仍是未读', () => {
  const document = createFakeDocument()
  const storage = createMemoryStorage()
  const sessions = createSessionsService(sessionList([{ id: 'other', mainView: true }]))
  const first = bootstrap({ sessions, document, storage })
  const menu = registrationFor(first.ctx, 'sidebar.workspaces.session.menu.item')
  renderRegistration(menu, { sessionId: 'a', useMenuOpenState: () => [true, () => {}] }).props.onClick()
  assert.ok(storage.map.get('dsh.mark-unread.v1').includes('"a"'))

  // 模拟刷新：同一存储、同一 ctx 契约，重新加载产物。
  const second = bootstrap({ sessions, document, storage })
  const dot = registrationFor(second.ctx, 'sidebar.session.row.leading')
  assert.notEqual(renderRegistration(dot, { sessionId: 'a' }), null, '刷新后标记仍在')
})

test('localStorage 不可用（抛错）时仍可工作', () => {
  const throwing = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  const { ctx } = bootstrap({ storage: throwing })
  const menu = registrationFor(ctx, 'sidebar.workspaces.session.menu.item')
  const dot = registrationFor(ctx, 'sidebar.session.row.leading')
  renderRegistration(menu, { sessionId: 's1', useMenuOpenState: () => [true, () => {}] }).props.onClick()
  assert.notEqual(renderRegistration(dot, { sessionId: 's1' }), null, '退化成进程内标记')
})
