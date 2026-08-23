const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const PLUGIN_PATH = path.join(__dirname, 'plugin.js')

function makeAtom(initialValue) {
  let value = initialValue
  const listeners = new Set()
  return {
    get: () => value,
    listen(listener) {
      listeners.add(listener)
      listener(value)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of listeners) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(value)
      return () => listeners.delete(listener)
    }
  }
}

function loadPlugin(options = {}) {
  const eventListeners = new Map()
  const disposals = []
  const registrations = []
  const navigations = []
  let localeBundles = null
  const stateValues = Array.isArray(options.stateValues) ? options.stateValues.slice() : null
  const sdk = {
    Badge: 'Badge',
    Button: 'Button',
    Codicon: 'Codicon',
    EmptyState: 'EmptyState',
    ErrorState: 'ErrorState',
    PALETTE_AREA: 'palette',
    ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'sidebar.nav',
    ScrollArea: 'ScrollArea',
    SearchField: 'SearchField',
    SegmentedControl: 'SegmentedControl',
    Select: 'Select',
    SelectContent: 'SelectContent',
    SelectItem: 'SelectItem',
    SelectTrigger: 'SelectTrigger',
    SelectValue: 'SelectValue',
    Skeleton: 'Skeleton',
    Tabs: 'Tabs',
    TabsList: 'TabsList',
    TabsTrigger: 'TabsTrigger',
    cn: (...parts) => parts.filter(Boolean).join(' '),
    host: {
      navigate(path) { navigations.push(path) },
      onEvent(type, listener) {
        if (!eventListeners.has(type)) eventListeners.set(type, new Set())
        eventListeners.get(type).add(listener)
        return () => eventListeners.get(type).delete(listener)
      },
      state: {
        activeSessionId: makeAtom(options.activeSessionId || null),
        focusedStoredSessionId: makeAtom(options.focusedStoredSessionId || null),
        profile: makeAtom(options.profile || null),
        viewport: makeAtom(options.viewport || { width: 1200, height: 800, narrow: false })
      }
    },
    usePluginI18n: () => key => localeBundles?.zh?.[key] ?? localeBundles?.en?.[key] ?? key,
    useValue: atom => atom.get()
  }
  const react = {
    useCallback: value => value,
    useEffect() {},
    useMemo: value => value(),
    useRef: value => ({ current: value }),
    useState: initial =>
      stateValues && stateValues.length
        ? [stateValues.shift(), () => {}]
        : [typeof initial === 'function' ? initial() : initial, () => {}]
  }
  const runtime = {
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} })
  }
  const context = {
    URLSearchParams,
    clearTimeout,
    globalThis: null,
    sdk,
    react,
    runtime,
    setTimeout,
    Symbol,
    window: options.window
  }
  context.globalThis = context

  let source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  source = source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
  source = source.replace(/export\s+(const|function|class)\s+/g, '$1 ')
  source = source.replace(/export default\s+/, 'const plugin = ')
  source = `
    const {
      Badge, Button, Codicon, EmptyState, ErrorState, PALETTE_AREA,
      ROUTES_AREA, SIDEBAR_NAV_AREA, ScrollArea, SearchField,
      SegmentedControl, Select, SelectContent, SelectItem, SelectTrigger,
      SelectValue, Skeleton, Tabs, TabsList, TabsTrigger, cn, host,
      usePluginI18n, useValue
    } = sdk
    const { useCallback, useEffect, useMemo, useRef, useState } = react
    const { jsx, jsxs } = runtime
    ${source}
    globalThis.__loaded = { plugin, testApi: __test }
  `
  vm.runInNewContext(source, context, { filename: PLUGIN_PATH })

  const ctx = {
    i18n: {
      register: bundles => {
        localeBundles = bundles
        disposals.push(['i18n', bundles])
      },
      t: key => localeBundles?.zh?.[key] ?? localeBundles?.en?.[key] ?? key
    },
    onDispose: dispose => disposals.push(dispose),
    register: contribution => {
      registrations.push(contribution)
      return () => undefined
    }
  }

  return {
    ...context.__loaded,
    context,
    ctx,
    disposals,
    emit(type, event) {
      for (const listener of eventListeners.get(type) || []) listener(event)
    },
    eventListeners,
    navigations,
    registrations
  }
}

