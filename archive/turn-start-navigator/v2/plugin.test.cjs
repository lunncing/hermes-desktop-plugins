const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const pluginPath = path.join(__dirname, 'plugin.js')
const legacyPluginPath = path.join(__dirname, '..', 'auto-turn-start', 'plugin.js')
const source = fs.readFileSync(pluginPath, 'utf8')
const legacySource = fs.readFileSync(legacyPluginPath, 'utf8')

const STYLE_ID = 'turn-start-navigator-v2-style'
const EXTRA = '--turn-start-extra-clearance'

function createHarness({ short = false, withTile = true } = {}) {
  const timers = new Map()
  const observers = []
  const cleanups = []
  const listeners = new Map()
  const sessionSubscribers = new Set()
  let nextHandle = 1
  let activeSessionId = 'A'
  let workspaceSessionId = 'A'

  class Style {
    setProperty(name, value) { this[name] = String(value) }
    removeProperty(name) { delete this[name] }
    getPropertyValue(name) { return this[name] ?? '' }
  }

  class Element {
    constructor(name, attrs = {}) {
      this.name = name
      this.children = []
      this.parentElement = null
      this.isConnected = true
      this.attributes = new Map(Object.entries(attrs))
      this.style = new Style()
      this.id = ''
      this.textContent = ''
    }
    appendChild(child) {
      if (child.parentElement) child.remove()
      child.parentElement = this
      child.isConnected = true
      this.children.push(child)
      return child
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this)
      this.parentElement = null
      this.isConnected = false
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    matches(selector) {
      return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
        this.attributes.has(name) && (value === undefined || this.getAttribute(name) === value))
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
      if (selector === '*') return descendants
      return descendants.filter(node => node.matches(selector))
    }
    closest(selector) {
      let node = this
      while (node) {
        if (node.matches(selector)) return node
        node = node.parentElement
      }
      return null
    }
  }

  const body = new Element('body')
  const head = new Element('head')
  const workspace = new Element('workspace', { 'data-session-anchor': 'workspace' })
  const tile = new Element('tile', { 'data-session-anchor': 'tile' })
  body.appendChild(workspace)
  body.appendChild(tile)

  const sessions = new Map()
  function makeSurface(sessionId, { isShort = short } = {}) {
    const viewport = new Element(`${sessionId}-viewport`, {
      'data-slot': 'aui_thread-viewport',
      'data-following': 'false'
    })
    const content = new Element(`${sessionId}-content`, { 'data-slot': 'aui_thread-content' })
    const turn = new Element(`${sessionId}-turn`, { 'data-slot': 'aui_turn-pair' })
    const question = new Element(`${sessionId}-question`, {
      'data-slot': 'aui_user-message-root',
      'data-message-id': `${sessionId}-q1`
    })
    const assistant = new Element(`${sessionId}-assistant`, {
      'data-slot': 'aui_assistant-message-root',
      'data-streaming': 'true'
    })
    const clearance = new Element(`${sessionId}-clearance`, { 'data-slot': 'aui_composer-clearance' })
    turn.appendChild(question)
    turn.appendChild(assistant)
    content.appendChild(turn)
    content.appendChild(clearance)
    viewport.appendChild(content)

    const data = {
      sessionId, viewport, content, turn, question, assistant, clearance,
      actualContentHeight: isShort ? 700 : 1200,
      turnTop: isShort ? 450 : 750,
      turnBottom: isShort ? 650 : 950,
      scrollWrites: 0
    }
    viewport.clientHeight = 400
    viewport._scrollTop = isShort ? 200 : 700
    Object.defineProperty(viewport, 'scrollHeight', {
      get() {
        const extra = Number.parseFloat(viewport.style.getPropertyValue(EXTRA)) || 0
        return Math.max(data.actualContentHeight + extra, viewport.clientHeight)
      }
    })
    Object.defineProperty(viewport, 'scrollTop', {
      get() { return viewport._scrollTop },
      set(value) {
        data.scrollWrites++
        viewport._scrollTop = Math.max(0, Math.min(value, viewport.scrollHeight - viewport.clientHeight))
      }
    })
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500, width: 600, height: 400 })
    content.getBoundingClientRect = () => ({
      top: 100 - viewport.scrollTop,
      bottom: 100 + data.actualContentHeight - viewport.scrollTop,
      width: 600,
      height: data.actualContentHeight
    })
    turn.getBoundingClientRect = () => ({
      top: 100 + data.turnTop - viewport.scrollTop,
      bottom: 100 + data.turnBottom - viewport.scrollTop,
      width: 600,
      height: data.turnBottom - data.turnTop
    })
    sessions.set(sessionId, data)
    return data
  }

  const A = makeSurface('A')
  const B = makeSurface('B', { isShort: false })
  const T = makeSurface('T', { isShort: false })
  workspace.appendChild(A.viewport)
  if (withTile) tile.appendChild(T.viewport)

  const document = {
    body,
    head,
    createElement: name => new Element(name),
    getElementById(id) {
      return [...head.querySelectorAll('*'), ...body.querySelectorAll('*')].find(node => node.id === id) ?? null
    },
    querySelector(selector) { return body.querySelector(selector) },
    querySelectorAll(selector) {
      if (selector === `style#${STYLE_ID}`) return head.querySelectorAll('*').filter(node => node.name === 'style' && node.id === STYLE_ID)
      return body.querySelectorAll(selector)
    }
  }

  class MutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }

  const window = {
    setTimeout(callback) { const id = nextHandle++; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) }
  }

  const activeSessionIdAtom = {
    get: () => activeSessionId,
    subscribe(callback) { sessionSubscribers.add(callback); return () => sessionSubscribers.delete(callback) }
  }
  const host = {
    state: { activeSessionId: activeSessionIdAtom },
    onEvent(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
      return () => listeners.get(type)?.delete(callback)
    }
  }

  const context = {
    console, document, window, MutationObserver, host,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Symbol, globalThis: null,
    useEffect(effect) { cleanups.push(effect()) },
    jsx(type, props) { return typeof type === 'function' ? type(props) : { type, props } }
  }
  context.globalThis = context
  const executable = `(function () {\n${source.replace(/^import .*$/gm, '').replace('export default {', 'globalThis.__plugin = {')}\n})()`
  let render
  function evaluate() {
    vm.runInNewContext(executable, context, { filename: pluginPath })
    context.__plugin.register({ register(contribution) { render = contribution.render } })
  }
  evaluate()
  render()

  function replaceWorkspace(sessionId) {
    const current = workspace.children[0]
    if (current) current.remove()
    workspace.appendChild(sessions.get(sessionId).viewport)
    workspaceSessionId = sessionId
  }
  function setStreaming(sessionId, value) {
    sessions.get(sessionId).assistant.setAttribute('data-streaming', String(value))
  }
  function emit(type, sessionId, payload) {
    const event = { type }
    if (sessionId !== undefined) event.session_id = sessionId
    if (payload !== undefined) event.payload = payload
    for (const callback of [...(listeners.get(type) ?? [])]) callback(event)
  }
  function mutate() { for (const observer of observers.filter(item => !item.disconnected)) observer.callback([]) }
  function runAllTimers() {
    let guard = 20
    while (timers.size && guard-- > 0) {
      const entries = [...timers.entries()]
      timers.clear()
      for (const [, callback] of entries) callback()
    }
    assert.ok(guard > 0, 'timer queue did not settle')
  }
  return {
    A, B, T, workspace, timers, observers, listeners, sessionSubscribers, document,
    emit, mutate, setStreaming, replaceWorkspace, runAllTimers,
    reuseWorkspaceViewportFor(sessionId) {
      const viewport = workspace.children[0]
      const oldContent = viewport.children[0]
      if (oldContent) oldContent.remove()
      viewport.appendChild(sessions.get(sessionId).content)
      workspaceSessionId = sessionId
    },
    setActive(sessionId, { replaceDom = true } = {}) {
      activeSessionId = sessionId
      for (const callback of [...sessionSubscribers]) callback(sessionId)
      if (replaceDom) replaceWorkspace(sessionId)
    },
    get workspaceSessionId() { return workspaceSessionId },
    mount() { render() },
    reload() { evaluate(); render() },
    styles() { return document.querySelectorAll(`style#${STYLE_ID}`) },
    cleanup(index = cleanups.length - 1) { cleanups[index]() }
  }
}

