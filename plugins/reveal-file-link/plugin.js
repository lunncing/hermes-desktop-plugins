import { cn } from '@hermes/plugin-sdk'
import { useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'

const DEFAULT_LABEL = '在文件夹中显示'
const ERROR_LABEL = '无法显示，点击重试'
const INVALID_LABEL = '文件路径无效'
const MAX_LABEL_CHARS = 128
const MAX_PATH_CHARS = 1024
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/
const UNC_RE = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/

export function normalizeLabel(value) {
  if (typeof value !== 'string') return DEFAULT_LABEL
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_LABEL_CHARS) : DEFAULT_LABEL
}

export function normalizePath(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_RE.test(value)) return null

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_PATH_CHARS) return null
  if (WINDOWS_DRIVE_RE.test(trimmed)) return trimmed
  if (UNC_RE.test(trimmed) && !/^\\\\[?.][\\/]/.test(trimmed)) return trimmed
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
  return null
}

export function RevealFileControl({ label: rawLabel, path: rawPath, revealPath, streaming = false }) {
  const path = normalizePath(rawPath)
  const label = normalizeLabel(rawLabel)
  const inFlight = useRef(false)
  const [status, setStatus] = useState('idle')
  const invalid = path === null || typeof revealPath !== 'function'
  const disabled = Boolean(streaming || invalid || status === 'loading')
  const error = invalid ? INVALID_LABEL : status === 'error' ? ERROR_LABEL : ''
  const accessibleLabel = error || label

  const handleClick = async () => {
    if (streaming || invalid || inFlight.current) return

    inFlight.current = true
    setStatus('loading')
    try {
      const revealed = await revealPath(path)
      setStatus(revealed ? 'idle' : 'error')
    } catch {
      setStatus('error')
    } finally {
      inFlight.current = false
    }
  }

  return jsx('button', {
    'aria-label': accessibleLabel,
    className: cn(
      'inline-flex items-center bg-transparent p-0 text-sm text-(--ui-accent) underline underline-offset-2',
      'hover:text-(--ui-accent-hover) focus-visible:outline focus-visible:outline-2',
      'focus-visible:outline-(--ui-focus-ring) disabled:cursor-not-allowed disabled:text-(--ui-text-secondary)'
    ),
    disabled,
    onClick: handleClick,
    title: accessibleLabel,
    type: 'button',
    children: status === 'loading' ? label : error || label
  })
}

export default {
  id: 'reveal-file-link',
  name: 'Reveal File Link',
  description: 'Reveals an absolute file path in the system file manager.',
  defaultEnabled: true,
  register(ctx) {
    const revealPath = path => ctx.os.revealPath(path)
    return ctx.register({
      id: 'reveal-file',
      area: 'transcript.directives',
      data: {
        name: 'reveal-file',
        render: ({ attrs, streaming }) =>
          jsx(RevealFileControl, {
            label: attrs?.label,
            path: attrs?.path,
            revealPath,
            streaming: Boolean(streaming)
          })
      }
    })
  }
}
