import {
  Badge,
  Button,
  Codicon,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  Switch,
  Textarea,
  host
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

const ID = 'minicpm-native-voice'
const TARGET_SAMPLE_RATE = 16_000
const MAX_UTTERANCE_SECONDS = 60
const MAX_CAPTURE_SAMPLES = TARGET_SAMPLE_RATE * MAX_UTTERANCE_SECONDS
const PRE_ROLL_SAMPLES = TARGET_SAMPLE_RATE / 2
const DEFAULT_SILENCE_MS = 4_000
const MIN_SILENCE_MS = 2_000
const MAX_SILENCE_MS = 6_000
const FALLBACK_PLAYBACK_RATE = 24_000
const MAX_PLAYBACK_SECONDS = 30
const MAX_AUDIO_DELTA_BYTES = 1024 * 1024
const MAX_PLAYBACK_RAW_BYTES = 8 * 1024 * 1024
const SERVER_START_TIMEOUT_MS = 210_000
const SERVER_STOP_TIMEOUT_MS = 20_000
const SERVER_POLL_TIMEOUT_MS = 5_000
const MAX_SYSTEM_PROMPT_BYTES = 65_536
const SYSTEM_PROMPT_LIMIT_ERROR = 'System prompt exceeds the maximum of 65,536 UTF-8 bytes.'
const USER_OWNED_MODEL_PROMPT_KEY = 'userOwnedModelPrompt'

function utf8ByteLength(value) {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1 } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function validateSystemPrompt(value) {
  if (typeof value !== 'string') throw new TypeError('system prompt must be a string')
  if (utf8ByteLength(value) > MAX_SYSTEM_PROMPT_BYTES) throw new RangeError(SYSTEM_PROMPT_LIMIT_ERROR)
  return value
}

function normalizeServerStatus(value, fallbackState = 'unreachable') {
  const source = value && typeof value === 'object' ? value : {}
  const state = typeof source.state === 'string' ? source.state : fallbackState
  const status = {
    configured: Boolean(source.configured),
    state,
    running: Boolean(source.running),
    managed: Boolean(source.managed),
    message: String(source.message || (state === 'unreachable' ? 'Server controls are unreachable.' : '')).slice(0, 256)
  }
  if (Number.isInteger(source.pid)) status.pid = source.pid
  return status
}

export function resampleTo16k(input, inputRate) {
  if (!(input instanceof Float32Array)) throw new TypeError('input must be Float32Array')
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new RangeError('inputRate must be positive')
  if (inputRate === TARGET_SAMPLE_RATE) return new Float32Array(input)
  const outputLength = Math.min(MAX_CAPTURE_SAMPLES, Math.floor(input.length * TARGET_SAMPLE_RATE / inputRate))
  const output = new Float32Array(outputLength)
  const ratio = inputRate / TARGET_SAMPLE_RATE
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const fraction = position - left
    output[index] = input[left] * (1 - fraction) + input[right] * fraction
  }
  return output
}

export function float32ToBytes(samples) {
  if (!(samples instanceof Float32Array)) throw new TypeError('samples must be Float32Array')
  const bytes = new ArrayBuffer(samples.length * 4)
  const view = new DataView(bytes)
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(index * 4, samples[index], true)
  }
  return bytes
}

export function bytesToFloat32(bytes) {
  const buffer = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  if (buffer.byteLength % 4) throw new RangeError('Float32 bytes must be divisible by four')
  const view = new DataView(buffer)
  const samples = new Float32Array(buffer.byteLength / 4)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getFloat32(index * 4, true)
  }
  return samples
}

function decodedBase64Length(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 !== 0) {
    throw new RangeError('audio must have valid Base64 length')
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new RangeError('audio must be valid Base64')
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return encoded.length / 4 * 3 - padding
}

export function decodeAudioBase64(encoded, { maxDecodedBytes = MAX_AUDIO_DELTA_BYTES } = {}) {
  const decodedBytes = decodedBase64Length(encoded)
  if (decodedBytes > maxDecodedBytes) throw new RangeError('decoded audio exceeds its byte budget')
  if (!decodedBytes || decodedBytes % 4) throw new RangeError('Float32 bytes must be divisible by four')
  const binary = atob(encoded)
  if (binary.length !== decodedBytes) throw new RangeError('Base64 decoder returned an unexpected byte length')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytesToFloat32(bytes)
}

export function createVad({ silenceMs = DEFAULT_SILENCE_MS, maxMs = 60_000, threshold = 0.02 } = {}) {
  if (silenceMs < MIN_SILENCE_MS || silenceMs > MAX_SILENCE_MS) throw new RangeError('silenceMs out of bounds')
  let speechStarted = false
  let quietMs = 0
  let elapsedMs = 0
  let ended = false

  return {
    push(level, durationMs) {
      if (ended) return { end: true, reason: 'already_ended', speechStarted }
      const duration = Math.max(0, Number(durationMs) || 0)
      if (Number(level) >= threshold) {
        elapsedMs += duration
        speechStarted = true
        quietMs = 0
      } else if (speechStarted) {
        elapsedMs += duration
        quietMs += duration
      }
      if (speechStarted && elapsedMs >= maxMs) {
        ended = true
        return { end: true, reason: 'max_duration', speechStarted: true }
      }
      if (speechStarted && quietMs >= silenceMs) {
        ended = true
        return { end: true, reason: 'silence', speechStarted: true }
      }
      return { end: false, reason: null, speechStarted }
    },
    snapshot() { return { speechStarted, silenceMs: quietMs, elapsedMs, ended } }
  }
}

