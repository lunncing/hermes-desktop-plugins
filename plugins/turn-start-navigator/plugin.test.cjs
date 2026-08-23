const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const pluginPath = path.join(__dirname, 'plugin.js')
const source = fs.readFileSync(pluginPath, 'utf8')

const STYLE_ID = 'turn-start-navigator-v2-style'
const EXTRA = '--turn-start-extra-clearance'

const DEFAULT_TURNS = [
  { top: 0, bottom: 200 },
  { top: 300, bottom: 500 },
  { top: 600, bottom: 800 }
]

const SHORT_TURNS = [
  { top: 450, bottom: 650 }
]

function createHarness({ short = false, withTile = true } = {}) {
  const timers = new Map()
  const cleanups = []
  const streamListeners = new Set()
  const sessionSubscribers = new Set()
  let nextTimerHandle = 1
  let activeSessionId = 'A'

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

    matchesComplex(selector) {
      const parts = selector.trim().split(/\s+/)
      if (parts.length === 0) return false
      if (!this.matches(parts[parts.length - 1])) return false

      let ancestor = this.parentElement
      for (let index = parts.length - 2; index >= 0; index--) {
        while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement
        if (!ancestor) return false
        ancestor = ancestor.parentElement
      }
      return true
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
        if (child.matchesComplex(selector)) result.push(child)
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
  function makeSurface(sessionId, options = {}) {
    const isShort = options.short ?? (sessionId === 'A' && short)
    const turnSpecs = options.turns ?? (isShort ? SHORT_TURNS : DEFAULT_TURNS)
    const actualContentHeight = options.contentHeight ?? (isShort ? 700 : 1200)
    const initialScrollTop = options.scrollTop ?? (isShort ? 200 : 0)

    const viewport = new Element(`${sessionId}-viewport`, {
      'data-slot': 'aui_thread-viewport',
      'data-following': 'false'
    })
    const content = new Element(`${sessionId}-content`, { 'data-slot': 'aui_thread-content' })

    const turnData = turnSpecs.map((spec, index) => {
      const turn = new Element(`${sessionId}-turn-${index}`, { 'data-slot': 'aui_turn-pair' })
      const question = new Element(`${sessionId}-question-${index}`, {
        'data-slot': 'aui_user-message-root',
        'data-message-id': `${sessionId}-q${index}`
      })
      const bubble = new Element('button', {}, ['composer-human-message'])
      const bubbleLabel = new Element('span', {}, ['composer-human-message-label'])
      const assistant = new Element(`${sessionId}-assistant-${index}`, {
        'data-slot': 'aui_assistant-message-root',
        'data-streaming': 'true'
      })
      bubble.appendChild(bubbleLabel)
      question.appendChild(bubble)
      turn.appendChild(question)
      turn.appendChild(assistant)
      content.appendChild(turn)

      return {
        turn,
        question,
        bubble,
        bubbleLabel,
        assistant,
        top: spec.top,
        bottom: spec.bottom
      }
    })

    const clearance = new Element(`${sessionId}-clearance`, { 'data-slot': 'aui_composer-clearance' })
    content.appendChild(clearance)
    viewport.appendChild(content)

    const data = {
      sessionId,
      viewport,
      content,
      clearance,
      turns: turnData.map(entry => entry.turn),
      questions: turnData.map(entry => entry.question),
      bubbles: turnData.map(entry => entry.bubble),
      bubbleLabels: turnData.map(entry => entry.bubbleLabel),
      assistants: turnData.map(entry => entry.assistant),
      turnTops: turnSpecs.map(spec => spec.top),
      turnBottoms: turnSpecs.map(spec => spec.bottom),
      actualContentHeight,
      scrollWrites: 0
    }
    viewport.clientHeight = 400
    viewport._scrollTop = initialScrollTop
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
    for (let index = 0; index < turnData.length; index++) {
      const entry = turnData[index]
      entry.turn.getBoundingClientRect = () => ({
        top: 100 + entry.top - viewport.scrollTop,
        bottom: 100 + entry.bottom - viewport.scrollTop,
        width: 600,
        height: entry.bottom - entry.top
      })
    }
    sessions.set(sessionId, data)
    return data
  }

  const A = makeSurface('A')
  const B = makeSurface('B')
  const T = makeSurface('T')
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

  function dispatch(type, target, options = {}) {
    const { detail = 1, button = 0, ctrlKey = false, metaKey = false } = options
    const event = {
      type,
      target,
      detail,
      button,
      ctrlKey,
      metaKey,
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

  function middleBubble(sessionId, turnIndex, options = {}) {
    const data = sessions.get(sessionId)
    const target = options.target ?? data.bubbles[turnIndex]
    return dispatch('mousedown', target, { button: 1, ...options })
  }

  function ctrlMiddle(sessionId, target = null) {
    const data = sessions.get(sessionId)
    return dispatch('mousedown', target ?? data.viewport, { button: 1, ctrlKey: true })
  }

  const window = {
    setTimeout(callback) { const id = nextTimerHandle++; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) }
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
    middleBubble,
    ctrlMiddle,
    emitMessageStart,
    runAllTimers,
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

test('middle mousedown on a user bubble scrolls its turn start to the thread viewport top', () => {
  const h = createHarness()
  assert.equal(h.A.viewport.scrollTop, 0)
  assert.equal(h.A.scrollWrites, 0)

  const event = h.middleBubble('A', 2)

  assert.equal(event.button, 1)
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(h.A.viewport.scrollTop, 600)
  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  h.cleanup()
})

test('middle mousedown on a child inside the bubble resolves the same jump target', () => {
  const h = createHarness()
  const event = h.middleBubble('A', 2, { target: h.A.bubbleLabels[2] })

  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(h.A.viewport.scrollTop, 600)
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('a second middle mousedown on the same bubble retreats to the previous turn', () => {
  const h = createHarness()

  const first = h.middleBubble('A', 2)
  assert.equal(first.defaultPrevented, true)
  assert.equal(h.A.viewport.scrollTop, 600)

  const second = h.middleBubble('A', 2)
  assert.equal(second.defaultPrevented, true)
  assert.equal(second.propagationStopped, true)
  assert.equal(h.A.viewport.scrollTop, 300)
  assert.equal(h.A.scrollWrites, 2)
  h.cleanup()
})

test('middle mousedown on a different bubble resets the retreat counter', () => {
  const h = createHarness()

  h.middleBubble('A', 2)
  assert.equal(h.A.viewport.scrollTop, 600)

  const event = h.middleBubble('A', 1)
  assert.equal(event.defaultPrevented, true)
  assert.equal(h.A.viewport.scrollTop, 300)
  assert.equal(h.A.scrollWrites, 2)
  h.cleanup()
})

test('repeated retreat clamps at the earliest turn instead of going negative', () => {
  const h = createHarness()
  const expected = [600, 300, 0, 0, 0]

  for (const top of expected) {
    h.middleBubble('A', 2)
    assert.equal(h.A.viewport.scrollTop, top)
  }
  assert.equal(h.A.scrollWrites, expected.length)
  h.cleanup()
})

test('Ctrl+middle mousedown jumps to the bottom, clears the spacer, and falls back to the workspace viewport', () => {
  const h = createHarness({ short: true })

  h.middleBubble('A', 0)
  assert.equal(h.A.viewport.scrollTop, 450)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '152px')

  const event = h.dispatch('mousedown', h.body, { button: 1, ctrlKey: true })

  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  assert.equal(h.A.viewport.scrollTop, 300)
  assert.equal(h.A.scrollWrites, 2)
  h.cleanup()
})

test('metaKey is accepted as the Mac equivalent of Ctrl+middle', () => {
  const h = createHarness()

  const event = h.dispatch('mousedown', h.A.assistants[2], { button: 1, metaKey: true })

  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(h.A.viewport.scrollTop, 800)
  assert.equal(h.A.scrollWrites, 1)
  h.cleanup()
})

test('left mousedown and click are never intercepted', () => {
  const h = createHarness()

  const mouseDown = h.dispatch('mousedown', h.A.bubbles[2], { button: 0 })
  const click = h.dispatch('click', h.A.bubbles[2], { button: 0 })
  const rightMouseDown = h.dispatch('mousedown', h.A.bubbles[2], { button: 2 })

  assert.equal(mouseDown.defaultPrevented, false)
  assert.equal(mouseDown.propagationStopped, false)
  assert.equal(click.defaultPrevented, false)
  assert.equal(click.propagationStopped, false)
  assert.equal(rightMouseDown.defaultPrevented, false)
  assert.equal(rightMouseDown.propagationStopped, false)
  assert.equal(h.A.scrollWrites, 0)
  assert.equal(h.documentListeners.has('pointerdown'), false)
  assert.equal(h.documentListeners.has('click'), false)
  h.cleanup()
})

test('Ctrl+middle on a bubble goes to the bottom without advancing the retreat counter', () => {
  const h = createHarness()

  h.middleBubble('A', 2)
  assert.equal(h.A.viewport.scrollTop, 600)

  const ctrl = h.dispatch('mousedown', h.A.bubbles[2], { button: 1, ctrlKey: true })
  assert.equal(ctrl.defaultPrevented, true)
  assert.equal(h.A.viewport.scrollTop, 800)

  const next = h.middleBubble('A', 2)
  assert.equal(next.defaultPrevented, true)
  assert.equal(h.A.viewport.scrollTop, 300)
  h.cleanup()
})

test('non-bubble middle mousedown without Ctrl propagates untouched', () => {
  const h = createHarness()

  for (const target of [h.A.assistants[2], h.A.content, h.A.turns[2]]) {
    const event = h.dispatch('mousedown', target, { button: 1 })
    assert.equal(event.defaultPrevented, false)
    assert.equal(event.propagationStopped, false)
  }
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('short replies set the clearance variable before scrolling so the clamped target is reached', () => {
  const h = createHarness({ short: true })
  const event = h.middleBubble('A', 0)

  assert.equal(event.defaultPrevented, true)
  assert.equal(h.A.viewport.scrollTop, 450)
  assert.equal(h.A.scrollWrites, 1)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '152px')
  assert.equal(h.A.content.querySelectorAll('[data-turn-start-spacer="true"]').length, 0)
  h.cleanup()
})

test('message.start clears the spacer without moving the viewport', () => {
  const h = createHarness({ short: true })
  h.middleBubble('A', 0)
  assert.notEqual(h.A.viewport.style.getPropertyValue(EXTRA), '')

  h.emitMessageStart('A')
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  assert.equal(h.A.viewport.scrollTop, 450)
  h.cleanup()
})

test('switching sessions clears the spacer', () => {
  const h = createHarness({ short: true })
  h.middleBubble('A', 0)
  assert.notEqual(h.A.viewport.style.getPropertyValue(EXTRA), '')

  h.setActive('B')
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')
  assert.equal(h.A.viewport.scrollTop, 450)
  h.cleanup()
})

test('middle mousedown on a tile viewport bubble writes only the tile viewport', () => {
  const h = createHarness()
  assert.equal(h.A.viewport.scrollTop, 0)
  assert.equal(h.T.viewport.scrollTop, 0)

  const event = h.middleBubble('T', 2)

  assert.equal(event.defaultPrevented, true)
  assert.equal(h.T.viewport.scrollTop, 600)
  assert.equal(h.T.scrollWrites, 1)
  assert.equal(h.A.viewport.scrollTop, 0)
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('Ctrl+middle mousedown inside the tile writes only the tile viewport', () => {
  const h = createHarness()
  const event = h.ctrlMiddle('T')

  assert.equal(event.defaultPrevented, true)
  assert.equal(h.T.viewport.scrollTop, 800)
  assert.equal(h.T.scrollWrites, 1)
  assert.equal(h.A.viewport.scrollTop, 0)
  assert.equal(h.A.scrollWrites, 0)
  h.cleanup()
})

test('hot reload disposes the previous instance and installs a working replacement', () => {
  const h = createHarness({ short: true })
  h.middleBubble('A', 0)
  assert.notEqual(h.A.viewport.style.getPropertyValue(EXTRA), '')
  const firstStyle = h.styles()[0]
  assert.equal(h.documentListeners.get('mousedown').size, 1)
  assert.equal(h.documentListeners.has('pointerdown'), false)
  assert.equal(h.documentListeners.has('click'), false)
  assert.equal(h.streamListeners.size, 1)
  assert.equal(h.sessionSubscribers.size, 1)

  h.reload()

  const secondStyle = h.styles()[0]
  assert.notEqual(firstStyle, secondStyle)
  assert.equal(h.styles().length, 1)
  assert.equal(h.documentListeners.get('mousedown').size, 1)
  assert.equal(h.documentListeners.has('pointerdown'), false)
  assert.equal(h.documentListeners.has('click'), false)
  assert.equal(h.streamListeners.size, 1)
  assert.equal(h.sessionSubscribers.size, 1)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '')

  const writesBeforeSecondClick = h.A.scrollWrites
  h.setRawScrollTop('A', 200)
  h.middleBubble('A', 0)
  assert.equal(h.A.scrollWrites - writesBeforeSecondClick, 1)
  assert.equal(h.A.viewport.scrollTop, 450)
  assert.equal(h.A.viewport.style.getPropertyValue(EXTRA), '152px')

  h.cleanup()
  h.runAllTimers()
  assert.equal(h.styles().length, 0)
  assert.equal(h.documentListeners.get('mousedown').size, 0)
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
  assert.equal(h.documentListeners.get('mousedown').size, 1)
  assert.equal(h.streamListeners.size, 1)
  assert.equal(h.sessionSubscribers.size, 1)

  h.middleBubble('A', 2)
  assert.equal(h.A.viewport.scrollTop, 600)
  assert.equal(h.A.scrollWrites, 1)

  h.cleanup()
  h.runAllTimers()
  assert.equal(h.timers.size, 0)
  assert.equal(h.styles().length, 0)
  assert.equal(h.documentListeners.get('mousedown').size, 0)
  assert.equal(h.streamListeners.size, 0)
  assert.equal(h.sessionSubscribers.size, 0)
})

test('static source keeps the middle-button surface and drops every left-click interception path', () => {
  assert.doesNotMatch(source, /scrollIntoView|window\.scroll(?:To|By)?|document\.scrollingElement/)
  assert.doesNotMatch(source, /addEventListener\('pointerdown'|addEventListener\('click'/)
  assert.match(source, /addEventListener\('mousedown',[^\n]+, true\)/)
  assert.match(source, /button\s*===\s*1/)
  assert.match(source, /document\.querySelector\(WORKSPACE_VIEWPORT\)/)
  assert.match(source, /event\.ctrlKey\s*\|\|\s*event\.metaKey/)
  assert.doesNotMatch(source, /event\.detail\s*>=\s*2|DOUBLE_HIT|hasTextSelection/)
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

  assert.match(source, /中键跳转 · Ctrl\+中键回底部/)
  assert.match(source, /中键点击问题条：跳到该轮开头（再按递退）；Ctrl\+中键：回到底部/)
  assert.match(source, /id:\s*'turn-start-navigator-v2'/)
  assert.match(source, /defaultEnabled:\s*true/)
  assert.doesNotMatch(source, /单击|双击|点蓝条回本段|自动上移|回答结束后自动返回/)
  h.cleanup()
})