function completeReady(harness, sessionId = 'A') {
  harness.emit('message.complete', sessionId)
  harness.setStreaming(sessionId, false)
  harness.mutate()
  harness.runAllTimers()
}

test('DOM streaming true to false and arbitrary mutations without completion never navigate', () => {
  const h = createHarness({ withTile: false })
  h.setStreaming('A', false)
  h.mutate(); h.mutate(); h.mutate()
  assert.equal(h.timers.size, 0)
  assert.equal(h.A.viewport.scrollTop, 700)
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('mount during an active stream seeds ownership for its later unscoped completion', () => {
  const h = createHarness({ withTile: false })
  h.emit('message.complete', '')
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.viewport.scrollTop, 750)
  assert.equal(h.A.scrollWrites, 1)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('authoritative completion waits for non-streaming DOM readiness then scrolls once', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.emit('message.complete', 'A')
  h.runAllTimers()
  assert.equal(h.A.scrollWrites, 0)
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.viewport.scrollTop, 750)
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('session.info running false settles a matching start when message.complete is missing', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.emit('session.info', 'A', { running: false })
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('session.info running false never creates a record without a matching start or seed', () => {
  const h = createHarness()
  h.emit('session.info', 'B', { running: false })
  assert.equal(h.timers.size, 0)
  h.setStreaming('B', false)
  h.setActive('B'); h.mutate(); h.runAllTimers()
  assert.equal(h.B.scrollWrites, 0)
  h.cleanup()
})

test('session.info running true does not settle a matching start', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.emit('session.info', 'A', { running: true })
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.timers.size, 0)
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('message.complete and session.info running false navigate exactly once together', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.emit('message.complete', 'A')
  h.emit('session.info', 'A', { running: false })
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('background completion never scrolls B and is consumed once after returning to A', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.setActive('B')
  h.emit('message.complete', 'A')
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.B.scrollWrites, 0)
  h.setActive('A'); h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('unscoped stream remains pinned to session active at message.start', () => {
  const h = createHarness()
  h.emit('message.start')
  h.setActive('B')
  h.emit('message.complete')
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.B.scrollWrites, 0)
  h.setActive('A'); h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('empty and whitespace session IDs are unscoped and stay pinned to their start session', () => {
  for (const sessionId of ['', '   ']) {
    const h = createHarness()
    h.emit('message.start', sessionId)
    h.setActive('B')
    h.emit('message.complete', sessionId)
    h.setStreaming('A', false)
    h.mutate(); h.runAllTimers()
    assert.equal(h.B.scrollWrites, 0)
    h.setActive('A'); h.mutate(); h.runAllTimers()
    assert.equal(h.A.scrollWrites, 1)
    h.mutate(); h.runAllTimers()
    assert.equal(h.A.scrollWrites, 1)
    h.cleanup()
  }
})

test('whitespace error uses and clears the unscoped stream owner', () => {
  const h = createHarness()
  h.emit('message.start')
  h.setActive('B')
  h.emit('error', '   ')
  h.emit('message.complete')
  h.setStreaming('A', false)
  h.setActive('A'); h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('switching A to B to A while A runs preserves its later completion', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.setActive('B')
  h.setActive('A')
  h.emit('message.complete', 'A')
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.B.scrollWrites, 0)
  h.cleanup()
})

test('error is conservative and never creates a turn-start navigation', () => {
  const h = createHarness({ withTile: false })
  h.emit('message.start', 'A')
  h.emit('error', 'A')
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 0)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  h.cleanup()
})

test('session records are capped at eight and eviction cancels oldest work', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.emit('message.complete', 'A')
  assert.equal(h.timers.size, 1)
  for (let index = 1; index <= 8; index++) h.emit('message.complete', `background-${index}`)
  assert.equal(h.timers.size, 0)
  h.setStreaming('A', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('new message.start cancels stale pending timer and clearance for its session', () => {
  const h = createHarness({ short: true })
  h.emit('message.start', 'A')
  h.emit('message.complete', 'A')
  h.setStreaming('A', false)
  h.mutate()
  assert.equal(h.timers.size, 1)
  h.emit('message.start', 'A')
  assert.equal(h.timers.size, 0)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  h.runAllTimers()
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('active atom changing before workspace replacement never scrolls old visible question', () => {
  const h = createHarness()
  h.emit('message.start', 'B')
  h.setActive('B', { replaceDom: false })
  h.emit('message.complete', 'B')
  h.setStreaming('B', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 0)
  h.replaceWorkspace('B'); h.mutate(); h.runAllTimers()
  assert.equal(h.B.scrollWrites, 1)
  h.cleanup()
})

test('a reused workspace viewport is accepted only after its question DOM changes', () => {
  const h = createHarness()
  h.setActive('B', { replaceDom: false })
  h.emit('message.start', 'B')
  h.emit('message.complete', 'B')
  h.setStreaming('B', false)
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 0)
  h.reuseWorkspaceViewportFor('B')
  h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('navigation selects workspace viewport and never the visible tile viewport', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  completeReady(h)
  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.T.scrollWrites, 0)
  h.cleanup()
})

test('short reply uses core clearance property and creates no transcript spacer nodes', () => {
  const h = createHarness({ short: true })
  h.emit('message.start', 'A')
  completeReady(h)
  assert.equal(h.A.viewport.scrollTop, 450)
  assert.ok(Number.parseFloat(h.A.viewport.style.getPropertyValue(EXTRA)) >= 150)
  assert.equal(h.A.content.children.length, 2)
  assert.equal(h.A.content.querySelectorAll('[data-turn-start-spacer="true"]').length, 0)
  h.cleanup()
})

test('workspace composer clearance overrides the core inline height and preserves both variables', () => {
  const h = createHarness()
  const css = h.styles()[0].textContent
  assert.match(
    css,
    /\[data-session-anchor="workspace"\]\s+\[data-slot="aui_thread-viewport"\]\s+\[data-slot="aui_composer-clearance"\]\s*\{[^}]*height:\s*calc\(\s*var\(--thread-last-message-clearance\)\s*\+\s*var\(--turn-start-extra-clearance,\s*0px\)\s*\)\s*!important\s*;/s
  )
  h.cleanup()
})

test('long reply reaches target without extra clearance', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  completeReady(h)
  assert.equal(h.A.viewport.scrollTop, 750)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  h.cleanup()
})

test('duplicate completion events and mutations still scroll exactly once', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.emit('message.complete', 'A'); h.emit('message.complete', 'A')
  h.setStreaming('A', false)
  h.mutate(); h.mutate(); h.runAllTimers()
  h.emit('message.complete', 'A'); h.mutate(); h.runAllTimers()
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('hot reload and cleanup are exhaustive and instance-safe', () => {
  const h = createHarness({ short: true })
  const firstStyle = h.styles()[0]
  h.emit('message.start', 'A'); completeReady(h)
  assert.notEqual(h.A.viewport.style.getPropertyValue(EXTRA), '')
  h.reload()
  const secondStyle = h.styles()[0]
  assert.notEqual(firstStyle, secondStyle)
  assert.equal(h.styles().length, 1)
  assert.equal(h.observers.filter(observer => !observer.disconnected).length, 1)
  assert.ok([...h.listeners.values()].every(set => set.size === 1))
  assert.equal(h.sessionSubscribers.size, 1)
  assert.equal(h.timers.size, 0)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  h.cleanup(0)
  assert.deepEqual(h.styles(), [secondStyle])
  assert.equal(h.listeners.get('message.start').size, 1)
  assert.equal(h.listeners.get('message.complete').size, 1)
  assert.equal(h.listeners.get('session.info').size, 1)
  assert.equal(h.sessionSubscribers.size, 1)
  h.cleanup(1)
  h.runAllTimers()
  assert.equal(h.styles().length, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  assert.ok(h.observers.every(observer => observer.disconnected))
  assert.equal(h.listeners.get('session.info').size, 0)
  assert.ok([...h.listeners.values()].every(set => set.size === 0))
  assert.equal(h.sessionSubscribers.size, 0)
})

test('transient same-module remount preserves pending terminal navigation', () => {
  const h = createHarness()
  h.emit('message.start', 'A')
  h.emit('message.complete', 'A')
  h.setStreaming('A', false)
  h.mutate()
  assert.equal(h.timers.size, 1)

  h.cleanup()
  h.mount()
  h.runAllTimers()

  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.observers.filter(observer => !observer.disconnected).length, 1)
  assert.ok([...h.listeners.values()].every(set => set.size === 1))
  assert.equal(h.listeners.get('session.info').size, 1)
  assert.equal(h.sessionSubscribers.size, 1)

  h.cleanup()
  h.runAllTimers()
  assert.equal(h.observers.filter(observer => !observer.disconnected).length, 0)
  assert.ok([...h.listeners.values()].every(set => set.size === 0))
  assert.equal(h.sessionSubscribers.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.styles().length, 0)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
})

test('source never mutates transcript children, scrolls ancestors, or mutates Composer', () => {
  assert.doesNotMatch(source, /data-turn-start-spacer|appendChild\([^)]*(?:spacer|content)|(?:spacer|content)[^\n]*\.remove\(/i)
  assert.doesNotMatch(source, /scrollIntoView|window\.scroll(?:To|By)?|document\.scrollingElement/)
  assert.doesNotMatch(source, /querySelector(?:All)?\([^\n]*composer(?!-clearance)|composer(?!-clearance)[^\n]*\.style/i)
})

test('theme, spacing, status text, bounded state, and disabled legacy plugin remain intact', () => {
  const h = createHarness()
  const css = h.styles()[0].textContent
  assert.match(css, /\[data-slot="aui_user-message-root"\]\[data-message-id\] \.composer-human-message/)
  assert.match(css, /gap:\s*calc\(var\(--conversation-turn-gap\) \+ 0\.45rem\)/)
  assert.match(css, /margin-bottom:\s*0\.45rem/)
  assert.match(css, /--thread-last-message-clearance/)
  assert.match(source, /自动上移：已加载/)
  assert.match(source, /MAX_SESSION_RECORDS\s*=\s*[1-9]/)
  assert.match(legacySource, /defaultEnabled:\s*false/)
  h.cleanup()
})