export function createPreRoll(maxSamples) {
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) throw new RangeError('maxSamples must be positive')
  let retained = new Float32Array(0)
  return {
    push(samples) {
      const incoming = samples instanceof Float32Array ? samples : new Float32Array(samples)
      const combined = new Float32Array(Math.min(maxSamples, retained.length + incoming.length))
      const fromRetained = Math.min(retained.length, Math.max(0, combined.length - incoming.length))
      const fromIncoming = combined.length - fromRetained
      if (fromRetained) combined.set(retained.subarray(retained.length - fromRetained), 0)
      if (fromIncoming) combined.set(incoming.subarray(incoming.length - fromIncoming), fromRetained)
      retained = combined
    },
    samples() { return new Float32Array(retained) },
    clear() { retained = new Float32Array(0) },
    snapshot() { return { sampleCount: retained.length, maxSamples } }
  }
}

export function createCaptureAccumulator(maxSamples = MAX_CAPTURE_SAMPLES) {
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) throw new RangeError('maxSamples must be positive')
  const chunks = []
  let sampleCount = 0
  let full = false
  return {
    append(samples) {
      if (!(samples instanceof Float32Array)) throw new TypeError('samples must be Float32Array')
      const remaining = maxSamples - sampleCount
      if (remaining <= 0) {
        full = true
        return true
      }
      const accepted = samples.subarray(0, remaining)
      if (accepted.length) {
        chunks.push(new Float32Array(accepted))
        sampleCount += accepted.length
      }
      full = sampleCount >= maxSamples || accepted.length < samples.length
      return full
    },
    samples() {
      const result = new Float32Array(sampleCount)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
      return result
    },
    clear() { chunks.length = 0; sampleCount = 0; full = false },
    snapshot() { return { sampleCount, maxSamples, full } }
  }
}

export function createPlaybackQueue(audioContext, {
  maxQueuedSeconds = MAX_PLAYBACK_SECONDS,
  maxQueuedBytes = MAX_PLAYBACK_RAW_BYTES
} = {}) {
  if (!audioContext || maxQueuedSeconds <= 0 || !Number.isInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new RangeError('invalid playback queue')
  }
  const sources = new Set()
  const drainWaiters = new Set()
  let nextTime = audioContext.currentTime
  let queuedSeconds = 0
  let queuedBytes = 0
  let droppedChunks = 0

  const resolveDrainWaiters = () => {
    if (sources.size) return
    for (const resolve of drainWaiters) resolve()
    drainWaiters.clear()
  }

  return {
    enqueue(samples, sampleRate = FALLBACK_PLAYBACK_RATE) {
      if (!(samples instanceof Float32Array) || !Number.isInteger(sampleRate) || sampleRate <= 0) return false
      const duration = samples.length / sampleRate
      const byteLength = samples.byteLength
      if (!samples.length || queuedSeconds + duration > maxQueuedSeconds || queuedBytes + byteLength > maxQueuedBytes) {
        droppedChunks += 1
        return false
      }
      const buffer = audioContext.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      const source = audioContext.createBufferSource()
      try {
        source.buffer = buffer
        source.connect(audioContext.destination)
        const startsAt = Math.max(audioContext.currentTime, nextTime)
        source.onended = () => {
          if (!sources.delete(source)) return
          queuedSeconds = Math.max(0, queuedSeconds - duration)
          queuedBytes = Math.max(0, queuedBytes - byteLength)
          try { source.disconnect() } catch {}
          resolveDrainWaiters()
        }
        source.start(startsAt)
        nextTime = startsAt + duration
        queuedSeconds += duration
        queuedBytes += byteLength
        sources.add(source)
        return true
      } catch (error) {
        try { source.stop() } catch {}
        try { source.disconnect() } catch {}
        throw error
      }
    },
    interrupt() {
      for (const source of sources) {
        try { source.stop() } catch {}
        try { source.disconnect() } catch {}
      }
      sources.clear()
      queuedSeconds = 0
      queuedBytes = 0
      nextTime = audioContext.currentTime
      resolveDrainWaiters()
    },
    whenDrained() {
      if (!sources.size) return Promise.resolve()
      return new Promise(resolve => drainWaiters.add(resolve))
    },
    snapshot() {
      return { queuedSeconds, queuedBytes, nextTime, sourceCount: sources.size, droppedChunks, maxQueuedSeconds, maxQueuedBytes }
    }
  }
}

export function createResourceTracker(environment = globalThis) {
  const tracks = new Set()
  const nodes = new Set()
  const sources = new Set()
  const contexts = new Set()
  const timers = new Set()
  const rafs = new Set()
  const subscriptions = new Set()
  let cleaned = false
  return {
    trackTrack(value) { tracks.add(value); return value },
    trackNode(value) { nodes.add(value); return value },
    trackSource(value) { sources.add(value); return value },
    trackContext(value) { contexts.add(value); return value },
    trackTimer(value) { timers.add(value); return value },
    trackRaf(value) { rafs.add(value); return value },
    trackSubscription(value) { subscriptions.add(value); return value },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      for (const subscription of subscriptions) { try { subscription() } catch {} }
      for (const timer of timers) { try { environment.clearTimeout(timer) } catch {} }
      for (const raf of rafs) { try { environment.cancelAnimationFrame(raf) } catch {} }
      for (const source of sources) {
        try { source.stop() } catch {}
        try { source.disconnect() } catch {}
      }
      for (const node of nodes) { try { node.disconnect() } catch {} }
      for (const track of tracks) { try { track.stop() } catch {} }
      await Promise.all([...contexts].map(async context => { try { await context.close() } catch {} }))
      tracks.clear(); nodes.clear(); sources.clear(); contexts.clear(); timers.clear(); rafs.clear(); subscriptions.clear()
    }
  }
}

export function buildSessionStartRequest(systemPrompt = '') {
  const validatedPrompt = validateSystemPrompt(systemPrompt)
  return {
    path: '/session/start',
    options: { method: 'POST', body: { system_prompt: validatedPrompt }, timeoutMs: 130_000 }
  }
}