test('normalization infers deterministic types, lanes, turns, reasoning, and tools', () => {
  const { testApi } = loadPlugin()
  const messages = [
    { id: 1, role: 'system', content: 'setup', timestamp: 10 },
    { id: 2, role: 'user', content: 'question', timestamp: 20 },
    {
      id: 3,
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'private chain',
      timestamp: 30,
      tool_calls: [{ id: 'call-1', function: { name: 'weather', arguments: '{"city":"Paris"}' } }]
    },
    { id: 4, role: 'tool', name: 'weather', tool_call_id: 'call-1', content: '{"temp":21}', timestamp: 40 },
    { id: 5, role: 'user', content: 'again', timestamp: 50 },
    { id: 6, role: 'assistant', content: 'done', timestamp: 60 }
  ]

  const nodes = testApi.normalizeMessages(messages, 'session-a')
  assert.deepEqual(
    JSON.parse(JSON.stringify(nodes.map(node => [node.type, node.lane, node.turn]))),
    [
      ['SYSTEM', 'Input', 0],
      ['USER', 'Input', 1],
      ['ASSISTANT', 'Model', 1],
      ['REASONING', 'Model', 1],
      ['TOOL', 'Tools', 1],
      ['TOOL', 'Tools', 1],
      ['USER', 'Input', 2],
      ['ASSISTANT', 'Model', 2]
    ]
  )
  assert.equal(nodes[2].preview, 'answer')
  assert.equal(nodes[3].preview, 'private chain')
  assert.equal(nodes[2].preview.includes(nodes[3].preview), false)
  assert.equal(nodes[4].metadata.toolName, 'weather')
  assert.equal(nodes[4].metadata.callId, 'call-1')
  assert.equal(nodes[5].metadata.toolName, 'weather')
  assert.equal(nodes[5].metadata.callId, 'call-1')
  assert.equal(nodes.every(node => Object.hasOwn(node, 'durationMs')), true)
  assert.equal(nodes.every(node => node.timingQuality === 'point-in-time'), true)
})

test('redaction is recursive, safe, bounded, and does not mutate source data', () => {
  const { testApi } = loadPlugin()
  const source = {
    api_key: 'alpha',
    nested: [{ Password: 'beta', safe: 'shown' }, { authorization: { bearer: 'gamma' } }],
    apiKey: 'delta',
    cookie: 'epsilon'
  }
  const original = JSON.parse(JSON.stringify(source))
  const redacted = testApi.redactSecrets(source)

  assert.equal(redacted.api_key, '[REDACTED]')
  assert.equal(redacted.nested[0].Password, '[REDACTED]')
  assert.equal(redacted.nested[0].safe, 'shown')
  assert.equal(redacted.nested[1].authorization, '[REDACTED]')
  assert.equal(redacted.apiKey, '[REDACTED]')
  assert.equal(redacted.cookie, '[REDACTED]')
  assert.deepEqual(source, original)
  assert.equal(testApi.safeRaw({ payload: 'x'.repeat(120000) }).length <= 100001, true)
})

test('Raw and Preview redact secrets embedded in JSON-shaped and plain-text string payloads', () => {
  const { testApi } = loadPlugin()
  const payloads = [
    { value: { content: '{"token":"json-token-secret","safe":"visible-json"}' }, safe: 'visible-json' },
    { value: { arguments: '{"api_key":"argument-secret","safe":"visible-argument"}' }, safe: 'visible-argument' },
    { value: { content: 'Authorization: Bearer bearer-secret\nsafe: visible-header' }, safe: 'visible-header' },
    { value: { content: 'password=password-secret\nsafe=visible-password' }, safe: 'visible-password' }
  ]
  const source = JSON.parse(JSON.stringify(payloads))

  for (const payload of payloads) {
    const raw = testApi.safeRaw(payload.value)
    const preview = testApi.safePreview(payload.value.content ?? payload.value.arguments)
    assert.equal(/json-token-secret|argument-secret|bearer-secret|password-secret/.test(raw), false)
    assert.equal(/json-token-secret|argument-secret|bearer-secret|password-secret/.test(preview), false)
    assert.equal(raw.includes(payload.safe), true)
    assert.equal(preview.includes(payload.safe), true)
  }
  assert.deepEqual(payloads, source)

  const cyclic = { content: 'token=cyclic-secret', safe: 'visible-cycle' }
  cyclic.self = cyclic
  assert.doesNotThrow(() => testApi.redactSecrets(cyclic))
  assert.doesNotThrow(() => testApi.safeRaw(cyclic))
  assert.equal(testApi.safeRaw(cyclic).includes('cyclic-secret'), false)
  assert.doesNotThrow(() => testApi.safePreview('{"token":"malformed-secret"'))
  assert.equal(testApi.safePreview('{"token":"malformed-secret"').includes('malformed-secret'), false)
})

