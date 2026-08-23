const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const pluginPath = path.join(__dirname, 'plugin.js')
const source = fs.readFileSync(pluginPath, 'utf8')

const STYLE_ID = 'turn-start-navigator-v2-style'
const EXTRA = '--turn-start-extra-clearance'

function createHarness({ short = false, withTile = true } = {}) {
  const timers = new Map()
  const cleanups = []
  const streamListeners = new Set()
  const sessionSubscribers = new Set()
  let nextTimerHandle = 1
  let activeSessionId = 'A'
  let fakeNow = 1_000_000
  let selection = { isCollapsed: true, text: '' }

  class Style {
    setProperty(name, value) { this[name] = String(value) }
    removeProperty(name) { delete this[name] }
    getPropertyValue(name) { return this[name] ?? '' }
  }

  class Element {
    constructor(name, attrs = {}, classes = []) {
      this.name = name
      this.children = []
      this.parentElement = null
      this.isConnected = false
      this.attributes = new Map(Object.entries(attrs))
      this.classList = new Set(classes)
      this.style = new Style()
      this.id = ''
      this.textContent = ''
    }

    appendChild(child) {
      if (child.parentElement) child.remove()
      child.parentElement = this
      this.children.push(child)
      child.isConnected = this.isConnected
      for (const descendant of child.querySelectorAll('*')) descendant.isConnected = this.isConnected
      return child
    }

    remove() {
      if (!this.parentElement) return
      const parent = this.parentElement
      parent.children = parent.children.filter(child => child !== this)
      this.parentElement = null
      this.isConnected = false
      for (const descendant of this.querySelectorAll('*')) descendant.isConnected = false
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    removeAttribute(name) { this.attributes.delete(name) }

    matches(selector) {
      if (selector === '*' || selector === '') return true
      const tokens = [...selector.matchAll(/([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g)]
      for (const [, tag, id, className, attr] of tokens) {
        if (tag !== undefined) {
          if (tag !== '*' && tag.toLowerCase() !== this.name.toLowerCase()) return false
        } else if (id !== undefined) {
          if (this.id !== id) return false
        } else if (className !== undefined) {
          if (!this.classList.has(className)) return false
        } else if (attr !== undefined) {
          const match = /^\s*([^\s~|^$*!=]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*$/.exec(attr)
          if (!match) throw new Error(`Unsupported test selector attribute: ${attr}`)
          const [, name, operator, doubleValue, singleValue, bareValue] = match
          const actual = this.getAttribute(name)
          if (operator === undefined) {
            if (actual === null) return false
          } else if (operator === '=') {
            const expected = doubleValue ?? singleValue ?? bareValue ?? ''
            if (actual !== expected) return false
          } else {
            throw new Error(`Unsupported test selector operator: ${operator}`)
          }
        }
      }
      return tokens.length > 0
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    querySelectorAll(selector) {
      if (selector === '*') {
        const result = []
        for (const child of this.children) {
          result.push(child, ...child.querySelectorAll('*'))
        }
        return result
      }
      const result = []
      for (const child of this.children) {
        if (child.matches(selector)) result.push(child)
        result.push(...child.querySelectorAll(selector))
      }
      return result
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
  body.isConnected = true
  head.isConnected = true
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
    const bubble = new Element('button', {}, ['composer-human-message'])
    const bubbleLabel = new Element('span', {}, ['composer-human-message-label'])
    bubble.appendChild(bubbleLabel)
    question.appendChild(bubble)
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
      sessionId,
      viewport,
      content,
      turn,
      question,
      bubble,
      bubbleLabel,
      assistant,
      clearance,
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

  const documentListeners = new Map()
  const document = {
    body,
    head,
    createElement(name) { return new Element(name) },
    getElementById(id) {
      const nodes = [...head.querySelectorAll('*'), ...body.querySelectorAll('*')]
      return nodes.find(node => node.id === id) ?? null
    },
    querySelector(selector) { return body.querySelector(selector) },
    querySelectorAll(selector) {
      if (selector === `style#${STYLE_ID}`) return head.querySelectorAll('*').filter(node => node.name === 'style' && node.id === STYLE_ID)
      return body.querySelectorAll(selector)
    },
    addEventListener(type, callback, capture = false) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Map())
      documentListeners.get(type).set(callback, { callback, capture: Boolean(capture) })
    },
    removeEventListener(type, callback, capture = false) {
      const records = documentListeners.get(type)
      if (!records) return
      for (const [key, record] of records) {
        if (record.callback === callback && record.capture === Boolean(capture)) records.delete(key)
      }
    },
    _records(type) {
      return [...(documentListeners.get(type)?.values() ?? [])]
    }
  }

  function dispatch(type, target, detail = 1) {
    const event = {
      type,
      target,
      detail,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true }
    }
    for (const record of document._records(type).filter(record => record.capture)) {
      if (event.propagationStopped) break
      record.callback(event)
    }
    for (const record of document._records(type).filter(record => !record.capture)) {
      if (event.propagationStopped) break
      record.callback(event)
    }
    return event
  }

  function clickBubble(sessionId, detail = 1) {
    const data = sessions.get(sessionId)
    const pointerDown = dispatch('pointerdown', data.bubble, detail)
    const click = dispatch('click', data.bubble, detail)
    return { pointerDown, click }
  }

  const window = {
    setTimeout(callback) { const id = nextTimerHandle++; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    getSelection() { return selection }
  }

  const activeSessionIdAtom = {
    get: () => activeSessionId,
    subscribe(callback) { sessionSubscribers.add(callback); return () => sessionSubscribers.delete(callback) }
  }
  const host = {
    state: { activeSessionId: activeSessionIdAtom },
    onEvent(type, callback) {
      if (type !== 'message.start') return () => {}
      streamListeners.add(callback)
      return () => streamListeners.delete(callback)
    }
  }

  const context = {
    console,
    document,
    window,
    host,
    Symbol,
    Date: { now: () => fakeNow },
    useEffect(effect) { cleanups.push(effect()) },
    jsx(type, props) { return typeof type === 'function' ? type(props) : { type, props } }
  }
  vm.createContext(context)

  const executable = `(function () {\n${source.replace(/^import .*$/gm, '').replace('export default {', 'globalThis.__plugin = {')}\n})()`
  let render
  function evaluate() {
    vm.runInContext(executable, context, { filename: pluginPath })
    context.__plugin.register({ register(contribution) { render = contribution.render } })
  }
  evaluate()
  render()

  function replaceWorkspace(sessionId) {
    const current = workspace.children[0]
    if (current) current.remove()
    workspace.appendChild(sessions.get(sessionId).viewport)
  }

  function emitMessageStart(sessionId) {
    const event = { type: 'message.start' }
    if (sessionId !== undefined) event.session_id = sessionId
    for (const callback of [...streamListeners]) callback(event)
  }

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
    A, B, T, workspace, tile, sessions, document, window,
    timers, streamListeners, sessionSubscribers, cleanups,
    dispatch,
    clickBubble,
    emitMessageStart,
    runAllTimers,
    setSelection(collapsed, text = collapsed ? '' : 'selected words') {
      selection.isCollapsed = collapsed
      selection.text = text
      selection.toString = () => text
    },
    setNow(value) { fakeNow = value },
    advanceNow(deltaMs) { fakeNow += deltaMs },
    setActive(sessionId, { replaceDom = true } = {}) {
      activeSessionId = sessionId
      for (const callback of [...sessionSubscribers]) callback(sessionId)
      if (replaceDom) replaceWorkspace(sessionId)
    },
    setRawScrollTop(sessionId, value) {
      const data = sessions.get(sessionId)
      data.viewport._scrollTop = value
    },
    styles() { return document.querySelectorAll(`style#${STYLE_ID}`) },
    documentListeners,
    mount() { render() },
    reload() { evaluate(); render() },
    cleanup(index = cleanups.length - 1) { cleanups[index]() }
  }
}

test('single click on a user bubble scrolls its turn start to the thread viewport top', () => {
  const h = createHarness()
  assert.equal(h.A.viewport.scrollTop, 700)
  assert.equal(h.A.scrollWrites, 0)

  const events = h.clickBubble('A')

  assert.equal(events.pointerDown.propagationStopped, true)
  assert.equal(events.pointerDown.defaultPrevented, false)
  assert.equal(events.click.propagationStopped, true)
  assert.equal(events.click.defaultPrevented, true)
  assert.equal(h.A.viewport.scrollTop, 750)
  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  h.cleanup()
})

test('a bare pointerdown intercepts but never scrolls by itself', () => {
  const h = createHarness()
  const pointerDown = h.dispatch('pointerdown', h.A.bubble, 1)

  assert.equal(pointerDown.propagationStopped, true)
  assert.equal(pointerDown.defaultPrevented, false)
  assert.equal(h.A.scrollWrites, 0)
  assert.equal(h.A.viewport.scrollTop, 700)
  h.cleanup()
})

test('second strike of a double click on the same message is released and does not navigate', () => {
  const h = createHarness()

  const first = h.clickBubble('A', 1)
  assert.equal(first.pointerDown.propagationStopped, true)
  assert.equal(first.click.defaultPrevented, true)
  assert.equal(h.A.scrollWrites, 1)

  h.advanceNow(80)
  const second = h.clickBubble('A', 2)

  assert.equal(second.pointerDown.propagationStopped, false)
  assert.equal(second.pointerDown.defaultPrevented, false)
  assert.equal(second.click.propagationStopped, false)
  assert.equal(second.click.defaultPrevented, false)
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('a click-only double-click second strike is released without requiring pointerdown events', () => {
  const h = createHarness()

  const first = h.dispatch('click', h.A.bubble, 1)
  assert.equal(first.defaultPrevented, true)
  assert.equal(h.A.scrollWrites, 1)

  h.advanceNow(80)
  const second = h.dispatch('click', h.A.bubble, 2)
  assert.equal(second.defaultPrevented, false)
  assert.equal(second.propagationStopped, false)
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('fast clicks on two different question bubbles never mistake the second click for a double click', () => {
  const h = createHarness()

  h.clickBubble('A', 1)
  h.advanceNow(80)
  const second = h.clickBubble('T', 2)

  assert.equal(second.pointerDown.propagationStopped, true)
  assert.equal(second.click.defaultPrevented, true)
  assert.equal(h.T.scrollWrites, 1)
  h.cleanup()
})

test('a detail=2 second strike outside the 400ms window navigates instead of releasing', () => {
  const h = createHarness()

  h.clickBubble('A', 1)
  h.advanceNow(401)
  const second = h.clickBubble('A', 2)

  assert.equal(second.click.defaultPrevented, true)
  assert.equal(h.A.scrollWrites, 2)
  h.cleanup()
})

test('single click while a text selection exists is fully released', () => {
  const h = createHarness()
  h.setSelection(false)

  const events = h.clickBubble('A')

  assert.equal(events.pointerDown.propagationStopped, false)
  assert.equal(events.pointerDown.defaultPrevented, false)
  assert.equal(events.click.propagationStopped, false)
  assert.equal(events.click.defaultPrevented, false)
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('selection seen at pointerdown still releases the click after the browser collapses it', () => {
  const h = createHarness()
  h.setSelection(false)

  const pointerDown = h.dispatch('pointerdown', h.A.bubble, 1)
  assert.equal(pointerDown.propagationStopped, false)

  h.setSelection(true)
  const click = h.dispatch('click', h.A.bubble, 1)
  assert.equal(click.defaultPrevented, false)
  assert.equal(click.propagationStopped, false)
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('clicks on non-bubble transcript elements propagate untouched', () => {
  const h = createHarness()
  for (const target of [h.A.assistant, h.A.content, h.A.turn]) {
    const pointerDown = h.dispatch('pointerdown', target, 1)
    const click = h.dispatch('click', target, 1)
    assert.equal(pointerDown.propagationStopped, false)
    assert.equal(pointerDown.defaultPrevented, false)
    assert.equal(click.propagationStopped, false)
    assert.equal(click.defaultPrevented, false)
  }
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('clicks on a child inside the bubble still resolve the bubble, question, turn, and viewport', () => {
  const h = createHarness()
  h.dispatch('pointerdown', h.A.bubbleLabel, 1)
  h.dispatch('click', h.A.bubbleLabel, 1)

  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.A.viewport.scrollTop, 750)
  h.cleanup()
})

test('short reply sets the clearance variable before scrolling so the clamped target is reached', () => {
  const h = createHarness({ short: true })
  h.clickBubble('A')

  assert.equal(h.A.viewport.scrollTop, 450)
  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '152px')
  assert.equal(h.A.content.children.length, 2)
  assert.equal(h.A.content.querySelectorAll('[data-turn-start-spacer="true"]').length, 0)
  h.cleanup()
})

test('message.start clears the spacer on every clearance-owned viewport', () => {
  const h = createHarness({ short: true })
  h.clickBubble('A')
  assert.notEqual(h.A.viewport.style.getPropertyValue(EXTRA), '')

  h.emitMessageStart('A')
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  assert.equal(h.A.viewport.scrollTop, 450)
  h.cleanup()
})

test('switching sessions clears the spacer', () => {
  const h = createHarness({ short: true })
  h.clickBubble('A')
  assert.notEqual(h.A.viewport.style.getPropertyValue(EXTRA), '')

  h.setActive('B')
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  assert.equal(h.A.viewport.scrollTop, 450)
  h.cleanup()
})

test('clicking a tile viewport bubble writes only the tile viewport', () => {
  const h = createHarness()
  assert.equal(h.A.viewport.scrollTop, 700)
  assert.equal(h.T.viewport.scrollTop, 700)

  const events = h.clickBubble('T')

  assert.equal(events.click.defaultPrevented, true)
  assert.equal(h.T.viewport.scrollTop, 750)
  assert.equal(h.T.scrollWrites, 1)
  assert.equal(h.A.viewport.scrollTop, 700)
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('short tile clicks set the clearance variable only on the tile viewport', () => {
  const h = createHarness({ short: false })
  h.sessions.get('T').actualContentHeight = 700
  h.sessions.get('T').turnTop = 450
  h.sessions.get('T').turnBottom = 650
  h.sessions.get('T').viewport._scrollTop = 200
  h.clickBubble('T')

  assert.equal(h.T.viewport.style.getPropertyValue(EXTRA), '152px')
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('hot reload disposes the previous instance and installs a working new one', () => {
  const h = createHarness({ short: true })
  h.clickBubble('A')
  assert.notEqual(h.A.viewport.style.getPropertyValue(EXTRA), '')
  const firstStyle = h.styles()[0]
  assert.equal(h.documentListeners.get('pointerdown').size, 1)
  assert.equal(h.documentListeners.get('click').size, 1)
  assert.equal(h.streamListeners.size, 1)
  assert.equal(h.sessionSubscribers.size, 1)

  h.reload()

  const secondStyle = h.styles()[0]
  assert.notEqual(firstStyle, secondStyle)
  assert.equal(h.styles().length, 1)
  assert.equal(h.documentListeners.get('pointerdown').size, 1)
  assert.equal(h.documentListeners.get('click').size, 1)
  assert.equal(h.streamListeners.size, 1)
  assert.equal(h.sessionSubscribers.size, 1)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')

  const writesBeforeSecondClick = h.A.scrollWrites
  h.setRawScrollTop('A', 700)
  h.clickBubble('A')
  assert.equal(h.A.scrollWrites - writesBeforeSecondClick, 1)
  assert.equal(h.A.viewport.scrollTop, 450)

  h.cleanup()
  h.runAllTimers()
  assert.equal(h.styles().length, 0)
  assert.equal(h.documentListeners.get('pointerdown').size, 0)
  assert.equal(h.documentListeners.get('click').size, 0)
  assert.equal(h.streamListeners.size, 0)
  assert.equal(h.sessionSubscribers.size, 0)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
})

test('transient same-module remount reuses the deferred instance and final cleanup is exhaustive', () => {
  const h = createHarness()
  const firstStyle = h.styles()[0]

  h.cleanup()
  assert.equal(h.timers.size, 1)
  h.mount()
  assert.equal(h.timers.size, 0)
  assert.equal(h.styles().length, 1)
  assert.equal(h.styles()[0], firstStyle)
  assert.equal(h.documentListeners.get('pointerdown').size, 1)
  assert.equal(h.documentListeners.get('click').size, 1)
  assert.equal(h.streamListeners.size, 1)
  assert.equal(h.sessionSubscribers.size, 1)

  h.clickBubble('A')
  assert.equal(h.A.scrollWrites, 1)

  h.cleanup()
  h.runAllTimers()
  assert.equal(h.timers.size, 0)
  assert.equal(h.styles().length, 0)
  assert.equal(h.documentListeners.get('pointerdown').size, 0)
  assert.equal(h.documentListeners.get('click').size, 0)
  assert.equal(h.streamListeners.size, 0)
  assert.equal(h.sessionSubscribers.size, 0)
})

test('static source keeps the safe scroll surface and drops every auto-scroll mechanism', () => {
  assert.doesNotMatch(source, /scrollIntoView|window\.scroll(?:To|By)?|document\.scrollingElement/)
  assert.doesNotMatch(source, /document\.querySelector/)
  assert.doesNotMatch(source, /MutationObserver|message\.complete|session\.info/)
  assert.doesNotMatch(source, /DOM_QUIET_MS|MAX_SESSION_RECORDS|jumpIfReady|schedule\(|putRecord|deleteRecord|cancelRecordWork/)
  assert.match(source, /addEventListener\('pointerdown',[^\n]+, true\)/)
  assert.match(source, /addEventListener\('click',[^\n]+, true\)/)
  assert.match(source, /event\.detail\s*>=\s*2/)
  assert.match(source, /preventDefault\(\)/)
  assert.match(source, /stopPropagation\(\)/)
})

test('theme styles, clearance consumer, status copy, and plugin identity remain intact', () => {
  const h = createHarness()
  const css = h.styles()[0].textContent

  assert.match(css, /\[data-slot="aui_user-message-root"\]\[data-message-id\] \.composer-human-message/)
  assert.match(css, /color-mix\(in srgb,\s*var\(--ui-accent\)\s+20%,\s*var\(--dt-user-bubble\)\)/)
  assert.match(css, /var\(--ui-accent\)\s+32%,\s*var\(--ui-stroke-secondary\)/)
  assert.match(css, /outline:\s*1px solid color-mix\(in srgb,\s*var\(--ui-accent\)\s+18%,\s*var\(--ui-stroke-secondary\)\)/)
  assert.match(css, /outline-offset:\s*1px/)
  assert.match(css, /gap:\s*calc\(var\(--conversation-turn-gap\) \+ 0\.45rem\)/)
  assert.match(css, /margin-bottom:\s*0\.45rem/)
  assert.match(css, /\[data-session-anchor="workspace"\]\s+\[data-slot="aui_thread-viewport"\]/)
  assert.match(css, /--thread-last-message-clearance/)
  assert.match(css, /var\(--turn-start-extra-clearance,\s*0px\)/)

  assert.match(source, /点蓝条回本段 · 双击编辑/)
  assert.match(source, /单击问题条：回到这一轮开头；双击：编辑这条消息/)
  assert.match(source, /id:\s*'turn-start-navigator-v2'/)
  assert.match(source, /defaultEnabled:\s*true/)
  assert.doesNotMatch(source, /自动上移|回答结束后自动返回/)
  h.cleanup()
})
