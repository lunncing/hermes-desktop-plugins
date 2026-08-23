import { host } from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx } from 'react/jsx-runtime'

const VIEWPORT = '[data-slot="aui_thread-viewport"]'
const CONTENT = '[data-slot="aui_thread-content"]'
const QUESTION = '[data-slot="aui_user-message-root"]'
const TURN = '[data-slot="aui_turn-pair"]'
const BUBBLE = 'button.composer-human-message'

const EXTRA_CLEARANCE = '--turn-start-extra-clearance'
const CLEARANCE_MARGIN = 2
const CLEARANCE_MAX_MARGIN = 32
const DOUBLE_HIT_WINDOW_MS = 400

const STYLE_ID = 'turn-start-navigator-v2-style'
const INSTANCE_KEY = Symbol.for('turn-start-navigator-v2.instance')
const MODULE_TOKEN = {}

const NAVIGATOR_STYLE = `
  [data-slot="aui_user-message-root"][data-message-id] .composer-human-message {
    background: color-mix(in srgb, var(--ui-accent) 20%, var(--dt-user-bubble)) !important;
    border-color: color-mix(in srgb, var(--ui-accent) 32%, var(--ui-stroke-secondary)) !important;
    outline: 1px solid color-mix(in srgb, var(--ui-accent) 18%, var(--ui-stroke-secondary));
    outline-offset: 1px;
  }

  [data-slot="aui_user-message-root"][data-message-id] .composer-human-message:hover,
  [data-slot="aui_user-message-root"][data-message-id] .composer-human-message:focus-visible {
    background: color-mix(in srgb, var(--ui-accent) 22%, var(--dt-user-bubble)) !important;
    border-color: color-mix(in srgb, var(--ui-accent) 40%, var(--ui-stroke-secondary)) !important;
  }

  [data-slot="aui_turn-pair"] {
    gap: calc(var(--conversation-turn-gap) + 0.45rem);
  }

  [data-slot="aui_thread-content"] > div:has(> [data-slot="aui_turn-pair"]) {
    margin-bottom: 0.45rem;
  }

  [data-session-anchor="workspace"] [data-slot="aui_thread-viewport"]
    [data-slot="aui_composer-clearance"] {
    height: calc(
      var(--thread-last-message-clearance) +
      var(--turn-start-extra-clearance, 0px)
    ) !important;
  }
`

function hasTextSelection() {
  const selection = window.getSelection?.()
  if (!selection) return false
  if (typeof selection.isCollapsed === 'boolean') return !selection.isCollapsed
  return String(selection).length > 0
}

function createHitMeter() {
  let lastStrike = { questionId: null, time: -Infinity }
  let pendingPointerDown = null

  return (event, questionId) => {
    const now = Date.now()

    // A new pointerdown closes the previous pointerdown-only strike (for example
    // a drag that never produced a click) before this strike is measured.
    if (event.type === 'pointerdown' && pendingPointerDown) {
      lastStrike = pendingPointerDown
      pendingPointerDown = null
    }

    const secondHit =
      event.detail >= 2 &&
      questionId !== null &&
      questionId === lastStrike.questionId &&
      now - lastStrike.time <= DOUBLE_HIT_WINDOW_MS

    // For a normal pointerdown -> click pair, the click is measured against the
    // strike that preceded its own pointerdown, never against itself.
    if (event.type === 'pointerdown') {
      pendingPointerDown = { questionId, time: now }
    } else if (event.type === 'click') {
      lastStrike = { questionId, time: now }
      pendingPointerDown = null
    }
    return secondHit
  }
}

