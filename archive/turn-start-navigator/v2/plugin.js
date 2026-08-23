import { host } from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx } from 'react/jsx-runtime'

const WORKSPACE = '[data-session-anchor="workspace"]'
const VIEWPORT = '[data-slot="aui_thread-viewport"]'
const CONTENT = '[data-slot="aui_thread-content"]'
const QUESTION = '[data-slot="aui_user-message-root"]'
const TURN = '[data-slot="aui_turn-pair"]'
const STREAMING = '[data-slot="aui_assistant-message-root"][data-streaming="true"]'
const EXTRA_CLEARANCE = '--turn-start-extra-clearance'
const CLEARANCE_MARGIN = 2
const CLEARANCE_MAX_MARGIN = 32
const DOM_QUIET_MS = 650
// Pending, running, and consumed records share this small LRU-style bound.
const MAX_SESSION_RECORDS = 8
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

function workspaceViewport() {
  return document.querySelector(WORKSPACE)?.querySelector(VIEWPORT) ?? null
}

function latestQuestion(viewport) {
  return [...viewport.querySelectorAll(QUESTION)].at(-1) ?? null
}

function questionId(question) {
  return question?.getAttribute('data-message-id') ?? null
}

function scopedSessionId(event) {
  const sessionId = event.session_id
  if (typeof sessionId === 'string') return sessionId.trim() || null
  return sessionId ?? null
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

    const records = new Map()
    const viewportOwners = new WeakMap()
    const viewportQuestionIds = new WeakMap()
    const clearanceViewports = new Set()
    const disposers = []
    let disposed = false
    let deferredDisposeTimer = null
    let unscopedStreamOwner = null
    let activeSessionId = host.state.activeSessionId.get()

    const initialViewport = workspaceViewport()
    if (initialViewport && activeSessionId) {
      viewportOwners.set(initialViewport, activeSessionId)
      viewportQuestionIds.set(initialViewport, questionId(latestQuestion(initialViewport)))
    }

    const clearClearance = viewport => {
      if (!viewport || viewport.__turnStartClearanceOwner !== token) return
      viewport.style.removeProperty(EXTRA_CLEARANCE)
      delete viewport.__turnStartClearanceOwner
      clearanceViewports.delete(viewport)
    }

    const clearAllClearance = () => {
      for (const viewport of [...clearanceViewports]) clearClearance(viewport)
    }

    const cancelRecordWork = record => {
      if (!record) return
      if (record.timer !== null) {
        window.clearTimeout(record.timer)
        record.timer = null
      }
      clearClearance(record.clearanceViewport)
      record.clearanceViewport = null
    }

    const deleteRecord = sessionId => {
      const record = records.get(sessionId)
      cancelRecordWork(record)
      records.delete(sessionId)
    }

    const boundRecords = () => {
      while (records.size > MAX_SESSION_RECORDS) {
        deleteRecord(records.keys().next().value)
      }
    }

    const putRecord = (sessionId, record) => {
      records.delete(sessionId)
      records.set(sessionId, record)
      boundRecords()
      return record
    }

    const initialQuestion = initialViewport && latestQuestion(initialViewport)
    if (activeSessionId && initialViewport && initialQuestion && initialViewport.querySelector(STREAMING)) {
      putRecord(activeSessionId, {
        questionId: questionId(initialQuestion),
        pending: false,
        consumed: false,
        timer: null,
        clearanceViewport: null
      })
      unscopedStreamOwner = activeSessionId
    }

    const currentQuestionFor = sessionId => {
      const viewport = workspaceViewport()
      if (!viewport || viewportOwners.get(viewport) !== sessionId) return null
      const question = latestQuestion(viewport)
      viewportQuestionIds.set(viewport, questionId(question))
      return question
    }

    const jumpIfReady = (sessionId, record) => {
      if (disposed || !record.pending || activeSessionId !== sessionId) return false

      const viewport = workspaceViewport()
      if (!viewport) return false
      const question = latestQuestion(viewport)
      const currentQuestionId = questionId(question)
      let viewportOwner = viewportOwners.get(viewport)
      if (!viewportOwner) {
        viewportOwners.set(viewport, activeSessionId)
        viewportOwner = activeSessionId
      } else if (
        viewportOwner !== activeSessionId &&
        currentQuestionId &&
        currentQuestionId !== viewportQuestionIds.get(viewport)
      ) {
        // React may reuse the viewport element while replacing its transcript.
        viewportOwners.set(viewport, activeSessionId)
        viewportOwner = activeSessionId
      }
      if (viewportOwner !== sessionId || viewport.querySelector(STREAMING)) return false

      if (!question || !currentQuestionId) return false
      if (record.questionId && record.questionId !== currentQuestionId) return false
      if (!record.questionId) record.questionId = currentQuestionId
      viewportQuestionIds.set(viewport, currentQuestionId)

      const turn = question.closest(TURN)
      const content = viewport.querySelector(CONTENT)
      if (!turn || !content || !question.isConnected) return false

      const viewportRect = viewport.getBoundingClientRect()
      const turnRect = turn.getBoundingClientRect()
      const targetTop = Math.max(0, viewport.scrollTop + turnRect.top - viewportRect.top)
      const contentBottom = viewport.scrollTop + content.getBoundingClientRect().bottom - viewportRect.top
      const turnBottom = viewport.scrollTop + turnRect.bottom - viewportRect.top
      const trailingBottom = Math.max(contentBottom, turnBottom)
      const shortfall = targetTop + viewport.clientHeight - trailingBottom

      if (shortfall > 0) {
        viewport.style.setProperty(EXTRA_CLEARANCE, `${Math.min(
          Math.ceil(shortfall + CLEARANCE_MARGIN),
          viewport.clientHeight + CLEARANCE_MAX_MARGIN
        )}px`)
        viewport.__turnStartClearanceOwner = token
        clearanceViewports.add(viewport)
        record.clearanceViewport = viewport
      }

      record.pending = false
      record.consumed = true
      viewport.scrollTop = targetTop
      return true
    }

    const schedule = sessionId => {
      const record = records.get(sessionId)
      if (!record?.pending || record.consumed || activeSessionId !== sessionId) return
      if (record.timer !== null) window.clearTimeout(record.timer)
      record.timer = window.setTimeout(() => {
        record.timer = null
        jumpIfReady(sessionId, record)
      }, DOM_QUIET_MS)
    }

    const onStart = event => {
      const explicitSessionId = scopedSessionId(event)
      const sessionId = explicitSessionId ?? activeSessionId
      if (!sessionId) return
      if (!explicitSessionId) unscopedStreamOwner = sessionId
      deleteRecord(sessionId)
      const question = currentQuestionFor(sessionId)
      putRecord(sessionId, {
        questionId: questionId(question),
        pending: false,
        consumed: false,
        timer: null,
        clearanceViewport: null
      })
    }

    const onComplete = event => {
      const explicitSessionId = scopedSessionId(event)
      const sessionId = explicitSessionId ?? unscopedStreamOwner
      if (!sessionId) return
      let record = records.get(sessionId)
      if (!record) {
        const question = currentQuestionFor(sessionId)
        record = putRecord(sessionId, {
          questionId: questionId(question),
          pending: false,
          consumed: false,
          timer: null,
          clearanceViewport: null
        })
      }
      if (!record.consumed) {
        record.pending = true
        schedule(sessionId)
      }
      if (!explicitSessionId) unscopedStreamOwner = null
    }

    const onSessionInfo = event => {
      if (event.payload?.running !== false) return
      const sessionId = scopedSessionId(event) ?? unscopedStreamOwner
      if (!sessionId || !records.has(sessionId)) return
      onComplete(event)
    }

    const onError = event => {
      const explicitSessionId = scopedSessionId(event)
      const sessionId = explicitSessionId ?? unscopedStreamOwner
      if (sessionId) deleteRecord(sessionId)
      if (!explicitSessionId) unscopedStreamOwner = null
    }

    const onMutation = () => {
      if (activeSessionId) schedule(activeSessionId)
    }

    const observer = new MutationObserver(onMutation)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-streaming', 'data-message-id'],
      childList: true,
      subtree: true
    })

    disposers.push(host.onEvent('message.start', onStart))
    disposers.push(host.onEvent('message.complete', onComplete))
    disposers.push(host.onEvent('session.info', onSessionInfo))
    disposers.push(host.onEvent('error', onError))
    disposers.push(host.state.activeSessionId.subscribe(() => {
      clearAllClearance()
      const viewport = workspaceViewport()
      if (viewport) viewportQuestionIds.set(viewport, questionId(latestQuestion(viewport)))
      activeSessionId = host.state.activeSessionId.get()
      if (activeSessionId) schedule(activeSessionId)
    }))

    const cancelDeferredDispose = () => {
      if (deferredDisposeTimer === null) return
      window.clearTimeout(deferredDisposeTimer)
      deferredDisposeTimer = null
    }

    const dispose = () => {
      cancelDeferredDispose()
      if (disposed) return
      disposed = true
      observer.disconnect()
      for (const disposer of disposers) disposer()
      for (const sessionId of [...records.keys()]) deleteRecord(sessionId)
      clearAllClearance()
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
    title: '回答结束后自动返回本轮问答开头',
    style: { fontSize: '10px', opacity: 0.62, whiteSpace: 'nowrap' },
    children: '自动上移：已加载'
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