async function defaultCaptureFactory(options) {
  const mediaDevices = options.mediaDevices || globalThis.navigator?.mediaDevices
  const AudioContextCtor = options.AudioContextCtor || globalThis.AudioContext || globalThis.webkitAudioContext
  if (!mediaDevices?.getUserMedia || !AudioContextCtor) throw new Error('Microphone capture is unavailable')
  const tracker = createResourceTracker()
  let processor = null
  let transferred = false
  try {
    const stream = await mediaDevices.getUserMedia(options.constraints)
    for (const track of stream.getTracks()) tracker.trackTrack(track)
    const context = tracker.trackContext(new AudioContextCtor())
    if (context.state === 'suspended') await context.resume()
    const source = tracker.trackNode(context.createMediaStreamSource(stream))
    processor = tracker.trackNode(context.createScriptProcessor(4096, 1, 1))
    const silentGain = tracker.trackNode(context.createGain())
    silentGain.gain.value = 0
    source.connect(processor)
    processor.connect(silentGain)
    silentGain.connect(context.destination)
    processor.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0)
      const samples = resampleTo16k(new Float32Array(input), context.sampleRate)
      let sum = 0
      for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index]
      const level = samples.length ? Math.sqrt(sum / samples.length) : 0
      options.onFrame(samples, level)
    }
    transferred = true
    return {
      async cleanup() {
        if (processor) processor.onaudioprocess = null
        await tracker.cleanup()
      }
    }
  } finally {
    if (!transferred) {
      if (processor) processor.onaudioprocess = null
      await tracker.cleanup()
    }
  }
}

async function defaultPlaybackFactory(options = {}) {
  const AudioContextCtor = options.AudioContextCtor || globalThis.AudioContext || globalThis.webkitAudioContext
  const queueFactory = options.queueFactory || createPlaybackQueue
  if (!AudioContextCtor) throw new Error('Audio playback is unavailable')
  const tracker = createResourceTracker()
  let queue = null
  let transferred = false
  try {
    const context = tracker.trackContext(new AudioContextCtor())
    if (context.state === 'suspended') await context.resume()
    queue = queueFactory(context, {
      maxQueuedSeconds: MAX_PLAYBACK_SECONDS,
      maxQueuedBytes: MAX_PLAYBACK_RAW_BYTES
    })
    transferred = true
    return {
      ...queue,
      async cleanup() {
        queue?.interrupt?.()
        await tracker.cleanup()
      }
    }
  } finally {
    if (!transferred) {
      queue?.interrupt?.()
      await tracker.cleanup()
    }
  }
}

