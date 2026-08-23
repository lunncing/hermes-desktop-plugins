import {
  Badge,
  Button,
  Codicon,
  EmptyState,
  ErrorState,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  SearchField,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
  host,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-trace-viewer'
export const TRACE_ADAPTER_VERSION = 1
const MAX_MESSAGES = 500
const MAX_SESSIONS = 100
const MAX_LIVE_EVENTS = 1000
const MAX_PREVIEW_CHARS = 2000
const MAX_RAW_CHARS = 100000
const RELAY_KEY = Symbol.for('hermes-trace-viewer.event-relay')

// Critical geometry is applied through inline styles because runtime plugins are
// loaded after Desktop has been built; Tailwind never scans this file, so
// arbitrary-value height and grid-template utilities are not guaranteed to
// exist in the packaged stylesheet. V4 extends this rule to full containment:
// each critical panel shell is an inline flex column with a bounded contract
// height and overflow hidden, and its scrolling body is a plain div with
// explicit inline overflow, so long content can never paint past the border.
export const TRACE_LAYOUT = Object.freeze({
  traceRowGrid: 'auto minmax(0, 1fr) auto',
  summaryRowGrid: '7rem minmax(0, 1fr)',
  wideSplitGrid: 'minmax(0, 1fr) 22rem',
  narrowSplitGrid: 'minmax(0, 1fr)',
  traceListHeight: 'min(42rem, 55vh)',
  traceListMinHeight: '12rem',
  detailHeight: 'min(34rem, 48vh)',
  detailMinHeight: '10rem'
})

export function splitGridColumns(wide) {
  return wide ? TRACE_LAYOUT.wideSplitGrid : TRACE_LAYOUT.narrowSplitGrid
}

const PANEL_BODY_STYLE = Object.freeze({
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  overflowX: 'hidden'
})

function panelShellStyle(height, minHeight) {
  return {
    display: 'flex',
    flexDirection: 'column',
    height,
    minHeight,
    minWidth: 0,
    overflow: 'hidden'
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textFrom(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === 'string') return part
        const row = asRecord(part)
        return textFrom(row.text ?? row.content ?? '')
      })
      .filter(Boolean)
      .join('\n')
  }
  const row = asRecord(value)
  return textFrom(row.text ?? row.content ?? '')
}