test('search and lane filters are case-insensitive, deterministic, and inspect all searchable fields', () => {
  const { testApi } = loadPlugin()
  const nodes = [
    {
      id: 'a', type: 'USER', lane: 'Input', preview: 'Hello World', title: 'USER',
      source: 'persisted-session-message', raw: { content: 'Hello World' }, metadata: {}
    },
    {
      id: 'b', type: 'TOOL', lane: 'Tools', preview: '21 degrees', title: 'TOOL',
      source: 'live-gateway-event', raw: { city: 'PARIS' }, metadata: { toolName: 'Weather' }
    },
    {
      id: 'c', type: 'ASSISTANT', lane: 'Model', preview: 'Finished', title: 'ASSISTANT',
      source: 'persisted-session-message', raw: { note: 'Forecast' }, metadata: {}
    }
  ]

  assert.deepEqual(testApi.filterNodes(nodes, 'weather', 'all').map(node => node.id), ['b'])
  assert.deepEqual(testApi.filterNodes(nodes, 'paris', 'ALL').map(node => node.id), ['b'])
  assert.deepEqual(testApi.filterNodes(nodes, 'LIVE-GATEWAY', 'Tools').map(node => node.id), ['b'])
  assert.deepEqual(testApi.filterNodes(nodes, '', 'model').map(node => node.id), ['c'])
  assert.deepEqual(testApi.filterNodes(nodes, 'missing', 'All').map(node => node.id), [])
})

test('timeline geometry remains finite and in bounds for zero, identical, and missing timestamps', () => {
  const { testApi } = loadPlugin()
  const nodes = [
    { id: 'zero', timestamp: 0 },
    { id: 'same', timestamp: 0 },
    { id: 'missing', timestamp: null },
    { id: 'invalid', timestamp: Number.NaN }
  ]
  const geometry = testApi.timelineGeometry(nodes)

  assert.equal(geometry.length, 4)
  for (const block of geometry) {
    assert.equal(Number.isFinite(block.leftPct), true)
    assert.equal(Number.isFinite(block.widthPct), true)
    assert.equal(block.leftPct >= 0, true)
    assert.equal(block.widthPct > 0, true)
    assert.equal(block.leftPct + block.widthPct <= 100, true)
  }
  assert.deepEqual(testApi.timelineGeometry(nodes), geometry)
})

test('message, session, and live-event buffers enforce their specified bounds', () => {
  const { testApi } = loadPlugin()
  const messages = Array.from({ length: 620 }, (_, index) => ({
    id: index,
    role: 'user',
    content: String(index),
    timestamp: index
  }))
  const sessions = Array.from({ length: 140 }, (_, index) => ({ id: String(index) }))
  const buffer = testApi.createLiveEventBuffer()
  for (let index = 0; index < 1200; index += 1) buffer.push({ index })

  const nodes = testApi.normalizeMessages(messages, 'bounded')
  assert.equal(nodes.length, 500)
  assert.equal(nodes[0].preview, '120')
  assert.equal(testApi.boundSessions(sessions).length, 100)
  assert.equal(buffer.values().length, 1000)
  assert.equal(buffer.values()[0].index, 200)
})

test('missing Desktop REST bridge degrades to an explicit current-session-only capability state', async () => {
  const { testApi } = loadPlugin({ window: undefined })
  const adapter = testApi.createTraceAdapter()

  assert.equal(adapter.version, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.capabilities)), {
    persistedMessages: false,
    contextNodes: false,
    exactDurations: false,
    sourceMetadata: false,
    liveEvents: false
  })
  const listed = await adapter.listSessions()
  const loaded = await adapter.loadSession('focused-session')
  assert.equal(listed.currentSessionOnly, true)
  assert.deepEqual(Array.from(listed.sessions), [])
  assert.match(listed.error, /unavailable/i)
  assert.equal(loaded.sessionId, 'focused-session')
  assert.deepEqual(Array.from(loaded.messages), [])
  assert.match(loaded.error, /unavailable/i)
  assert.equal(testApi.resolveDefaultSessionId(' focused ', 'active'), 'focused')
  assert.equal(testApi.resolveDefaultSessionId(null, ' active '), 'active')
})

test('session selection deterministically falls back from explicit and preferred ids to recent sessions', () => {
  const { testApi } = loadPlugin()
  const recent = [{ id: '  ' }, { title: 'missing id' }, { id: ' recent-session ' }, { id: 'later-session' }]

  assert.equal(testApi.resolveSessionSelection(' explicit ', 'focused', 'active', recent), 'explicit')
  assert.equal(testApi.resolveSessionSelection('', ' focused ', 'active', recent), 'focused')
  assert.equal(testApi.resolveSessionSelection('', '', ' active ', recent), 'active')
  assert.equal(testApi.resolveSessionSelection('', '', '', recent), 'recent-session')
  assert.equal(testApi.resolveSessionSelection('', '', '', [{ id: '' }, {}]), '')
})