export function createVoiceRuntime({
  rest,
  storage,
  captureFactory = defaultCaptureFactory,
  playbackFactory = defaultPlaybackFactory,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval
}) {
  const listeners = new Set()
  let state = 'shell_ready'
  let active = false
  let muted = false
  let manuallyStopped = false
  let bargeIn = Boolean(storage.get('experimentalBargeIn', false))
  let silenceMs = Number(storage.get('silenceMs', DEFAULT_SILENCE_MS))
  if (!Number.isFinite(silenceMs) || silenceMs < MIN_SILENCE_MS || silenceMs > MAX_SILENCE_MS) silenceMs = DEFAULT_SILENCE_MS
  const storedSystemPrompt = storage.get(USER_OWNED_MODEL_PROMPT_KEY, '')
  let storedPromptRejected = false
  let systemPrompt = ''
  if (typeof storedSystemPrompt === 'string') {
    try { systemPrompt = validateSystemPrompt(storedSystemPrompt) } catch { storedPromptRejected = true }
  }
  let assistantText = ''
  let userTranscript = ''
  let microphoneLevel = 0
  let metrics = {}
  let errorMessage = storedPromptRejected ? SYSTEM_PROMPT_LIMIT_ERROR : ''
  let sessionId = null
  let backendGeneration = null
  let receivedAudioBytes = 0
  let capture = null
  let playback = null
  let playbackEpoch = null
  let playbackInitialization = null
  const playbackInitializationCleanups = new Set()
  let backendOwned = false
  let vad = createVad({ silenceMs })
  let accumulator = createCaptureAccumulator()
  const preRoll = createPreRoll(PRE_ROLL_SAMPLES)
  let socketDispose = null
  let pollTimer = null
  let disposed = false
  let disposePromise = null
  let bargeSpeechMs = 0
  let bargeRestarting = false
  let pendingBargeSubmit = false
  let bargeQueued = false
  let submitQueued = false
  let lifecycleTail = Promise.resolve()
  let lifecycleGeneration = 0
  let cancellationEpoch = 0
  let playbackCompletionRevision = 0
  let awaitingPlaybackDrain = false
  let pendingOperations = 0
  let server = normalizeServerStatus(null)
  let serverPendingOperations = 0
  let serverTail = Promise.resolve()
  let serverOperation = null
  let serverRevision = 0
  let serverPollRevision = 0

  const snapshot = () => ({
    state, active, muted, manuallyStopped, bargeIn, silenceMs, assistantText,
    userTranscript, microphoneLevel, metrics, systemPrompt, errorMessage,
    session_id: sessionId, generation: backendGeneration, busy: pendingOperations > 0,
    server: { ...server }, serverBusy: serverPendingOperations > 0,
    playback: playback?.snapshot?.() || { queuedSeconds: 0, queuedBytes: 0, droppedChunks: 0 }
  })
  const notify = () => { const value = snapshot(); for (const listener of listeners) listener(value) }
  const setState = value => { state = value; notify() }
  const resetUtterance = ({ clearUser = false } = {}) => {
    vad = createVad({ silenceMs })
    accumulator = createCaptureAccumulator()
    preRoll.clear()
    if (clearUser) userTranscript = ''
    bargeSpeechMs = 0
  }

  const owns = operation => (
    operation.generation === lifecycleGeneration &&
    operation.epoch === cancellationEpoch &&
    !disposed
  )

  const beginOperation = epoch => ({ generation: ++lifecycleGeneration, epoch })

  const invalidateOperations = () => {
    cancellationEpoch += 1
    lifecycleGeneration += 1
    playbackCompletionRevision += 1
    awaitingPlaybackDrain = false
    cancelPlaybackInitialization()
    return cancellationEpoch
  }

  const enqueue = (epoch, action) => {
    pendingOperations += 1
    notify()
    const result = lifecycleTail.then(() => action(epoch), () => action(epoch))
    lifecycleTail = result.catch(() => undefined)
    return result.finally(() => {
      pendingOperations = Math.max(0, pendingOperations - 1)
      notify()
    })
  }

  const enqueueServer = (kind, action) => {
    if (serverOperation?.kind === kind) return serverOperation.promise
    serverRevision += 1
    serverPendingOperations += 1
    notify()
    const result = serverTail.then(action, action)
    serverTail = result.catch(() => undefined)
    const token = { kind, promise: null }
    token.promise = result.finally(() => {
      serverPendingOperations = Math.max(0, serverPendingOperations - 1)
      if (serverOperation === token) serverOperation = null
      notify()
    })
    serverOperation = token
    return token.promise
  }

  function primePlayback(epoch) {
    if (playback && playbackEpoch === epoch) {
      return { epoch, promise: Promise.resolve(playback), installed: true, cleaned: false }
    }
    if (playbackInitialization?.epoch === epoch) return playbackInitialization

    let factoryResult
    try {
      factoryResult = playbackFactory()
    } catch (error) {
      factoryResult = Promise.reject(error)
    }
    const initialization = {
      epoch,
      promise: Promise.resolve(factoryResult),
      installed: false,
      cleaned: false
    }
    initialization.promise.catch(() => undefined)
    playbackInitialization = initialization
    return initialization
  }

  async function cleanupPlaybackInitialization(initialization, created) {
    if (initialization.installed || initialization.cleaned) return
    initialization.cleaned = true
    await created?.cleanup?.()
  }

  function cancelPlaybackInitialization() {
    const initialization = playbackInitialization
    if (!initialization || initialization.installed) return
    playbackInitialization = null
    const cleanup = initialization.promise.then(
      created => cleanupPlaybackInitialization(initialization, created),
      () => undefined
    )
    playbackInitializationCleanups.add(cleanup)
    void cleanup.then(
      () => playbackInitializationCleanups.delete(cleanup),
      () => playbackInitializationCleanups.delete(cleanup)
    )
  }

  async function ensurePlayback(operation, initialization) {
    if (playback && playbackEpoch === operation.epoch) return playback
    let created
    try {
      created = await initialization.promise
    } finally {
      if (playbackInitialization === initialization) playbackInitialization = null
    }
    if (!owns(operation) || initialization.epoch !== operation.epoch) {
      await cleanupPlaybackInitialization(initialization, created)
      return null
    }
    initialization.installed = true
    playback = created
    playbackEpoch = operation.epoch
    return playback
  }

  async function ensureCapture(operation) {
    if (capture) return capture
    const created = await captureFactory({
      constraints: { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } },
      onFrame(samples, level) { consumeFrame(samples, level) }
    })
    if (!owns(operation)) {
      await created?.cleanup?.()
      return null
    }
    capture = created
    return capture
  }

  async function releaseBrowserResources() {
    const ownedCapture = capture
    capture = null
    const ownedPlayback = playback
    playback = null
    playbackEpoch = null
    ownedPlayback?.interrupt?.()
    if (ownedCapture?.cleanup) await ownedCapture.cleanup()
    if (ownedPlayback?.cleanup) await ownedPlayback.cleanup()
    await Promise.all([...playbackInitializationCleanups])
  }

  async function stopCreatedBackend() {
    try { await rest('/session/stop', { method: 'POST', body: {} }) } catch {}
  }

  async function performEnd(epoch, { finalState = 'shell_ready', callBackend = backendOwned } = {}) {
    manuallyStopped = true
    active = false
    backendOwned = false
    sessionId = null
    backendGeneration = null
    receivedAudioBytes = 0
    pendingBargeSubmit = false
    bargeRestarting = false
    bargeQueued = false
    submitQueued = false
    await releaseBrowserResources()
    if (callBackend) await stopCreatedBackend()
    resetUtterance({ clearUser: true })
    if (epoch === cancellationEpoch) {
      state = finalState
      notify()
    }
  }

  async function failCurrent(operation, error, { callBackend = backendOwned } = {}) {
    if (!owns(operation)) return
    const epoch = invalidateOperations()
    await performEnd(epoch, { finalState: 'error', callBackend })
    if (epoch !== cancellationEpoch) return
    errorMessage = String(error?.message || error || 'Voice operation failed').slice(0, 1024)
    state = 'error'
    notify()
  }

  async function submitUtterance(operation) {
    if (!owns(operation) || !active || muted || !vad.snapshot().speechStarted) return false
    const samples = accumulator.samples()
    if (!samples.length) return false
    userTranscript = `Native audio · ${(samples.length / TARGET_SAMPLE_RATE).toFixed(1)} s`
    setState('thinking')
    resetUtterance()
    try {
      await rest('/turn', {
        method: 'POST',
        upload: { filename: 'turn.f32le.pcm', contentType: 'application/octet-stream', bytes: float32ToBytes(samples) },
        timeoutMs: 130_000
      })
      if (!owns(operation)) return false
      return true
    } catch (error) {
      if (!owns(operation)) return false
      await failCurrent(operation, error)
      throw error
    }
  }

  function scheduleSubmit() {
    if (submitQueued || disposed) return
    submitQueued = true
    const epoch = cancellationEpoch
    void enqueue(epoch, async scheduledEpoch => {
      try {
        if (scheduledEpoch !== cancellationEpoch || disposed) return false
        return await submitUtterance(beginOperation(scheduledEpoch))
      } finally {
        submitQueued = false
      }
    }).catch(() => undefined)
  }

  function consumeFrame(samples, level) {
    microphoneLevel = Math.min(1, Math.max(0, Number(level) || 0))
    const durationMs = samples.length * 1000 / TARGET_SAMPLE_RATE
    if (!active || muted) { notify(); return }
    const capturingTurn = state === 'listening' || bargeRestarting
    if (capturingTurn) {
      const speechWasStarted = vad.snapshot().speechStarted
      const decision = vad.push(level, durationMs)
      let full = false
      if (speechWasStarted) {
        full = accumulator.append(samples)
      } else if (decision.speechStarted) {
        const retained = preRoll.samples()
        accumulator = createCaptureAccumulator(MAX_CAPTURE_SAMPLES + retained.length)
        full = retained.length ? accumulator.append(retained) : false
        full = accumulator.append(samples) || full
      }
      preRoll.push(samples)
      if (decision.end || full) {
        if (!vad.snapshot().speechStarted) resetUtterance()
        else if (bargeRestarting) pendingBargeSubmit = true
        else scheduleSubmit()
      }
    } else if (state === 'speaking' && bargeIn && !bargeRestarting) {
      preRoll.push(samples)
      bargeSpeechMs = level >= 0.02 ? bargeSpeechMs + durationMs : 0
      if (bargeSpeechMs >= 300) scheduleAutomaticBargeIn()
    }
    notify()
  }

  async function restartSessionForInterrupt(operation, preserveSpeech) {
    if (!owns(operation) || !active) return snapshot()
    if (preserveSpeech) {
      const retained = preRoll.samples()
      accumulator = createCaptureAccumulator(MAX_CAPTURE_SAMPLES + retained.length)
      accumulator.append(retained)
      vad = createVad({ silenceMs })
      vad.push(0.1, Math.max(1, Math.min(bargeSpeechMs, retained.length * 1000 / TARGET_SAMPLE_RATE)))
      preRoll.clear()
    } else {
      resetUtterance()
    }
    playbackCompletionRevision += 1
    awaitingPlaybackDrain = false
    playback?.interrupt?.()
    active = false
    sessionId = null
    backendGeneration = null
    setState('loading')
    await rest('/session/stop', { method: 'POST', body: {} })
    backendOwned = false
    if (!owns(operation)) return snapshot()
    const request = buildSessionStartRequest(systemPrompt)
    const result = await rest(request.path, request.options)
    if (!owns(operation)) {
      await stopCreatedBackend()
      return snapshot()
    }
    sessionId = typeof result?.session_id === 'string' ? result.session_id : null
    backendGeneration = Number.isInteger(result?.generation) ? result.generation : null
    backendOwned = true
    active = true
    manuallyStopped = false
    setState('listening')
    if (pendingBargeSubmit) {
      pendingBargeSubmit = false
      await submitUtterance(operation)
    }
    return snapshot()
  }

  function scheduleAutomaticBargeIn() {
    if (bargeQueued || disposed || !active || !bargeIn) return
    bargeQueued = true
    const epoch = cancellationEpoch
    void enqueue(epoch, async scheduledEpoch => {
      if (scheduledEpoch !== cancellationEpoch || disposed || !active || !bargeIn) return snapshot()
      const operation = beginOperation(scheduledEpoch)
      bargeRestarting = true
      try {
        return await restartSessionForInterrupt(operation, true)
      } catch (error) {
        if (owns(operation)) await failCurrent(operation, error, { callBackend: false })
        return snapshot()
      } finally {
        bargeRestarting = false
        bargeQueued = false
      }
    }).catch(() => { bargeQueued = false })
  }

  const matchesCurrentSession = event => (
    active &&
    sessionId !== null &&
    backendGeneration !== null &&
    event.session_id === sessionId &&
    event.generation === backendGeneration
  )

  const matchesCurrentStatus = event => (
    active &&
    backendGeneration !== null &&
    event.generation === backendGeneration &&
    (
      event.session_id === sessionId ||
      (event.state === 'error' && event.session_id == null)
    )
  )

  const finishResponseAfterPlayback = (revision, expectedSessionId, expectedGeneration) => {
    if (
      revision !== playbackCompletionRevision || !awaitingPlaybackDrain ||
      !active || manuallyStopped || sessionId !== expectedSessionId ||
      backendGeneration !== expectedGeneration
    ) return
    awaitingPlaybackDrain = false
    resetUtterance()
    state = muted ? 'ready' : 'listening'
    notify()
  }

  const surfaceRuntimeError = message => {
    errorMessage = String(message || 'Voice stream failed').slice(0, 1024)
    state = 'error'
    active = false
    sessionId = null
    backendGeneration = null
    playback?.interrupt?.()
    notify()
    const epoch = invalidateOperations()
    void enqueue(epoch, () => performEnd(epoch, { finalState: 'error', callBackend: backendOwned })).catch(() => undefined)
  }

  const runtime = {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener) },
    bindSocket(socket) {
      if (disposed) return
      socketDispose?.()
      socketDispose = socket('/events', data => runtime.handleEvent(data))
    },
    startPolling() {
      if (pollTimer !== null || typeof setIntervalFn !== 'function') return
      pollTimer = setIntervalFn(async () => {
        const requestedEpoch = cancellationEpoch
        const requestedSession = sessionId
        const requestedGeneration = backendGeneration
        const requestedServerOperation = serverOperation
        const requestedServerRevision = serverRevision
        const requestedPollRevision = ++serverPollRevision
        try {
          const status = await rest('/server/status', { timeoutMs: SERVER_POLL_TIMEOUT_MS })
          if (
            !disposed && requestedServerOperation === serverOperation &&
            requestedServerRevision === serverRevision &&
            requestedPollRevision === serverPollRevision
          ) {
            server = normalizeServerStatus(status)
            notify()
          }
        } catch {
          if (
            !disposed && requestedServerOperation === serverOperation &&
            requestedServerRevision === serverRevision &&
            requestedPollRevision === serverPollRevision
          ) {
            server = normalizeServerStatus({
              configured: server.configured,
              state: 'unreachable',
              running: false,
              managed: false,
              message: 'Server controls are unreachable.'
            })
            notify()
          }
        }
        if (!active) return
        try {
          const status = await rest('/status')
          if (
            disposed || requestedEpoch !== cancellationEpoch ||
            requestedSession !== sessionId || requestedGeneration !== backendGeneration ||
            !matchesCurrentStatus(status)
          ) return
          if (status.state === 'error') {
            surfaceRuntimeError('backend reported error')
            return
          }
          if (
            status && typeof status.state === 'string' &&
            !(awaitingPlaybackDrain && ['listening', 'ready'].includes(status.state))
          ) state = status.state
          if (status?.metrics && typeof status.metrics === 'object') metrics = status.metrics
          notify()
        } catch {}
      }, 3_000)
    },
    startServer() {
      if (disposed) return Promise.reject(new Error('voice runtime is disposed'))
      if (serverOperation?.kind === 'start') return serverOperation.promise
      if (['starting', 'ready', 'external'].includes(server.state)) return Promise.resolve(snapshot())
      return enqueueServer('start', async () => {
        if (disposed) throw new Error('voice runtime is disposed')
        server = normalizeServerStatus({
          ...server,
          state: 'starting',
          message: 'Managed server is starting.'
        })
        notify()
        try {
          const result = await rest('/server/start', {
            method: 'POST', body: {}, timeoutMs: SERVER_START_TIMEOUT_MS
          })
          if (!disposed) {
            server = normalizeServerStatus(result)
            notify()
          }
          return snapshot()
        } catch (error) {
          if (!disposed) {
            server = normalizeServerStatus({
              configured: server.configured,
              state: 'error',
              running: false,
              managed: false,
              message: String(error?.message || error || 'Server start failed').slice(0, 256)
            }, 'error')
            notify()
          }
          throw error
        }
      })
    },
    stopServer() {
      if (disposed) return Promise.reject(new Error('voice runtime is disposed'))
      if (serverOperation?.kind === 'stop') return serverOperation.promise
      return enqueueServer('stop', async () => {
        if (disposed) throw new Error('voice runtime is disposed')
        if (!(server.managed && server.running)) return snapshot()
        await runtime.end()
        try {
          const result = await rest('/server/stop', {
            method: 'POST', body: {}, timeoutMs: SERVER_STOP_TIMEOUT_MS
          })
          if (!disposed) {
            server = normalizeServerStatus(result)
            notify()
          }
          return snapshot()
        } catch (error) {
          if (!disposed) {
            server = normalizeServerStatus({
              configured: server.configured,
              state: 'error',
              running: server.running,
              managed: server.managed,
              message: String(error?.message || error || 'Server stop failed').slice(0, 256)
            }, 'error')
            notify()
          }
          throw error
        }
      })
    },
    start(prompt) {
      if (disposed) return Promise.reject(new Error('voice runtime is disposed'))
      if (arguments.length > 0) runtime.setSystemPrompt(prompt)
      else if (storedPromptRejected) return Promise.reject(new RangeError(SYSTEM_PROMPT_LIMIT_ERROR))
      const epoch = cancellationEpoch
      const playbackPrime = primePlayback(epoch)
      return enqueue(epoch, async scheduledEpoch => {
        if (disposed) throw new Error('voice runtime is disposed')
        if (scheduledEpoch !== cancellationEpoch || active) return snapshot()
        const operation = beginOperation(scheduledEpoch)
        let backendCreated = false
        manuallyStopped = false
        assistantText = ''
        errorMessage = ''
        receivedAudioBytes = 0
        resetUtterance({ clearUser: true })
        setState('loading')
        try {
          if (!await ensurePlayback(operation, playbackPrime)) return snapshot()
          if (!owns(operation)) return snapshot()
          const request = buildSessionStartRequest(systemPrompt)
          const result = await rest(request.path, request.options)
          backendCreated = true
          if (!owns(operation)) {
            await stopCreatedBackend()
            await releaseBrowserResources()
            return snapshot()
          }
          if (!await ensureCapture(operation)) {
            await stopCreatedBackend()
            await releaseBrowserResources()
            return snapshot()
          }
          if (!owns(operation)) {
            await stopCreatedBackend()
            await releaseBrowserResources()
            return snapshot()
          }
          sessionId = typeof result?.session_id === 'string' ? result.session_id : null
          backendGeneration = Number.isInteger(result?.generation) ? result.generation : null
          backendOwned = true
          active = true
          state = result?.state || 'listening'
          if (state === 'ready') state = 'listening'
          notify()
          return snapshot()
        } catch (error) {
          if (!owns(operation)) {
            if (backendCreated) await stopCreatedBackend()
            await releaseBrowserResources()
            return snapshot()
          }
          await failCurrent(operation, error, { callBackend: backendCreated })
          throw error
        }
      })
    },
    manualDone() {
      const epoch = cancellationEpoch
      return enqueue(epoch, async scheduledEpoch => {
        if (scheduledEpoch !== cancellationEpoch || disposed) return false
        return submitUtterance(beginOperation(scheduledEpoch))
      })
    },
    interrupt() {
      const epoch = cancellationEpoch
      return enqueue(epoch, async scheduledEpoch => {
        if (scheduledEpoch !== cancellationEpoch || disposed || !active) return snapshot()
        const operation = beginOperation(scheduledEpoch)
        try {
          return await restartSessionForInterrupt(operation, false)
        } catch (error) {
          const failedCurrentOperation = owns(operation)
          if (failedCurrentOperation) await failCurrent(operation, error, { callBackend: false })
          if (failedCurrentOperation) throw error
          return snapshot()
        }
      })
    },
    setMuted(value) {
      muted = Boolean(value)
      if (muted) { resetUtterance(); if (active && state === 'listening') state = 'ready' }
      else if (active && state === 'ready') state = 'listening'
      notify()
    },
    setSystemPrompt(value) {
      const next = validateSystemPrompt(String(value))
      storage.set(USER_OWNED_MODEL_PROMPT_KEY, next)
      systemPrompt = next
      storedPromptRejected = false
      if (errorMessage === SYSTEM_PROMPT_LIMIT_ERROR) errorMessage = ''
      notify()
    },
    setSystemPromptFromUi(value) {
      try {
        runtime.setSystemPrompt(value)
        return true
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
        errorMessage = String(error.message || SYSTEM_PROMPT_LIMIT_ERROR).slice(0, 1024)
        notify()
        return false
      }
    },
    setBargeIn(value) { bargeIn = Boolean(value); storage.set('experimentalBargeIn', bargeIn); notify() },
    setSilenceMs(value) {
      const next = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, Number(value) || DEFAULT_SILENCE_MS))
      silenceMs = next
      storage.set('silenceMs', silenceMs)
      resetUtterance()
      notify()
    },
    handleEvent(event) {
      if (!event || typeof event !== 'object') return
      if (!(matchesCurrentSession(event) || (event.type === 'status' && matchesCurrentStatus(event)))) return
      if (event.type === 'state' || event.type === 'status') {
        if (event.state === 'error') {
          surfaceRuntimeError(event.message || 'backend reported error')
          return
        }
        if (
          typeof event.state === 'string' &&
          !(awaitingPlaybackDrain && ['listening', 'ready'].includes(event.state))
        ) state = event.state
        if (event.metrics && typeof event.metrics === 'object') metrics = event.metrics
      } else if (event.type === 'text.delta') {
        assistantText = (assistantText + String(event.text || '')).slice(0, 65_536)
        if (event.metrics && typeof event.metrics === 'object') metrics = event.metrics
      } else if (event.type === 'audio.delta') {
        const rate = Number.isInteger(event.sample_rate) && event.sample_rate > 0 ? event.sample_rate : FALLBACK_PLAYBACK_RATE
        try {
          const playbackState = playback?.snapshot?.() || {}
          const queueByteRemaining = Math.max(0, (playbackState.maxQueuedBytes ?? MAX_PLAYBACK_RAW_BYTES) - (playbackState.queuedBytes || 0))
          const queueSecondRemaining = Math.max(0, (playbackState.maxQueuedSeconds ?? MAX_PLAYBACK_SECONDS) - (playbackState.queuedSeconds || 0))
          const durationByteRemaining = Math.floor(queueSecondRemaining * rate) * 4
          const turnByteRemaining = Math.max(0, MAX_PLAYBACK_RAW_BYTES - receivedAudioBytes)
          const maxDecodedBytes = Math.min(MAX_AUDIO_DELTA_BYTES, queueByteRemaining, durationByteRemaining, turnByteRemaining)
          const samples = decodeAudioBase64(String(event.audio || ''), { maxDecodedBytes })
          if (!playback?.enqueue?.(samples, rate)) throw new RangeError('playback queue budget exceeded')
          receivedAudioBytes += samples.byteLength
          state = 'speaking'
        } catch (error) {
          surfaceRuntimeError(error)
        }
        if (event.metrics && typeof event.metrics === 'object') metrics = event.metrics
      } else if (event.type === 'response.done') {
        if (typeof event.text === 'string') assistantText = event.text.slice(0, 65_536)
        if (event.metrics && typeof event.metrics === 'object') metrics = event.metrics
        receivedAudioBytes = 0
        const playbackState = playback?.snapshot?.() || {}
        const playbackPending = (
          Number(playbackState.sourceCount || 0) > 0 ||
          Number(playbackState.queuedSeconds || 0) > 0 ||
          Number(playbackState.queuedBytes || 0) > 0
        )
        if (active && !manuallyStopped && playbackPending && typeof playback?.whenDrained === 'function') {
          const revision = ++playbackCompletionRevision
          const expectedSessionId = sessionId
          const expectedGeneration = backendGeneration
          awaitingPlaybackDrain = true
          state = 'speaking'
          void playback.whenDrained().then(() => {
            finishResponseAfterPlayback(revision, expectedSessionId, expectedGeneration)
          })
        } else if (active && !muted && !manuallyStopped) {
          awaitingPlaybackDrain = false
          resetUtterance()
          state = 'listening'
        } else if (active) {
          awaitingPlaybackDrain = false
          state = 'ready'
        }
      } else if (event.type === 'error') {
        surfaceRuntimeError(event.message || event.code)
      }
      notify()
    },
    end() {
      const epoch = invalidateOperations()
      manuallyStopped = true
      active = false
      sessionId = null
      backendGeneration = null
      playback?.interrupt?.()
      return enqueue(epoch, async () => {
        await performEnd(epoch, { callBackend: backendOwned })
        return snapshot()
      })
    },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      const epoch = invalidateOperations()
      manuallyStopped = true
      active = false
      sessionId = null
      backendGeneration = null
      playback?.interrupt?.()
      socketDispose?.(); socketDispose = null
      if (pollTimer !== null && typeof clearIntervalFn === 'function') clearIntervalFn(pollTimer)
      pollTimer = null
      disposePromise = enqueue(epoch, async () => {
        await performEnd(epoch, { callBackend: backendOwned })
        listeners.clear()
        return snapshot()
      })
      return disposePromise
    }
  }
  return runtime
}

