import { host } from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx } from 'react/jsx-runtime'

const VIEWPORT = '[data-slot="aui_thread-viewport"]'
const CONTENT = '[data-slot="aui_thread-content"]'
const QUESTION = '[data-slot="aui_user-message-root"]'
const TURN = '[data-slot="aui_turn-pair"]'
const BUBBLE = 'button.composer-human-message'
const WORKSPACE_VIEWPORT = '[data-session-anchor="workspace"] [data-slot="aui_thread-viewport"]'

const EXTRA_CLEARANCE = '--turn-start-extra-clearance'
const CLEARANCE_MARGIN = 2
const CLEARANCE_MAX_MARGIN = 32

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

function createNavigator(disposeToken) {
  const hitState = { lastQuestionId: null, depth: 0 }
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

  const jumpToTurn = (viewport, bubble, depth) => {
    if (!viewport || !bubble || disposed) return
    const question = bubble.closest(QUESTION)
    const ownTurn = question?.closest(TURN)
    if (!question || !ownTurn || !ownTurn.isConnected) return

    const turns = Array.from(viewport.querySelectorAll(TURN))
    const ownIndex = turns.indexOf(ownTurn)
    if (ownIndex < 0) return

    const targetIndex = Math.max(0, ownIndex - depth)
    const turn = turns[targetIndex] ?? ownTurn
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

  const onMouseDown = event => {
    if (disposed || !event) return
    const isMiddleButton = event.button === 1
    if (!isMiddleButton) return

    const target = event.target
    const canClosest = target && typeof target.closest === 'function'

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      event.stopPropagation()

      let viewport = canClosest ? target.closest(VIEWPORT) : null
      if (!viewport) viewport = document.querySelector(WORKSPACE_VIEWPORT)
      if (!viewport) return

      clearClearance(viewport)
      viewport.scrollTop = viewport.scrollHeight
      return
    }

    if (!canClosest) return

    const bubble = target.closest(BUBBLE)
    if (!bubble) return
    const question = bubble.closest(QUESTION)
    const viewport = bubble.closest(VIEWPORT)
    if (!question || !viewport) return

    const questionId = question.getAttribute('data-message-id')
    if (questionId === null) return

    if (hitState.lastQuestionId === questionId) {
      hitState.depth += 1
    } else {
      hitState.lastQuestionId = questionId
      hitState.depth = 0
    }

    event.preventDefault()
    event.stopPropagation()
    jumpToTurn(viewport, bubble, hitState.depth)
  }

  document.addEventListener('mousedown', onMouseDown, true)

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
      document.removeEventListener('mousedown', onMouseDown, true)
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
    title: '中键点击问题条：跳到该轮开头（再按递退）；Ctrl+中键：回到底部',
    className: 'inline-flex h-full items-center whitespace-nowrap px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
    style: { opacity: 0.62 },
    children: '中键跳转 · Ctrl+中键回底部'
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