test('Desktop adapter preserves bridge binding and performs profiled read-only newest-page requests', async () => {
  const requests = []
  let profile = ' profile-a '
  const sessions = Array.from({ length: 125 }, (_, index) => ({ id: `s-${index}` }))
  const messages = Array.from({ length: 510 }, (_, index) => ({
    id: index,
    role: 'user',
    content: `m-${index}`,
    timestamp: index
  }))
  const window = {
    hermesDesktop: {
      marker: 'desktop-owner',
      async api(request) {
        assert.equal(this, window.hermesDesktop)
        requests.push(request)
        if (request.path.startsWith('/api/sessions?')) return { sessions }
        return { session_id: 'resolved', messages }
      }
    }
  }
  const { testApi } = loadPlugin({ window })
  const adapter = testApi.createTraceAdapter(null, () => profile)
  const listed = await adapter.listSessions()
  profile = 'profile-b'
  const loaded = await adapter.loadSession('id with/slash')

  assert.equal(adapter.capabilities.persistedMessages, true)
  assert.equal(listed.sessions.length, 100)
  assert.equal(loaded.messages.length, 500)
  assert.equal(loaded.nodes.length, 500)
  assert.equal(requests.length, 2)
  assert.match(requests[0].path, /limit=100/)
  assert.equal(requests[0].profile, 'profile-a')
  assert.equal(requests[0].method, undefined)
  assert.match(requests[1].path, /^\/api\/sessions\/id%20with%2Fslash\/messages\?/)
  assert.match(requests[1].path, /limit=500/)
  assert.match(requests[1].path, /include_compacted=true/)
  assert.match(requests[1].path, /order=latest/)
  assert.equal(requests[1].profile, 'profile-b')
  assert.equal(requests[1].method, undefined)

  const blankProfileRequests = []
  window.hermesDesktop.api = function (request) {
    assert.equal(this, window.hermesDesktop)
    blankProfileRequests.push(request)
    return { sessions: [] }
  }
  await testApi.createTraceAdapter(null, '   ').listSessions()
  assert.equal(Object.hasOwn(blankProfileRequests[0], 'profile'), false)
})

test('event relay is bounded, cleans subscriptions, and hot reload disposes its predecessor', () => {
  const loaded = loadPlugin()
  const first = loaded.testApi.installHotReloadRelay(loaded.context.sdk.host, loaded.context)
  let received = 0
  const unsubscribe = first.subscribe(() => { received += 1 })
  loaded.emit('message.complete', { session_id: 'one' })
  assert.equal(received, 1)
  assert.equal(loaded.eventListeners.get('message.complete').size, 1)
  unsubscribe()
  loaded.emit('message.complete', { session_id: 'one' })
  assert.equal(received, 1)

  const second = loaded.testApi.installHotReloadRelay(loaded.context.sdk.host, loaded.context)
  assert.equal(first.disposed(), true)
  assert.equal(loaded.eventListeners.get('message.complete').size, 1)
  for (let index = 0; index < 1100; index += 1) loaded.emit('message.complete', { session_id: String(index) })
  assert.equal(second.events().length, 1000)
  second.dispose()
  second.dispose()
  assert.equal(loaded.eventListeners.get('message.complete').size, 0)
})

test('registration contributes the localized route, sidebar entry, and palette command', () => {
  const loaded = loadPlugin()
  loaded.plugin.register(loaded.ctx)

  assert.equal(loaded.plugin.id, 'hermes-trace-viewer')
  const route = loaded.registrations.find(item => item.area === 'routes')
  const sidebar = loaded.registrations.find(item => item.area === 'sidebar.nav')
  const palette = loaded.registrations.find(item => item.area === 'palette')
  assert.equal(route.id, 'trace-route')
  assert.equal(route.data.path, '/trace')
  assert.equal(typeof route.render, 'function')
  assert.equal(sidebar.id, 'trace-nav')
  assert.equal(sidebar.data.path, '/trace')
  assert.equal(sidebar.data.label, '轨迹')
  assert.equal(palette.id, 'open-trace-viewer')
  assert.equal(palette.data.id, 'hermes-trace-viewer.open')
  assert.equal(palette.data.label, '打开轨迹检查器')
  palette.data.run()
  assert.deepEqual(loaded.navigations, ['/trace'])

  const bundles = loaded.disposals.find(item => Array.isArray(item) && item[0] === 'i18n')[1]
  assert.equal(bundles.zh.pageTitle, '轨迹检查器')
  assert.equal(bundles.en.pageTitle, 'Trace Viewer')
  assert.equal(bundles.en.openCommand, 'Open Trace Viewer')
  assert.equal(bundles.en.type, 'Type')
  assert.equal(bundles.en.status, 'Status')
  assert.equal(bundles.en.timestamp, 'Timestamp')
  assert.equal(bundles.zh.type, '类型')
  assert.equal(bundles.zh.status, '状态')
  assert.equal(bundles.zh.timestamp, '时间戳')

  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  assert.match(source, /\[t\('type'\), node\.type\]/)
  assert.match(source, /\[t\('status'\), node\.status\]/)
  assert.match(source, /\[t\('timestamp'\), formatTimestamp\(node\.timestamp\)\]/)

  const cleanup = loaded.disposals.filter(item => typeof item === 'function')
  assert.equal(cleanup.length >= 1, true)
  assert.equal(loaded.eventListeners.get('message.complete').size, 1)
  for (const dispose of cleanup) dispose()
  assert.equal(loaded.eventListeners.get('message.complete').size, 0)
})