function createNavigator(disposeToken) {
  const measureHit = createHitMeter()
  const clearanceViewports = new Set()
  let disposed = false

  const clearClearance = viewport => {
    if (!viewport || viewport.__turnStartClearanceOwner !== disposeToken) return
    viewport.style.removeProperty(EXTRA_CLEARANCE)
    delete viewport.__turnStartClearanceOwner
    clearanceViewports.delete(viewport)
  }

  const clearAllClearance = () => {
    for (const viewport of [...clearanceViewports]) clearClearance(viewport)
  }

  const jumpToTurn = (viewport, bubble) => {
    if (!viewport || !bubble || disposed) return
    const question = bubble.closest(QUESTION)
    const turn = question?.closest(TURN)
    if (!turn || !turn.isConnected) return

    const viewportRect = viewport.getBoundingClientRect()
    const turnRect = turn.getBoundingClientRect()
    const targetTop = Math.max(0, viewport.scrollTop + turnRect.top - viewportRect.top)

    const content = viewport.querySelector(CONTENT)
    const turnBottom = viewport.scrollTop + turnRect.bottom - viewportRect.top
    const contentBottom = content
      ? viewport.scrollTop + content.getBoundingClientRect().bottom - viewportRect.top
      : turnBottom
    const trailingBottom = Math.max(contentBottom, turnBottom)
    const shortfall = targetTop + viewport.clientHeight - trailingBottom

    if (shortfall > 0) {
      viewport.style.setProperty(
        EXTRA_CLEARANCE,
        `${Math.min(Math.ceil(shortfall + CLEARANCE_MARGIN), viewport.clientHeight + CLEARANCE_MAX_MARGIN)}px`
      )
      viewport.__turnStartClearanceOwner = disposeToken
      clearanceViewports.add(viewport)
    }

    viewport.scrollTop = targetTop
  }

  const classifyGesture = event => {
    if (disposed || !event?.target || typeof event.target.closest !== 'function') return 'pass'

    const bubble = event.target.closest(BUBBLE)
    const question = bubble?.closest(QUESTION)
    const viewport = bubble?.closest(VIEWPORT)
    if (!bubble || !question || !viewport) return 'pass'
    if (hasTextSelection()) return 'pass'

    const questionId = question.getAttribute('data-message-id')
    if (measureHit(event, questionId)) return 'pass'

    return 'jump'
  }

  let pointerDownWithSelection = null

  const onPointerDown = event => {
    const bubble = event.target?.closest?.(BUBBLE)
    pointerDownWithSelection =
      bubble?.closest(QUESTION) && bubble.closest(VIEWPORT) && hasTextSelection() ? bubble : null

    if (classifyGesture(event) === 'pass') return
    event.stopPropagation()
  }

  const onClick = event => {
    const bubble = event.target?.closest?.(BUBBLE)
    const selectionSeenAtPointerDown = pointerDownWithSelection === bubble
    pointerDownWithSelection = null
    if (selectionSeenAtPointerDown) return
    if (classifyGesture(event) === 'pass') return

    event.preventDefault()
    event.stopPropagation()
    if (bubble) jumpToTurn(bubble.closest(VIEWPORT), bubble)
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)

  const onStreamStart = () => clearAllClearance()
  const onSessionChange = () => clearAllClearance()
  const disposeStreamStart = host.onEvent('message.start', onStreamStart)
  const disposeSessionChange = host.state.activeSessionId.subscribe(onSessionChange)

  return {
    clearAllClearance,
    dispose() {
      if (disposed) return
      disposed = true
      clearAllClearance()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
      disposeStreamStart()
      disposeSessionChange()
    }
  }
}

function TurnStartNavigator() {
  useEffect(() => {
    const previousInstance = globalThis[INSTANCE_KEY]
    if (previousInstance?.moduleToken === MODULE_TOKEN) {
      previousInstance.cancelDeferredDispose()
      return previousInstance.deferDispose
    }
    previousInstance?.dispose()

    const token = {}

    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = NAVIGATOR_STYLE
    document.getElementById(STYLE_ID)?.remove()
    document.head.appendChild(style)

    const navigator = createNavigator(token)

    let disposed = false
    let deferredDisposeTimer = null

    const cancelDeferredDispose = () => {
      if (deferredDisposeTimer === null) return
      window.clearTimeout(deferredDisposeTimer)
      deferredDisposeTimer = null
    }

    const dispose = () => {
      cancelDeferredDispose()
      if (disposed) return
      disposed = true
      navigator.dispose()
      if (style.isConnected) style.remove()
      if (globalThis[INSTANCE_KEY]?.token === token) delete globalThis[INSTANCE_KEY]
    }

    const deferDispose = () => {
      if (disposed || deferredDisposeTimer !== null) return
      deferredDisposeTimer = window.setTimeout(() => {
        deferredDisposeTimer = null
        dispose()
      }, 0)
    }

    const instance = {
      moduleToken: MODULE_TOKEN,
      token,
      cancelDeferredDispose,
      deferDispose,
      dispose
    }
    globalThis[INSTANCE_KEY] = instance

    return deferDispose
  }, [])

  return jsx('span', {
    title: '单击问题条：回到这一轮开头；双击：编辑这条消息',
    style: { fontSize: '10px', opacity: 0.62, whiteSpace: 'nowrap' },
    children: '点蓝条回本段 · 双击编辑'
  })
}

export default {
  id: 'turn-start-navigator-v2',
  name: 'Turn start navigator v2',
  defaultEnabled: true,
  register(ctx) {
    ctx.register({
      id: 'turn-start-navigator-status',
      area: 'statusBar.right',
      render: () => jsx(TurnStartNavigator, {})
    })
  }
}