function EnglishCoachPage({ runtime }) {
  const [view, setView] = useState(() => runtime.snapshot())
  useEffect(() => {
    const unsubscribe = runtime.subscribe(setView)
    return () => {
      unsubscribe()
      void runtime.end()
    }
  }, [runtime])
  const act = useCallback(action => { void action().catch(() => undefined) }, [])
  const status = useMemo(() => String(view.state), [view.state])
  const serverView = view.server || normalizeServerStatus(null)
  const serverUsableForVoice = serverView.state === 'ready' || serverView.state === 'external'
  const startServerDisabled = view.serverBusy || ['starting', 'ready', 'external'].includes(serverView.state)
  const stopServerDisabled = view.serverBusy || !(serverView.managed && serverView.running)

  return jsxs('main', {
    style: {
      display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', height: '100%',
      minWidth: 0, minHeight: 0, boxSizing: 'border-box', padding: '1rem', overflow: 'auto'
    },
    children: [
      jsxs('header', {
        children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem' }, children: [
            jsx('h1', { style: { margin: 0 }, children: 'English Coach' }),
            jsx(Badge, { children: status })
          ] }),
          jsx('p', { style: { color: 'var(--ui-text-secondary)' }, children: 'Native audio · Turn-based streaming (V1)' })
        ]
      }),
      jsxs('section', {
        'aria-label': 'Local MiniCPM server controls',
        style: { display: 'grid', gap: '0.5rem', padding: '0.75rem', border: '1px solid var(--ui-border)' },
        children: [
          jsx('strong', { children: `Server: ${serverView.state}` }),
          jsx('p', { style: { margin: 0, color: 'var(--ui-text-secondary)' }, children: serverView.message }),
          jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }, children: [
            jsx(Button, {
              disabled: startServerDisabled,
              onClick: () => act(() => runtime.startServer()),
              children: 'Start Server'
            }),
            jsx(Button, {
              disabled: stopServerDisabled,
              onClick: () => act(() => runtime.stopServer()),
              children: 'Stop Server'
            })
          ] })
        ]
      }),
      jsx(Textarea, {
        value: view.systemPrompt,
        maxLength: MAX_SYSTEM_PROMPT_BYTES,
        placeholder: 'Optional instructions you write for the model',
        onChange: event => runtime.setSystemPromptFromUi(event.target.value),
        'aria-label': 'User-owned model prompt'
      }),
      jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }, children: [
        jsx(Button, { disabled: view.active || view.busy || !serverUsableForVoice, onClick: () => act(() => runtime.start()), children: 'Start' }),
        jsx(Button, { disabled: !view.active, onClick: () => runtime.setMuted(!view.muted), children: view.muted ? 'Unmute' : 'Mute' }),
        jsx(Button, { disabled: !view.active || view.muted, onClick: () => act(() => runtime.manualDone()), children: "I'm done" }),
        jsx(Button, { disabled: !view.active, onClick: () => act(() => runtime.interrupt()), children: 'Interrupt' }),
        jsx(Button, { disabled: !view.active, onClick: () => act(() => runtime.end()), children: 'End' })
      ] }),
      jsxs('label', { children: [
        `End-of-turn silence: ${view.silenceMs} ms`,
        jsx(Input, {
          type: 'range', min: MIN_SILENCE_MS, max: MAX_SILENCE_MS, step: 250, value: view.silenceMs,
          onChange: event => runtime.setSilenceMs(Number(event.target.value))
        })
      ] }),
      jsxs('label', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem' }, children: [
        jsx(Switch, { checked: view.bargeIn, onCheckedChange: value => runtime.setBargeIn(value) }),
        'Experimental automatic barge-in (off by default)'
      ] }),
      jsx('div', {
        role: 'meter', 'aria-label': 'Microphone level', 'aria-valuemin': 0, 'aria-valuemax': 1,
        'aria-valuenow': view.microphoneLevel,
        style: { height: '0.5rem', width: `${Math.round(view.microphoneLevel * 100)}%`, minWidth: '0.25rem', background: 'var(--ui-accent)' }
      }),
      jsxs('section', { 'aria-label': 'Current user and assistant transcript', style: { display: 'grid', gap: '0.5rem' }, children: [
        jsxs('div', { children: [jsx('strong', { children: 'You: ' }), view.userTranscript || 'Waiting for native audio.'] }),
        jsxs('div', { children: [jsx('strong', { children: 'Assistant: ' }), view.assistantText || 'No response yet.'] })
      ] }),
      jsx('section', {
        'aria-label': 'Timing metrics',
        style: { fontFamily: 'var(--font-mono)', color: 'var(--ui-text-secondary)', overflowWrap: 'anywhere' },
        children: Object.keys(view.metrics || {}).length ? JSON.stringify(view.metrics) : 'Timing metrics appear when supplied.'
      }),
      view.errorMessage ? jsx('p', { role: 'alert', children: view.errorMessage }) : null
    ]
  })
}