test('preview redacts JSON-shaped secret fields before rendering', () => {
  const { testApi } = loadPlugin()
  const preview = testApi.safePreview('{"token":"do-not-show","nested":{"Password":"hidden"},"safe":"visible"}')
  assert.equal(preview.includes('do-not-show'), false)
  assert.equal(preview.includes('hidden'), false)
  assert.equal(preview.includes('[REDACTED]'), true)
  assert.equal(preview.includes('visible'), true)
})

test('source policy has only authorized imports and no unsafe rendering or side-effect patterns', () => {
  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual([...new Set(imports)].sort(), ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(source, /\brgba?\s*\(/i)
  assert.doesNotMatch(source, /\bconsole\s*\./)
  assert.doesNotMatch(source, /<\s*[A-Z][A-Za-z0-9]*(?:\s|\/?>)/)
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|setTimeout|setInterval|requestAnimationFrame)\s*\(/)
  assert.equal((source.match(/hermesDesktop/g) || []).length, 1)
  assert.match(source, /contextNodes:\s*false/)
  assert.match(source, /exactDurations:\s*false/)
})

function findAll(element, predicate, out = []) {
  if (!element || typeof element !== 'object') return out
  if (Array.isArray(element)) {
    for (const item of element) findAll(item, predicate, out)
    return out
  }
  if (predicate(element)) out.push(element)
  if (element.props) findAll(Object.values(element.props), predicate, out)
  return out
}

function panelBodies(tree) {
  return findAll(
    tree,
    element =>
      element.type === 'div' &&
      Boolean(element.props && element.props.style) &&
      element.props.style.overflowY === 'auto' &&
      element.props.style.overflowX === 'hidden'
  )
}

function textOf(value, out = []) {
  if (value === null || value === undefined || typeof value === 'boolean') return out
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value))
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) textOf(item, out)
    return out
  }
  if (typeof value === 'object' && value.props) textOf(Object.values(value.props), out)
  return out
}

const v4Node = {
  id: 'n1',
  type: 'TOOL',
  lane: 'Tools',
  turn: 1,
  status: 'complete',
  timestamp: 10,
  preview: 'hello',
  raw: { ok: true },
  source: 'persisted-session-message',
  sourcePath: 'session.messages',
  metadata: { toolName: 'weather', callId: 'call-1' }
}

test('layout contract defines the critical runtime geometry as finite valid strings', () => {
  const { testApi } = loadPlugin()
  const layout = testApi.traceLayout
  assert.equal(layout !== null && typeof layout === 'object', true)
  const expected = {
    traceRowGrid: 'auto minmax(0, 1fr) auto',
    summaryRowGrid: '7rem minmax(0, 1fr)',
    wideSplitGrid: 'minmax(0, 1fr) 22rem',
    narrowSplitGrid: 'minmax(0, 1fr)',
    traceListHeight: 'min(42rem, 55vh)',
    detailHeight: 'min(34rem, 48vh)'
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(typeof layout[key], 'string', `${key} must be a string`)
    assert.equal(layout[key], value)
  }
  for (const value of Object.values(layout)) {
    assert.equal(typeof value, 'string')
    assert.equal(value.length > 0, true)
  }
  assert.match(layout.traceListHeight, /^min\((\d+(?:\.\d+)?)rem, (\d+(?:\.\d+)?)vh\)$/)
  assert.match(layout.detailHeight, /^min\((\d+(?:\.\d+)?)rem, (\d+(?:\.\d+)?)vh\)$/)
  assert.match(layout.traceListMinHeight, /^\d+(?:\.\d+)?rem$/)
  assert.match(layout.detailMinHeight, /^\d+(?:\.\d+)?rem$/)
  const numbers = [...`${layout.traceListHeight} ${layout.detailHeight}`.matchAll(/\d+(?:\.\d+)?/g)].map(match =>
    Number(match[0])
  )
  assert.equal(numbers.length >= 4, true)
  for (const value of numbers) assert.equal(Number.isFinite(value), true)
  for (const key of ['traceRowGrid', 'summaryRowGrid', 'wideSplitGrid', 'narrowSplitGrid']) {
    assert.match(layout[key], /minmax\(0, 1fr\)/)
  }
  assert.equal(Object.isFrozen(layout), true)
})