function boundedText(value, limit = MAX_PREVIEW_CHARS) {
  const text = textFrom(value).trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function secretKey(key) {
  return /^(?:api[_-]?key|token|authorization|password|secret|cookie)$/i.test(key)
}

function sanitizeSecretText(value) {
  const text = String(value ?? '')
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const sanitized = JSON.stringify(redactSecrets(JSON.parse(trimmed)))
      if (typeof sanitized === 'string') return sanitized
    } catch {
      // Malformed JSON-shaped text is sanitized by the bounded key/value fallback below.
    }
  }

  return text.replace(
    /((?:^|[\s,;{])["']?(?:api[_-]?key|token|authorization|password|secret|cookie)["']?\s*[:=]\s*)(Bearer\s+)?("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}\]]+)/gim,
    (match, prefix, bearer = '', secretValue) => {
      const quote = secretValue[0] === '"' || secretValue[0] === "'" ? secretValue[0] : ''
      return `${prefix}${bearer}${quote}[REDACTED]${quote}`
    }
  )
}

export function redactSecrets(value, seen = new WeakMap()) {
  if (typeof value === 'string') return sanitizeSecretText(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const result = []
    seen.set(value, result)
    try {
      for (const item of value) result.push(redactSecrets(item, seen))
    } catch {
      return result
    }
    return result
  }

  const result = {}
  seen.set(value, result)
  try {
    for (const [key, child] of Object.entries(value)) {
      result[key] = secretKey(key) ? '[REDACTED]' : redactSecrets(child, seen)
    }
  } catch {
    return result
  }
  return result
}

export function safeRaw(value) {
  let text
  try {
    text = JSON.stringify(redactSecrets(value), null, 2)
  } catch {
    text = '"[Unserializable data]"'
  }
  const normalized = typeof text === 'string' ? text : String(text ?? '')
  return normalized.length > MAX_RAW_CHARS ? `${normalized.slice(0, MAX_RAW_CHARS - 1)}…` : normalized
}

export function safePreview(value) {
  if (typeof value === 'string') return boundedText(redactSecrets(value))
  return boundedText(safeRaw(value))
}

function finiteTimestamp(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

function baseNode({ id, lane, message, parentId = null, preview, raw, sessionId, title, turn, type, metadata = {} }) {
  const timestamp = finiteTimestamp(message.timestamp ?? message.created_at ?? message.createdAt)
  return {
    id,
    sessionId,
    turn,
    type,
    lane,
    status: 'complete',
    timestamp,
    startedAt: timestamp,
    endedAt: null,
    durationMs: null,
    timingQuality: 'point-in-time',
    source: 'persisted-session-message',
    sourcePath: 'session.messages',
    title,
    preview: boundedText(preview),
    raw,
    parentId,
    metadata
  }
}

function normalizeToolCall(callValue, message, sessionId, turn, messageKey, callIndex) {
  const call = asRecord(callValue)
  const fn = asRecord(call.function)
  const toolName = String(call.name ?? call.tool_name ?? fn.name ?? 'tool')
  const callId = String(call.id ?? call.call_id ?? call.tool_call_id ?? `${messageKey}:call:${callIndex}`)
  const args = call.arguments ?? call.args ?? fn.arguments ?? fn.args ?? ''
  return baseNode({
    id: `${messageKey}:tool-call:${callIndex}`,
    lane: 'Tools',
    message,
    parentId: messageKey,
    preview: args,
    raw: callValue,
    sessionId,
    title: 'TOOL',
    turn,
    type: 'TOOL',
    metadata: { toolName, callId, phase: 'call' }
  })
}

export function normalizeMessages(messagesValue, sessionId = '') {
  const messages = Array.isArray(messagesValue) ? messagesValue.slice(-MAX_MESSAGES) : []
  const nodes = []
  let turn = 0

  messages.forEach((messageValue, messageIndex) => {
    const message = asRecord(messageValue)
    const role = String(message.role ?? '').toLowerCase()
    const messageKey = String(message.id ?? message.row_id ?? `${sessionId || 'session'}:${messageIndex}`)
    if (role === 'user') turn += 1

    if (role === 'system' || role === 'user' || role === 'assistant') {
      const type = role.toUpperCase()
      const lane = role === 'assistant' ? 'Model' : 'Input'
      nodes.push(
        baseNode({
          id: messageKey,
          lane,
          message,
          preview: message.content ?? message.text ?? '',
          raw: messageValue,
          sessionId,
          title: type,
          turn,
          type
        })
      )
    }

    if (role === 'assistant') {
      const reasoning = message.reasoning_content ?? message.reasoning
      if (boundedText(reasoning)) {
        nodes.push(
          baseNode({
            id: `${messageKey}:reasoning`,
            lane: 'Model',
            message,
            parentId: messageKey,
            preview: reasoning,
            raw: { reasoning },
            sessionId,
            title: 'REASONING',
            turn,
            type: 'REASONING'
          })
        )
      }

      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      calls.forEach((call, callIndex) => {
        nodes.push(normalizeToolCall(call, message, sessionId, turn, messageKey, callIndex))
      })
    }

    if (role === 'tool') {
      const toolName = String(message.name ?? message.tool_name ?? 'tool')
      const callId = String(message.tool_call_id ?? message.call_id ?? '')
      nodes.push(
        baseNode({
          id: `${messageKey}:tool-result`,
          lane: 'Tools',
          message,
          parentId: callId || null,
          preview: message.content ?? message.text ?? '',
          raw: messageValue,
          sessionId,
          title: 'TOOL',
          turn,
          type: 'TOOL',
          metadata: { toolName, callId, phase: 'result' }
        })
      )
    }
  })

  return nodes
}

export function filterNodes(nodesValue, queryValue = '', laneValue = 'All') {
  const nodes = Array.isArray(nodesValue) ? nodesValue : []
  const query = String(queryValue ?? '').trim().toLocaleLowerCase()
  const lane = String(laneValue ?? 'All').toLocaleLowerCase()

  return nodes.filter(nodeValue => {
    const node = asRecord(nodeValue)
    if (lane !== 'all' && String(node.lane ?? '').toLocaleLowerCase() !== lane) return false
    if (!query) return true
    const metadata = asRecord(node.metadata)
    const searchable = [
      node.type,
      node.title,
      node.preview,
      metadata.toolName,
      node.source,
      safeRaw(node.raw)
    ]
      .map(value => String(value ?? '').toLocaleLowerCase())
      .join('\n')
    return searchable.includes(query)
  })
}

export function timelineGeometry(nodesValue) {
  const nodes = Array.isArray(nodesValue) ? nodesValue : []
  const widthPct = 2
  const maximumLeft = 100 - widthPct
  const valid = nodes
    .map(node => finiteTimestamp(asRecord(node).timestamp))
    .filter(timestamp => timestamp !== null)
  const minimum = valid.length ? Math.min(...valid) : 0
  const maximum = valid.length ? Math.max(...valid) : minimum
  const span = maximum - minimum

  return nodes.map((nodeValue, index) => {
    const node = asRecord(nodeValue)
    const timestamp = finiteTimestamp(node.timestamp)
    const fallback = nodes.length <= 1 ? 0 : (index / (nodes.length - 1)) * maximumLeft
    const scaled = timestamp === null || span <= 0 ? fallback : ((timestamp - minimum) / span) * maximumLeft
    const leftPct = Math.min(maximumLeft, Math.max(0, Number.isFinite(scaled) ? scaled : fallback))
    return { id: String(node.id ?? index), leftPct, widthPct }
  })
}

export function boundSessions(sessionsValue) {
  return Array.isArray(sessionsValue) ? sessionsValue.slice(0, MAX_SESSIONS) : []
}

export function createLiveEventBuffer() {
  let events = []
  return {
    push(event) {
      events.push(event)
      if (events.length > MAX_LIVE_EVENTS) events = events.slice(-MAX_LIVE_EVENTS)
    },
    values() {
      return events.slice()
    },
    clear() {
      events = []
    }
  }
}

export function resolveDefaultSessionId(focusedStoredSessionId, activeSessionId) {
  const focused = typeof focusedStoredSessionId === 'string' ? focusedStoredSessionId.trim() : ''
  const active = typeof activeSessionId === 'string' ? activeSessionId.trim() : ''
  return focused || active || ''
}

export function resolveSessionSelection(selectedSessionId, focusedStoredSessionId, activeSessionId, sessionsValue) {
  const explicit = typeof selectedSessionId === 'string' ? selectedSessionId.trim() : ''
  const preferred = resolveDefaultSessionId(focusedStoredSessionId, activeSessionId)
  const sessions = Array.isArray(sessionsValue) ? sessionsValue : []
  const recent = sessions
    .map(session => String(asRecord(session).id ?? '').trim())
    .find(Boolean)
  return explicit || preferred || recent || ''
}

export function shouldRefetchSession(
  eventValue,
  selectedSessionIdValue,
  focusedStoredSessionIdValue,
  activeSessionIdValue
) {
  const event = asRecord(eventValue)
  const selectedSessionId = String(selectedSessionIdValue ?? '').trim()
  const eventSessionId = String(event.sessionId ?? '').trim()
  if (!selectedSessionId || !eventSessionId || event.type !== 'message.complete') return false
  if (eventSessionId === selectedSessionId) return true
  const focusedStoredSessionId = String(focusedStoredSessionIdValue ?? '').trim()
  const activeSessionId = String(activeSessionIdValue ?? '').trim()
  return Boolean(
    focusedStoredSessionId &&
      activeSessionId &&
      selectedSessionId === focusedStoredSessionId &&
      eventSessionId === activeSessionId
  )
}

function profileScope(profileValueOrProvider) {
  try {
    const value = typeof profileValueOrProvider === 'function' ? profileValueOrProvider() : profileValueOrProvider
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

function createDesktopSessionReader(profileValueOrProvider) {
  const desktop = globalThis.window?.hermesDesktop
  if (!desktop || typeof desktop.api !== 'function') return null
  return requestValue => {
    const request = { ...asRecord(requestValue) }
    const profile = profileScope(profileValueOrProvider)
    if (profile) request.profile = profile
    return desktop.api(request)
  }
}

function errorText(error) {
  return error instanceof Error && error.message ? error.message : String(error ?? 'Unknown error')
}

export function installHotReloadRelay(hostLike = host, globalObject = globalThis) {
  const previous = globalObject[RELAY_KEY]
  if (previous && typeof previous.dispose === 'function') previous.dispose()

  const buffer = createLiveEventBuffer()
  const subscribers = new Set()
  let isDisposed = false
  const relay = {
    subscribe(listener) {
      if (isDisposed || typeof listener !== 'function') return () => undefined
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    events: () => buffer.values(),
    disposed: () => isDisposed,
    dispose() {
      if (isDisposed) return
      isDisposed = true
      disposeHostListener()
      subscribers.clear()
      buffer.clear()
      if (globalObject[RELAY_KEY] === relay) delete globalObject[RELAY_KEY]
    }
  }
  const disposeHostListener = hostLike.onEvent('message.complete', eventValue => {
    if (isDisposed) return
    const event = asRecord(eventValue)
    const payload = asRecord(event.payload)
    const normalized = {
      type: 'message.complete',
      sessionId: String(event.session_id ?? payload.session_id ?? payload.sessionId ?? ''),
      raw: eventValue
    }
    buffer.push(normalized)
    for (const listener of [...subscribers]) listener(normalized)
  })
  globalObject[RELAY_KEY] = relay
  return relay
}

export function createTraceAdapter(relay = null, profileValueOrProvider = '') {
  const read = createDesktopSessionReader(profileValueOrProvider)
  const unavailable = 'Hermes Desktop session REST bridge is unavailable; only the current session can be identified.'
  const capabilities = {
    persistedMessages: Boolean(read),
    contextNodes: false,
    exactDurations: false,
    sourceMetadata: false,
    liveEvents: Boolean(relay && typeof relay.subscribe === 'function')
  }

  return {
    version: TRACE_ADAPTER_VERSION,
    capabilities,
    async listSessions() {
      if (!read) return { sessions: [], currentSessionOnly: true, error: unavailable }
      try {
        const result = asRecord(
          await read({ path: '/api/sessions?limit=100&offset=0&min_messages=0&archived=exclude&order=recent' })
        )
        return { sessions: boundSessions(result.sessions), currentSessionOnly: false, error: '' }
      } catch (error) {
        return { sessions: [], currentSessionOnly: true, error: errorText(error) }
      }
    },
    async loadSession(sessionIdValue) {
      const sessionId = String(sessionIdValue ?? '').trim()
      if (!sessionId) return { sessionId: '', messages: [], nodes: [], error: 'No session is selected.' }
      if (!read) return { sessionId, messages: [], nodes: [], error: unavailable }
      try {
        const path =
          `/api/sessions/${encodeURIComponent(sessionId)}/messages` +
          '?limit=500&offset=0&order=latest&include_compacted=true'
        const result = asRecord(await read({ path }))
        const messages = Array.isArray(result.messages) ? result.messages.slice(-MAX_MESSAGES) : []
        const resolvedSessionId = String(result.session_id ?? sessionId)
        return {
          sessionId: resolvedSessionId,
          messages,
          nodes: normalizeMessages(messages, resolvedSessionId),
          error: ''
        }
      } catch (error) {
        return { sessionId, messages: [], nodes: [], error: errorText(error) }
      }
    },
    normalizeMessages,
    subscribe(listener) {
      return relay && typeof relay.subscribe === 'function' ? relay.subscribe(listener) : () => undefined
    }
  }
}

function epochMilliseconds(timestamp) {
  const value = finiteTimestamp(timestamp)
  if (value === null) return null
  return Math.abs(value) < 100000000000 ? value * 1000 : value
}

function formatTimestamp(timestamp) {
  const value = epochMilliseconds(timestamp)
  if (value === null) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '—'
  }
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`
  return `${(milliseconds / 60000).toFixed(1)} min`
}

function traceMetrics(nodesValue) {
  const nodes = Array.isArray(nodesValue) ? nodesValue : []
  const timestamps = nodes.map(node => epochMilliseconds(asRecord(node).timestamp)).filter(value => value !== null)
  const turns = nodes.reduce((maximum, node) => Math.max(maximum, Number(asRecord(node).turn) || 0), 0)
  const calls = nodes.filter(node => asRecord(node).type === 'TOOL' && asRecord(asRecord(node).metadata).phase === 'call').length
  const durationMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0
  return { durationMs, turns, calls }
}

function sessionLabel(sessionValue) {
  const session = asRecord(sessionValue)
  return String(session.title ?? session.preview ?? session.id ?? '').trim() || 'Untitled session'
}

function Metric({ label, value, title }) {
  return jsxs('div', {
    className: 'min-w-24 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2',
    title,
    children: [
      jsx('div', { className: 'text-[0.6875rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: label }),
      jsx('div', { className: 'mt-0.5 text-sm font-semibold tabular-nums', children: value })
    ]
  })
}

function TraceTimeline({ nodes, selectedId, onSelect, t }) {
  const geometry = timelineGeometry(nodes)
  const geometryById = new Map(geometry.map(block => [block.id, block]))
  return jsxs('section', {
    className: 'rounded-xl border border-(--ui-stroke-secondary) p-3',
    'aria-label': t('timeline'),
    children: [
      jsxs('div', {
        className: 'mb-2 flex items-center justify-between gap-3',
        children: [
          jsx('h2', { className: 'text-xs font-semibold uppercase tracking-wide', children: t('timeline') }),
          jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('pointTiming') })
        ]
      }),
      ...['Input', 'Model', 'Tools'].map(lane =>
        jsxs('div', {
          className: 'flex min-w-0 items-center gap-2 py-1',
          children: [
            jsx('div', { className: 'w-12 shrink-0 text-[0.6875rem] font-medium text-(--ui-text-secondary)', children: lane }),
            jsx('div', {
              className: 'relative h-7 min-w-0 flex-1 overflow-hidden rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary)',
              children: nodes
                .filter(node => node.lane === lane)
                .map(node => {
                  const block = geometryById.get(String(node.id)) || { leftPct: 0, widthPct: 2 }
                  return jsx('button', {
                    type: 'button',
                    className: cn(
                      'absolute top-1 h-5 min-w-1 rounded-sm bg-(--ui-accent) opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-(--ui-accent)',
                      selectedId === node.id && 'outline-2 outline-offset-1 outline-(--ui-accent) opacity-100'
                    ),
                    style: { left: `${block.leftPct}%`, width: `${block.widthPct}%` },
                    title: `${node.type} · ${t('pointTiming')}`,
                    'aria-label': `${node.type}: ${safePreview(node.preview) || t('noPreview')}`,
                    onClick: () => onSelect(node),
                    children: jsx('span', { className: 'sr-only', children: node.type })
                  }, node.id)
                })
            })
          ]
        }, lane)
      )
    ]
  })
}

function TraceRow({ node, selected, onSelect, t }) {
  const metadata = asRecord(node.metadata)
  return jsxs('button', {
    type: 'button',
    className: cn(
      'grid w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
      selected
        ? 'border-(--ui-accent) outline-1 outline-(--ui-accent)'
        : 'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)'
    ),
    style: { gridTemplateColumns: TRACE_LAYOUT.traceRowGrid },
    onClick: () => onSelect(node),
    children: [
      jsx(Badge, { className: 'text-[0.625rem]', children: node.type }),
      jsxs('span', {
        className: 'min-w-0',
        children: [
          jsx('span', {
            className: 'block truncate text-xs',
            children: safePreview(node.preview) || t('noPreview')
          }),
          metadata.toolName
            ? jsx('span', { className: 'block truncate text-[0.6875rem] text-(--ui-text-tertiary)', children: metadata.toolName })
            : null
        ]
      }),
      jsxs('span', {
        className: 'text-right text-[0.625rem] text-(--ui-text-tertiary)',
        children: [
          jsx('span', { className: 'block', children: formatTimestamp(node.timestamp) }),
          jsx('span', { className: 'block uppercase', children: node.status })
        ]
      })
    ]
  })
}

function TraceList({ nodes, selectedId, onSelect, capabilities, t }) {
  const groups = []
  for (const node of nodes) {
    const last = groups[groups.length - 1]
    if (!last || last.turn !== node.turn) groups.push({ turn: node.turn, nodes: [node] })
    else last.nodes.push(node)
  }

  return jsxs('section', {
    className: 'min-h-0 rounded-xl border border-(--ui-stroke-secondary)',
    style: panelShellStyle(TRACE_LAYOUT.traceListHeight, TRACE_LAYOUT.traceListMinHeight),
    children: [
      capabilities.contextNodes === false
        ? jsxs('div', {
            className: 'flex items-start gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2 text-xs text-(--ui-text-secondary)',
            children: [
              jsx(Codicon, { name: 'info', size: '0.875rem' }),
              jsxs('span', {
                children: [jsx('strong', { children: t('contextUnavailable') }), ` — ${t('contextNotice')}`]
              })
            ]
          })
        : null,
      jsx('div', {
        style: PANEL_BODY_STYLE,
        children: nodes.length
          ? jsx('div', {
              className: 'space-y-4 p-3',
              children: groups.map(group =>
                jsxs('div', {
                  children: [
                    jsx('h3', {
                      className: 'mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)',
                      children: group.turn === 0 ? t('setup') : `${t('turn')} ${group.turn}`
                    }),
                    jsx('div', {
                      className: 'space-y-1.5',
                      children: group.nodes.map(node =>
                        jsx(TraceRow, {
                          node,
                          selected: selectedId === node.id,
                          onSelect,
                          t
                        }, node.id)
                      )
                    })
                  ]
                }, String(group.turn))
              )
            })
          : jsx(EmptyState, { title: t('emptyTitle'), description: t('emptyDescription'), className: 'm-4' })
      })
    ]
  })
}

function SummaryRow({ label, value }) {
  return jsxs('div', {
    className: 'grid gap-2 border-b border-(--ui-stroke-secondary) py-2 text-xs last:border-0',
    style: { gridTemplateColumns: TRACE_LAYOUT.summaryRowGrid },
    children: [
      jsx('dt', { className: 'text-(--ui-text-tertiary)', children: label }),
      jsx('dd', { className: 'min-w-0 break-words', children: value || '—' })
    ]
  })
}

function DetailPanel({ node, onClose, t }) {
  const [tab, setTab] = useState('summary')
  useEffect(() => setTab('summary'), [node?.id])

  const shellProps = {
    className: 'min-h-0 rounded-xl border border-(--ui-stroke-secondary) p-3',
    style: panelShellStyle(TRACE_LAYOUT.detailHeight, TRACE_LAYOUT.detailMinHeight)
  }

  if (!node) {
    return jsx('aside', {
      ...shellProps,
      children: jsx('div', {
        style: PANEL_BODY_STYLE,
        children: jsx(EmptyState, { title: t('selectNode'), description: t('selectNodeDescription') })
      })
    })
  }

  const metadata = asRecord(node.metadata)
  let body
  if (tab === 'preview') {
    body = jsx('div', { className: 'whitespace-pre-wrap break-words text-xs leading-5', children: safePreview(node.preview) || t('noPreview') })
  } else if (tab === 'raw') {
    body = jsx('pre', {
      className: 'overflow-auto whitespace-pre-wrap break-words text-[0.6875rem] leading-5 text-(--ui-text-secondary)',
      children: safeRaw(node.raw)
    })
  } else if (tab === 'source') {
    body = jsxs('div', {
      className: 'space-y-2 text-xs leading-5',
      children: [
        jsx('p', { children: node.source === 'live-gateway-event' ? t('sourceLive') : t('sourcePersisted') }),
        jsx('p', { className: 'text-(--ui-text-tertiary)', children: node.sourcePath || '—' })
      ]
    })
  } else {
    body = jsx('dl', {
      children: [
        [t('type'), node.type],
        [t('turn'), String(node.turn)],
        [t('status'), node.status],
        [t('timestamp'), formatTimestamp(node.timestamp)],
        [t('timingQuality'), t('pointTiming')],
        [t('toolName'), metadata.toolName],
        [t('callId'), metadata.callId]
      ].map(([label, value]) => jsx(SummaryRow, { label, value }, label))
    })
  }

  return jsxs('aside', {
    ...shellProps,
    children: [
      jsxs('div', {
        className: 'mb-3 flex items-center justify-between gap-2',
        children: [
          jsx('h2', { className: 'truncate text-sm font-semibold', children: node.type }),
          jsx(Button, {
            variant: 'ghost',
            size: 'icon-xs',
            'aria-label': t('closeDetail'),
            title: t('closeDetail'),
            onClick: onClose,
            children: jsx(Codicon, { name: 'close', size: '0.875rem' })
          })
        ]
      }),
      jsx(Tabs, {
        value: tab,
        onValueChange: setTab,
        children: jsx(TabsList, {
          className: 'grid h-auto w-full grid-cols-4',
          children: [
            ['summary', t('summary')],
            ['preview', t('preview')],
            ['raw', t('raw')],
            ['source', t('source')]
          ].map(([value, label]) => jsx(TabsTrigger, { value, className: 'px-1 text-xs', children: label }, value))
        })
      }),
      jsx('div', { className: 'pr-2', style: PANEL_BODY_STYLE, children: body })
    ]
  })
}

function LoadingTrace({ t }) {
  return jsxs('div', {
    className: 'space-y-3',
    'aria-label': t('loading'),
    children: [
      jsx(Skeleton, { className: 'h-24 w-full' }),
      jsx(Skeleton, { className: 'h-12 w-full' }),
      jsx(Skeleton, { className: 'h-12 w-full' })
    ]
  })
}

function TraceViewerPage({ adapter }) {
  const t = usePluginI18n(ID)
  const focusedStoredSessionId = useValue(host.state.focusedStoredSessionId)
  const activeSessionId = useValue(host.state.activeSessionId)
  const viewport = useValue(host.state.viewport)
  const preferredSessionId = resolveDefaultSessionId(focusedStoredSessionId, activeSessionId)
  const [sessions, setSessions] = useState([])
  const [selectedSessionId, setSelectedSessionId] = useState(() => preferredSessionId)
  const [nodes, setNodes] = useState([])
  const [selectedNode, setSelectedNode] = useState(null)
  const [query, setQuery] = useState('')
  const [lane, setLane] = useState('All')
  const [loading, setLoading] = useState(Boolean(preferredSessionId))
  const [error, setError] = useState('')
  const [currentSessionOnly, setCurrentSessionOnly] = useState(!adapter.capabilities.persistedMessages)
  const selectedSessionRef = useRef(selectedSessionId)
  selectedSessionRef.current = selectedSessionId

  const loadSession = useCallback(async sessionIdValue => {
    const sessionId = String(sessionIdValue ?? '').trim()
    if (!sessionId) {
      setNodes([])
      setError('')
      setLoading(false)
      return
    }
    setLoading(true)
    const result = await adapter.loadSession(sessionId)
    if (selectedSessionRef.current !== sessionId) return
    setNodes(result.nodes)
    setSelectedNode(current => result.nodes.find(node => node.id === current?.id) || null)
    setError(result.error)
    setLoading(false)
  }, [adapter])

  useEffect(() => {
    let active = true
    adapter.listSessions().then(result => {
      if (!active) return
      const rows = result.sessions.slice()
      const currentId = resolveSessionSelection(
        selectedSessionRef.current,
        focusedStoredSessionId,
        activeSessionId,
        rows
      )
      if (currentId && !rows.some(session => String(asRecord(session).id ?? '') === currentId)) {
        rows.unshift({ id: currentId, title: currentId })
      }
      setSessions(boundSessions(rows))
      setCurrentSessionOnly(result.currentSessionOnly)
      if (!selectedSessionRef.current && currentId) setSelectedSessionId(currentId)
      if (!currentId && result.error) setError(result.error)
    })
    return () => {
      active = false
    }
  }, [activeSessionId, adapter, focusedStoredSessionId])

  useEffect(() => {
    if (selectedSessionId) void loadSession(selectedSessionId)
    else setLoading(false)
  }, [loadSession, selectedSessionId])

  useEffect(
    () =>
      adapter.subscribe(event => {
        const selected = selectedSessionRef.current
        if (shouldRefetchSession(event, selected, focusedStoredSessionId, activeSessionId)) void loadSession(selected)
      }),
    [activeSessionId, adapter, focusedStoredSessionId, loadSession]
  )

  const filteredNodes = useMemo(() => filterNodes(nodes, query, lane), [nodes, query, lane])
  const metrics = useMemo(() => traceMetrics(nodes), [nodes])
  const selectedSession = sessions.find(session => String(asRecord(session).id ?? '') === selectedSessionId)
  const wide = !asRecord(viewport).narrow && Number(asRecord(viewport).width) >= 980
  const laneOptions = ['All', 'Input', 'Model', 'Tools'].map(id => ({ id, label: t(`filter${id}`) }))

  return jsxs('main', {
    className: 'flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4 text-sm text-foreground',
    children: [
      jsxs('header', {
        className: 'shrink-0 space-y-3',
        children: [
          jsxs('div', {
            className: 'flex flex-wrap items-start justify-between gap-3',
            children: [
              jsxs('div', {
                className: 'min-w-0',
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx('h1', { className: 'text-xl font-semibold tracking-tight', children: t('pageTitle') }),
                      jsx(Badge, { children: t('pluginData') }),
                      jsx(Badge, { children: `${t('layoutRevisionZh')} / ${t('layoutRevisionEn')}` })
                    ]
                  }),
                  jsx('p', {
                    className: 'mt-1 truncate text-xs text-(--ui-text-tertiary)',
                    title: selectedSessionId,
                    children: selectedSession ? `${sessionLabel(selectedSession)} · ${selectedSessionId}` : selectedSessionId || t('noSession')
                  })
                ]
              }),
              jsxs('div', {
                className: 'flex flex-wrap items-center justify-end gap-2',
                children: [
                  selectedSessionId
                    ? jsxs(Select, {
                        value: selectedSessionId,
                        onValueChange: value => {
                          setSelectedNode(null)
                          setSelectedSessionId(value)
                        },
                        children: [
                          jsx(SelectTrigger, {
                            className: 'w-52',
                            'aria-label': t('session'),
                            children: jsx(SelectValue, { placeholder: t('session') })
                          }),
                          jsx(SelectContent, {
                            children: sessions.map(session => {
                              const row = asRecord(session)
                              const id = String(row.id ?? '')
                              return jsx(SelectItem, { value: id, children: sessionLabel(row) }, id)
                            })
                          })
                        ]
                      })
                    : null,
                  jsx(Button, {
                    variant: 'outline',
                    size: 'sm',
                    disabled: !selectedSessionId || loading,
                    onClick: () => void loadSession(selectedSessionRef.current),
                    children: jsxs('span', {
                      className: 'inline-flex items-center gap-1.5',
                      children: [jsx(Codicon, { name: 'refresh', size: '0.875rem' }), t('refresh')]
                    })
                  })
                ]
              })
            ]
          }),
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-2',
            children: [
              jsx(Metric, { label: t('duration'), value: formatDuration(metrics.durationMs), title: t('durationHint') }),
              jsx(Metric, { label: t('turns'), value: String(metrics.turns) }),
              jsx(Metric, { label: t('calls'), value: String(metrics.calls) }),
              jsx(SearchField, {
                value: query,
                onChange: setQuery,
                onClear: () => setQuery(''),
                placeholder: t('searchPlaceholder'),
                containerClassName: 'ml-auto w-56'
              }),
              jsx(SegmentedControl, { options: laneOptions, value: lane, onChange: setLane })
            ]
          }),
          currentSessionOnly
            ? jsx('p', { className: 'text-xs text-(--ui-text-tertiary)', children: t('currentSessionOnly') })
            : null
        ]
      }),
      loading
        ? jsx(LoadingTrace, { t })
        : error
          ? jsx(ErrorState, {
              className: 'm-auto max-w-xl',
              title: t('loadError'),
              description: error,
              children: selectedSessionId
                ? jsx(Button, { variant: 'outline', onClick: () => void loadSession(selectedSessionRef.current), children: t('retry') })
                : null
            })
          : jsxs('div', {
              className: 'flex min-h-0 flex-1 flex-col gap-3 overflow-auto',
              children: [
                jsx(TraceTimeline, {
                  nodes: filteredNodes,
                  selectedId: selectedNode?.id,
                  onSelect: setSelectedNode,
                  t
                }),
                jsxs('div', {
                  className: 'min-h-0 flex-1',
                  style: {
                    display: 'grid',
                    gridTemplateColumns: splitGridColumns(wide),
                    alignItems: 'start',
                    gap: '0.75rem',
                    minWidth: 0
                  },
                  children: [
                    jsx(TraceList, {
                      nodes: filteredNodes,
                      selectedId: selectedNode?.id,
                      onSelect: setSelectedNode,
                      capabilities: adapter.capabilities,
                      t
                    }),
                    jsx(DetailPanel, { node: selectedNode, onClose: () => setSelectedNode(null), t })
                  ]
                })
              ]
            })
    ]
  })
}

export const __test = {
  DetailPanel,
  SummaryRow,
  TraceList,
  TraceRow,
  TraceViewerPage,
  boundSessions,
  createLiveEventBuffer,
  createTraceAdapter,
  filterNodes,
  installHotReloadRelay,
  normalizeMessages,
  redactSecrets,
  resolveDefaultSessionId,
  resolveSessionSelection,
  safePreview,
  safeRaw,
  shouldRefetchSession,
  splitGridColumns,
  timelineGeometry,
  traceLayout: TRACE_LAYOUT,
  traceMetrics
}

export default {
  id: ID,
  name: 'Hermes Trace Viewer',
  description: 'Inspect a bounded, read-only trace projection of Hermes session messages.',
  register(ctx) {
    ctx.i18n.register({
      en: {
        pageTitle: 'Trace Viewer',
        navLabel: 'Trace',
        openCommand: 'Open Trace Viewer',
        pluginData: 'Plugin data',
        refresh: 'Refresh',
        duration: 'Duration',
        durationHint: 'Observed span between message timestamps',
        turns: 'Turns',
        calls: 'Calls',
        searchPlaceholder: 'Search traces',
        filterAll: 'All',
        filterInput: 'Input',
        filterModel: 'Model',
        filterTools: 'Tools',
        timeline: 'Timeline',
        pointTiming: 'Estimated / point-in-time',
        contextUnavailable: 'CONTEXT UNAVAILABLE',
        contextNotice: 'The current backend does not expose per-turn injected context.',
        setup: 'Turn 0 / Setup',
        turn: 'Turn',
        summary: 'Summary',
        preview: 'Preview',
        raw: 'Raw',
        source: 'Source',
        type: 'Type',
        status: 'Status',
        timestamp: 'Timestamp',
        timingQuality: 'Timing quality',
        toolName: 'Tool name',
        callId: 'Call id',
        sourcePersisted: 'This node was derived from persisted session messages.',
        sourceLive: 'This node was derived from a live gateway event.',
        closeDetail: 'Clear selection',
        selectNode: 'Select a trace node',
        selectNodeDescription: 'Choose a timeline block or trace row to inspect details.',
        emptyTitle: 'No trace nodes',
        emptyDescription: 'This session is empty or no nodes match the current filters.',
        noPreview: 'No readable preview',
        noSession: 'No focused or active session',
        layoutRevisionZh: '布局 V4',
        layoutRevisionEn: 'Layout V4',
        session: 'Session',
        currentSessionOnly: 'Recent-session browsing is unavailable in this Desktop build; current-session-only mode is active.',
        loadError: 'Trace data could not be loaded',
        retry: 'Retry',
        loading: 'Loading trace data'
      },
      zh: {
        pageTitle: '轨迹检查器',
        navLabel: '轨迹',
        openCommand: '打开轨迹检查器',
        pluginData: '插件数据',
        refresh: '刷新',
        duration: '时长',
        durationHint: '消息时间戳之间的观测跨度',
        turns: '轮次',
        calls: '调用',
        searchPlaceholder: '搜索轨迹',
        filterAll: '全部',
        filterInput: '输入',
        filterModel: '模型',
        filterTools: '工具',
        timeline: '时间线',
        pointTiming: '估算 / 时间点',
        contextUnavailable: '上下文不可用',
        contextNotice: '当前后端不公开每轮注入的上下文。',
        setup: '第 0 轮 / 设置',
        turn: '轮次',
        summary: '摘要',
        preview: '预览',
        raw: '原始数据',
        source: '来源',
        type: '类型',
        status: '状态',
        timestamp: '时间戳',
        timingQuality: '计时质量',
        toolName: '工具名称',
        callId: '调用 ID',
        sourcePersisted: '此节点来自已持久化的会话消息。',
        sourceLive: '此节点来自实时网关事件。',
        closeDetail: '清除选择',
        selectNode: '选择轨迹节点',
        selectNodeDescription: '选择时间线块或轨迹行以查看详情。',
        emptyTitle: '没有轨迹节点',
        emptyDescription: '此会话为空，或没有节点符合当前筛选条件。',
        noPreview: '无可读预览',
        noSession: '没有聚焦或活动会话',
        layoutRevisionZh: '布局 V4',
        layoutRevisionEn: 'Layout V4',
        session: '会话',
        currentSessionOnly: '此 Desktop 版本无法浏览最近会话；当前仅可查看当前会话。',
        loadError: '无法加载轨迹数据',
        retry: '重试',
        loading: '正在加载轨迹数据'
      }
    })

    const relay = installHotReloadRelay(host, globalThis)
    ctx.onDispose(() => relay.dispose())
    const adapter = createTraceAdapter(relay, () => host.state.profile?.get?.())

    ctx.register({
      id: 'trace-route',
      area: ROUTES_AREA,
      title: ctx.i18n.t('pageTitle'),
      data: { path: '/trace' },
      render: () => jsx(TraceViewerPage, { adapter })
    })
    ctx.register({
      id: 'trace-nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/trace', label: ctx.i18n.t('navLabel'), codicon: 'pulse' }
    })
    ctx.register({
      id: 'open-trace-viewer',
      area: PALETTE_AREA,
      data: {
        id: 'hermes-trace-viewer.open',
        label: ctx.i18n.t('openCommand'),
        keywords: ['trace', 'viewer', '轨迹'],
        run: () => host.navigate('/trace')
      }
    })
  }
}