export const __test = {
  EnglishCoachPage,
  MAX_SYSTEM_PROMPT_BYTES,
  buildSessionStartRequest,
  bytesToFloat32,
  createCaptureAccumulator,
  createPlaybackQueue,
  createPreRoll,
  createResourceTracker,
  createVoiceRuntime,
  createVad,
  decodeAudioBase64,
  defaultCaptureFactory,
  defaultPlaybackFactory,
  float32ToBytes,
  resampleTo16k
}

export default {
  id: ID,
  name: 'MiniCPM Native Voice',
  description: 'A native turn-based audio bridge for a local MiniCPM-o server.',
  defaultEnabled: false,
  register(ctx) {
    ctx.i18n.register({ en: { pageTitle: 'English Coach' } })
    const runtime = createVoiceRuntime({ rest: ctx.rest, storage: ctx.storage })
    runtime.bindSocket(ctx.socket)
    runtime.startPolling()
    ctx.onDispose(() => { void runtime.dispose() })
    ctx.register({
      id: 'voice-route',
      area: ROUTES_AREA,
      title: 'English Coach',
      data: { path: '/minicpm-native-voice' },
      render: () => jsx(EnglishCoachPage, { runtime })
    })
    ctx.register({
      id: 'voice-nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/minicpm-native-voice', label: 'English Coach', codicon: 'mic' }
    })
    ctx.register({
      id: 'open-voice-coach',
      area: PALETTE_AREA,
      data: {
        id: 'minicpm-native-voice.open',
        label: 'Open English Coach',
        keywords: ['voice', 'audio', 'coach'],
        run: () => host.navigate('/minicpm-native-voice')
      }
    })
  }
}