test('critical layout sites render inline height and gridTemplateColumns styles', () => {
  const { testApi } = loadPlugin()
  const layout = testApi.traceLayout
  const t = key => key
  const node = {
    id: 'n1',
    type: 'TOOL',
    lane: 'Tools',
    turn: 1,
    status: 'complete',
    timestamp: 10,
    preview: 'hello',
    raw: { ok: true },
    metadata: { toolName: 'weather', callId: 'call-1' }
  }

  const row = testApi.TraceRow({ node, selected: false, onSelect: () => {}, t })
  assert.equal(row.props.style.gridTemplateColumns, layout.traceRowGrid)
  assert.equal(/grid-cols-\[/.test(row.props.className), false)

  const summary = testApi.SummaryRow({ label: 'Type', value: 'TOOL' })
  assert.equal(summary.props.style.gridTemplateColumns, layout.summaryRowGrid)
  assert.equal(/grid-cols-\[/.test(summary.props.className), false)

  const list = testApi.TraceList({
    nodes: [node],
    selectedId: 'n1',
    onSelect: () => {},
    capabilities: { contextNodes: false },
    t
  })
  assert.equal(list.type, 'section')
  assert.equal(list.props.style.display, 'flex')
  assert.equal(list.props.style.flexDirection, 'column')
  assert.equal(list.props.style.height, layout.traceListHeight)
  assert.equal(list.props.style.minHeight, layout.traceListMinHeight)
  assert.equal(list.props.style.minWidth, 0)
  assert.equal(list.props.style.overflow, 'hidden')
  assert.equal(findAll(list, element => element.type === 'ScrollArea').length, 0)
  assert.equal(/h-\[/.test(list.props.className || ''), false)

  const detail = testApi.DetailPanel({ node, onClose: () => {}, t })
  assert.equal(detail.type, 'aside')
  assert.equal(detail.props.style.display, 'flex')
  assert.equal(detail.props.style.flexDirection, 'column')
  assert.equal(detail.props.style.height, layout.detailHeight)
  assert.equal(detail.props.style.minHeight, layout.detailMinHeight)
  assert.equal(detail.props.style.minWidth, 0)
  assert.equal(detail.props.style.overflow, 'hidden')
  assert.equal(findAll(detail, element => element.type === 'ScrollArea').length, 0)
  assert.equal(/h-\[/.test(detail.props.className || ''), false)
})

test('plugin source has no uncompiled arbitrary height or grid-template classes', () => {
  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  assert.equal(source.includes('h-[min('), false)
  assert.equal(source.includes('grid-cols-['), false)
  assert.match(source, /export const TRACE_LAYOUT/)
  assert.match(source, /gridTemplateColumns/)
})

test('wide and narrow split grids select the contract column definitions', () => {
  const layout = loadPlugin().testApi.traceLayout
  assert.equal(loadPlugin().testApi.splitGridColumns(true), layout.wideSplitGrid)
  assert.equal(loadPlugin().testApi.splitGridColumns(false), layout.narrowSplitGrid)

  const renderSplit = viewport => {
    const loaded = loadPlugin({ viewport })
    const page = loaded.testApi.TraceViewerPage({ adapter: loaded.testApi.createTraceAdapter() })
    return findAll(
      page,
      element =>
        Boolean(element.props && element.props.style) &&
        (element.props.style.gridTemplateColumns === layout.wideSplitGrid ||
          element.props.style.gridTemplateColumns === layout.narrowSplitGrid)
    )
  }

  const wide = renderSplit({ width: 1280, height: 900, narrow: false })
  assert.equal(wide.length, 1)
  assert.equal(wide[0].props.style.gridTemplateColumns, layout.wideSplitGrid)
  assert.equal(wide[0].props.style.minWidth, 0)

  const narrow = renderSplit({ width: 700, height: 900, narrow: true })
  assert.equal(narrow.length, 1)
  assert.equal(narrow[0].props.style.gridTemplateColumns, layout.narrowSplitGrid)
  assert.equal(narrow[0].props.style.minWidth, 0)
})

test('live completion refresh gate maps the selected stored id to its active runtime id', () => {
  const { testApi } = loadPlugin()
  assert.equal(testApi.shouldRefetchSession({ type: 'message.complete', sessionId: 'selected' }, 'selected', 'focused', 'runtime'), true)
  assert.equal(testApi.shouldRefetchSession({ type: 'message.complete', sessionId: 'runtime' }, 'stored', 'stored', 'runtime'), true)
  assert.equal(testApi.shouldRefetchSession({ type: 'message.complete', sessionId: 'other-runtime' }, 'stored', 'stored', 'runtime'), false)
  assert.equal(testApi.shouldRefetchSession({ type: 'message.complete', sessionId: 'runtime' }, 'other-stored', 'stored', 'runtime'), false)
  assert.equal(testApi.shouldRefetchSession({ type: 'message.delta', sessionId: 'runtime' }, 'stored', 'stored', 'runtime'), false)
  assert.equal(testApi.shouldRefetchSession({ type: 'message.complete', sessionId: '' }, 'stored', 'stored', 'runtime'), false)
  assert.equal(testApi.shouldRefetchSession({ type: 'message.complete', sessionId: 'runtime' }, '', 'stored', 'runtime'), false)
  assert.equal(testApi.shouldRefetchSession(null, 'stored', 'stored', 'runtime'), false)
})
test('TraceList shell is a bounded inline flex column and its body is a plain scrolling div', () => {
  const { testApi } = loadPlugin()
  const layout = testApi.traceLayout
  const t = key => key

  for (const nodes of [[v4Node], []]) {
    const list = testApi.TraceList({
      nodes,
      selectedId: '',
      onSelect: () => {},
      capabilities: { contextNodes: false },
      t
    })
    assert.equal(list.type, 'section')
    assert.equal(/border/.test(list.props.className), true)
    assert.equal(list.props.style.display, 'flex')
    assert.equal(list.props.style.flexDirection, 'column')
    assert.equal(list.props.style.height, layout.traceListHeight)
    assert.equal(list.props.style.minHeight, layout.traceListMinHeight)
    assert.equal(list.props.style.minWidth, 0)
    assert.equal(list.props.style.overflow, 'hidden')
    assert.equal(/h-\[/.test(list.props.className || ''), false)

    const bodies = panelBodies(list)
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].props.style.flex, '1 1 auto')
    assert.equal(bodies[0].props.style.minHeight, 0)
    assert.equal(bodies[0].props.style.minWidth, 0)
    assert.equal(bodies[0].props.style.overflowY, 'auto')
    assert.equal(bodies[0].props.style.overflowX, 'hidden')
    assert.equal(findAll(list, element => element.type === 'ScrollArea').length, 0)
  }
})

test('DetailPanel returns the same bordered aside shell in empty and selected states', () => {
  const { testApi } = loadPlugin()
  const layout = testApi.traceLayout
  const t = key => key

  const empty = testApi.DetailPanel({ node: null, onClose: () => {}, t })
  const selected = testApi.DetailPanel({ node: v4Node, onClose: () => {}, t })

  for (const shell of [empty, selected]) {
    assert.equal(shell.type, 'aside')
    assert.equal(/border/.test(shell.props.className), true)
    assert.equal(shell.props.style.display, 'flex')
    assert.equal(shell.props.style.flexDirection, 'column')
    assert.equal(shell.props.style.height, layout.detailHeight)
    assert.equal(shell.props.style.minHeight, layout.detailMinHeight)
    assert.equal(shell.props.style.minWidth, 0)
    assert.equal(shell.props.style.overflow, 'hidden')
  }
  assert.equal(empty.props.className, selected.props.className)
  assert.deepEqual(empty.props.style, selected.props.style)
  assert.equal(findAll([empty, selected], element => element.type === 'ScrollArea').length, 0)
})

test('no-node EmptyState renders inside the constrained detail body instead of floating over rows', () => {
  const { testApi } = loadPlugin()
  const t = key => key

  const empty = testApi.DetailPanel({ node: null, onClose: () => {}, t })
  assert.notEqual(empty.type, 'EmptyState')
  assert.equal(empty.type, 'aside')

  const bodies = panelBodies(empty)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].props.style.flex, '1 1 auto')
  assert.equal(bodies[0].props.style.minHeight, 0)
  assert.equal(bodies[0].props.style.minWidth, 0)

  const nested = findAll(bodies[0], element => element.type === 'EmptyState')
  assert.equal(nested.length, 1)
  assert.equal(nested[0].props.title, 'selectNode')
  assert.equal(nested[0].props.description, 'selectNodeDescription')
})

test('selected Summary, Preview, Raw, and Source bodies all render inside the constrained detail body', () => {
  const layout = loadPlugin().testApi.traceLayout
  const t = key => key

  const renderTab = tab => {
    const { testApi } = loadPlugin({ stateValues: tab === 'summary' ? undefined : [tab] })
    return testApi.DetailPanel({ node: v4Node, onClose: () => {}, t })
  }

  const cases = [
    { tab: 'summary', match: element => element.type === 'dl' },
    {
      tab: 'preview',
      match: element => element.type === 'div' && /whitespace-pre-wrap/.test(element.props.className || '')
    },
    { tab: 'raw', match: element => element.type === 'pre' },
    { tab: 'source', match: element => element.type === 'p' }
  ]

  for (const { tab, match } of cases) {
    const shell = renderTab(tab)
    assert.equal(shell.type, 'aside', `${tab}: shell must stay an aside`)
    assert.equal(shell.props.style.height, layout.detailHeight, `${tab}: bounded shell height`)
    assert.equal(shell.props.style.minHeight, layout.detailMinHeight, `${tab}: bounded shell minimum`)
    assert.equal(shell.props.style.overflow, 'hidden', `${tab}: shell must clip overflow`)

    const bodies = panelBodies(shell)
    assert.equal(bodies.length, 1, `${tab}: exactly one constrained body`)
    assert.equal(bodies[0].props.style.flex, '1 1 auto')
    assert.equal(bodies[0].props.style.minHeight, 0)
    assert.equal(bodies[0].props.style.minWidth, 0)
    assert.equal(findAll(bodies[0], match).length >= 1, true, `${tab}: content nested inside the constrained body`)
    assert.equal(findAll(shell, element => element.type === 'ScrollArea').length, 0, `${tab}: no ScrollArea`)
  }
})

test('split wrapper uses inline grid containment and keeps list and detail as separate grid items', () => {
  const layout = loadPlugin().testApi.traceLayout

  const renderSplit = viewport => {
    const loaded = loadPlugin({ viewport })
    const page = loaded.testApi.TraceViewerPage({ adapter: loaded.testApi.createTraceAdapter() })
    const splits = findAll(
      page,
      element =>
        Boolean(element.props && element.props.style) &&
        (element.props.style.gridTemplateColumns === layout.wideSplitGrid ||
          element.props.style.gridTemplateColumns === layout.narrowSplitGrid)
    )
    assert.equal(splits.length, 1)
    const split = splits[0]
    assert.equal(Array.isArray(split.props.children), true)
    assert.equal(split.props.children.length, 2, 'list and detail must be separate grid items')
    assert.equal(split.props.children[0].type, loaded.testApi.TraceList)
    assert.equal(split.props.children[1].type, loaded.testApi.DetailPanel)
    return split
  }

  for (const split of [
    renderSplit({ width: 1280, height: 900, narrow: false }),
    renderSplit({ width: 700, height: 900, narrow: true })
  ]) {
    assert.equal(split.props.style.display, 'grid')
    assert.equal(split.props.style.alignItems, 'start')
    assert.equal(split.props.style.minWidth, 0)
    assert.match(String(split.props.style.gap), /^\d+(?:\.\d+)?rem$/)
    assert.equal(/(^|\s)grid(\s|$)/.test(split.props.className || ''), false)
  }
})

test('panels drop ScrollArea entirely from production source and rendered trees', () => {
  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  assert.equal(source.includes('ScrollArea'), false)

  const { testApi } = loadPlugin()
  const t = key => key
  const trees = [
    testApi.TraceList({ nodes: [v4Node], selectedId: 'n1', onSelect: () => {}, capabilities: { contextNodes: true }, t }),
    testApi.TraceList({ nodes: [], selectedId: '', onSelect: () => {}, capabilities: { contextNodes: false }, t }),
    testApi.DetailPanel({ node: null, onClose: () => {}, t }),
    testApi.DetailPanel({ node: v4Node, onClose: () => {}, t }),
    testApi.TraceViewerPage({ adapter: testApi.createTraceAdapter() })
  ]
  for (const tree of trees) {
    assert.equal(findAll(tree, element => element.type === 'ScrollArea').length, 0)
  }
})

test('layout V4 revision marker is registered in both locales and rendered in the page header', () => {
  const loaded = loadPlugin()
  loaded.plugin.register(loaded.ctx)

  const bundles = loaded.disposals.find(item => Array.isArray(item) && item[0] === 'i18n')[1]
  for (const locale of ['en', 'zh']) {
    assert.equal(bundles[locale].layoutRevisionZh, '布局 V4')
    assert.equal(bundles[locale].layoutRevisionEn, 'Layout V4')
  }

  const page = loaded.testApi.TraceViewerPage({ adapter: loaded.testApi.createTraceAdapter() })
  const headers = findAll(page, element => element.type === 'header')
  assert.equal(headers.length, 1)
  const badgeTexts = findAll(headers[0], element => element.type === 'Badge').flatMap(badge =>
    textOf(badge.props.children)
  )
  assert.equal(badgeTexts.some(text => text.includes('布局 V4')), true)
  assert.equal(badgeTexts.some(text => text.includes('Layout V4')), true)
})
