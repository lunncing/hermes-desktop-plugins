/**
 * token-tracker — 状态栏 chip：实时 token 速度 (tok/s) + session 累计消耗
 *
 * 指标 1 (实时速度):  滑动窗口 — 最近 1 秒内的 delta 事件数 = tok/s
 *   - 🧠 思考阶段 (reasoning.delta / thinking.delta)
 *   - ⚡ 生成阶段 (message.delta)
 * 指标 2 (session 累计): host.state.focusedUsage.total
 *
 * 安装: 复制本目录到 $HERMES_HOME/desktop-plugins/token-tracker/
 */

import { atom, cn, host, Tip, useValue } from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'token-tracker'

// ── 模块级状态 ───────────────────────────────────────────────────────
const $liveRate = atom(0)       // tok/s (滑动窗口)
const $streaming = atom(false)
const $phase = atom('idle')     // 'thinking' | 'generating' | 'idle'

// 滑动窗口：只保留最近 1 秒的 delta 时间戳
const WINDOW_MS = 1000
let deltaTimestamps = []        // [Date.now(), Date.now(), ...]
let isStreaming = false

function recordDelta() {
  if (!isStreaming) return
  const now = Date.now()
  deltaTimestamps.push(now)
  // 清理超过 2 秒的旧记录（避免数组无限增长）
  const cutoff = now - (WINDOW_MS * 2)
  while (deltaTimestamps.length > 0 && deltaTimestamps[0] < cutoff) {
    deltaTimestamps.shift()
  }
}

function computeRate() {
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  let count = 0
  for (let i = deltaTimestamps.length - 1; i >= 0; i--) {
    if (deltaTimestamps[i] >= cutoff) count++
    else break
  }
  return count
}

// ── 事件监听 ─────────────────────────────────────────────────────────
const DISPOSER_KEY = Symbol.for('token-tracker-disposers')
if (globalThis[DISPOSER_KEY]) {
  for (const d of globalThis[DISPOSER_KEY]) { try { d() } catch (_) {} }
}
globalThis[DISPOSER_KEY] = []
const _d = globalThis[DISPOSER_KEY]

_d.push(host.onEvent('message.start', () => {
  deltaTimestamps = []
  isStreaming = true
  $liveRate.set(0)
  $streaming.set(true)
  $phase.set('idle')
}))

_d.push(host.onEvent('reasoning.delta', () => {
  if (!isStreaming) return
  recordDelta()
  $phase.set('thinking')
}))

_d.push(host.onEvent('thinking.delta', () => {
  if (!isStreaming) return
  recordDelta()
  $phase.set('thinking')
}))

_d.push(host.onEvent('message.delta', () => {
  if (!isStreaming) return
  recordDelta()
  $phase.set('generating')
}))

_d.push(host.onEvent('message.complete', () => {
  isStreaming = false
  $streaming.set(false)
  $phase.set('idle')
  // 保留最终速率显示一小段时间
  const finalRate = computeRate()
  $liveRate.set(finalRate)
}))

// ── 格式化 ──────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ── Chip 组件 ───────────────────────────────────────────────────────
function TokenTrackerChip() {
  const usage = useValue(host.state.focusedUsage)
  const streaming = useValue($streaming)
  const phase = useValue($phase)
  const rate = useValue($liveRate)

  // streaming 期间每 300ms 用滑动窗口刷新速率
  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => {
      $liveRate.set(computeRate())
    }, 300)
    return () => clearInterval(timer)
  }, [streaming])

  const sessionTotal = usage?.total ?? 0
  const hasData = sessionTotal > 0 || streaming
  if (!hasData) return null

  const parts = []

  // 指标 1: 实时速度 (仅 streaming 时显示)
  if (streaming && rate > 0) {
    const icon = phase === 'thinking' ? '🧠' : '⚡'
    parts.push(
      jsx('span', {
        className: 'text-(--ui-accent)',
        children: `${icon} ${rate} tok/s`
      })
    )
  }

  // 指标 2: session 累计消耗
  parts.push(
    jsx('span', {
      className: 'text-(--ui-text-secondary)',
      children: `Σ ${fmt(sessionTotal)}`
    })
  )

  const tipLabel = streaming
    ? `${phase === 'thinking' ? '思考' : '生成'}速度: ${rate} tok/s · 累计: ${sessionTotal.toLocaleString()} tokens`
    : `Session 累计消耗: ${sessionTotal.toLocaleString()} tokens (input+output 所有 API 调用之和)`

  return jsx(Tip, {
    label: tipLabel,
    children: jsxs('button', {
      className: cn(
        'inline-flex h-full items-center gap-1.5 pl-2 pr-1.5 text-[0.6875rem]',
        'transition-colors hover:bg-(--chrome-action-hover)'
      ),
      type: 'button',
      children: parts
    })
  })
}

export default {
  id: ID,
  name: 'Token Tracker',
  register(ctx) {
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 135,
      render: () => jsx(TokenTrackerChip, {})
    })
  }
}
