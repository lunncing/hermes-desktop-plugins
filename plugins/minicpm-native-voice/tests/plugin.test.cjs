const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const PLUGIN_PATH = path.join(__dirname, '..', 'desktop', 'plugin.js')

test('production React hook identifiers are imported from react', () => {
  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  const reactImport = source.match(/import\s*{([\s\S]*?)}\s*from\s*['"]react['"]/)
  assert.ok(reactImport, 'production source must have a named import from react')

  const importedHooks = new Set(
    [...reactImport[1].matchAll(/\buse[A-Z][A-Za-z0-9_]*\b/g)].map(match => match[0])
  )
  const productionBody = source.replace(reactImport[0], '')
  const usedHooks = [
    ...new Set([...productionBody.matchAll(/\buse[A-Z][A-Za-z0-9_]*\b/g)].map(match => match[0]))
  ].sort()
  const missingHooks = usedHooks.filter(hook => !importedHooks.has(hook))

  assert.deepEqual(missingHooks, [], `React hooks missing from the production import: ${missingHooks.join(', ')}`)
})

function loadPlugin(overrides = {}) {
  let source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  source = source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
  source = source.replace(/export\s+(const|function|class)\s+/g, '$1 ')
  source = source.replace(/export default\s+/, 'const plugin = ')

  const context = {
    ArrayBuffer,
    DataView,
    Float32Array,
    Math,
    Uint8Array,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    clearTimeout,
    cancelAnimationFrame() {},
    console,
    globalThis: null,
    setTimeout,
    sdk: {
      Badge: 'Badge',
      Button: 'Button',
      Codicon: 'Codicon',
      Input: 'Input',
      PALETTE_AREA: 'palette',
      ROUTES_AREA: 'routes',
      SIDEBAR_NAV_AREA: 'sidebar.nav',
      Switch: 'Switch',
      Textarea: 'Textarea',
      host: { navigate() {} }
    },
    react: {
      useCallback: value => value,
      useEffect() {},
      useMemo: value => value(),
      useRef: value => ({ current: value }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    runtime: {
      Fragment: 'Fragment',
      jsx: (type, props) => ({ type, props: props || {} }),
      jsxs: (type, props) => ({ type, props: props || {} })
    }
  }
  Object.assign(context, overrides)
  context.globalThis = context
  const wrapped = `
    const { Badge, Button, Codicon, Input, PALETTE_AREA, ROUTES_AREA,
      SIDEBAR_NAV_AREA, Switch, Textarea, host } = sdk
    const { useCallback, useEffect, useMemo, useRef, useState } = react
    const { Fragment, jsx, jsxs } = runtime
    ${source}
    globalThis.__loaded = { plugin, testApi: __test }
  `
  vm.runInNewContext(wrapped, context, { filename: PLUGIN_PATH })
  return context.__loaded
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function until(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(message)
}

function descendants(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return []
  if (Array.isArray(value)) return value.flatMap(descendants)
  if (typeof value !== 'object') return []
  return [value, ...descendants(value.props?.children)]
}

function elementText(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(elementText).join('')
  return elementText(value.props?.children)
}

function createHookRenderer() {
  const hooks = []
  let component = null
  let props = null
  let cursor = 0
  let pendingEffects = []
  let output = null

  const dependenciesChanged = (previous, next) => (
    !previous || !next || previous.length !== next.length ||
    previous.some((value, index) => !Object.is(value, next[index]))
  )
  const react = {
    useCallback(value, dependencies) {
      return react.useMemo(() => value, dependencies)
    },
    useEffect(effect, dependencies) {
      const index = cursor++
      const hook = hooks[index]
      if (!hook || dependenciesChanged(hook.dependencies, dependencies)) {
        pendingEffects.push({ index, effect, dependencies })
      }
    },
    useMemo(factory, dependencies) {
      const index = cursor++
      const hook = hooks[index]
      if (!hook || dependenciesChanged(hook.dependencies, dependencies)) {
        hooks[index] = { value: factory(), dependencies }
      }
      return hooks[index].value
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const setValue = value => {
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value
      }
      return [hooks[index].value, setValue]
    }
  }
  const commitEffects = () => {
    for (const pending of pendingEffects) {
      const previous = hooks[pending.index]
      previous?.cleanup?.()
      hooks[pending.index] = {
        dependencies: pending.dependencies,
        cleanup: pending.effect()
      }
    }
    pendingEffects = []
  }

  return {
    react,
    render(nextComponent = component, nextProps = props) {
      component = nextComponent
      props = nextProps
      cursor = 0
      output = component(props)
      commitEffects()
      return output
    },
    output: () => output,
    unmount() {
      for (const hook of hooks) hook?.cleanup?.()
    }
  }
}

function createRafHarness() {
  const callbacks = new Map()
  let nextId = 0
  return {
    requestAnimationFrame(callback) {
      const id = ++nextId
      callbacks.set(id, callback)
      return id
    },
    cancelAnimationFrame(id) {
      callbacks.delete(id)
    },
    flush() {
      const scheduled = [...callbacks.values()]
      callbacks.clear()
      for (const callback of scheduled) callback()
    },
    pending: () => callbacks.size
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0
    this.destination = { id: 'destination' }
    this.buffers = []
    this.sources = []
  }

  createBuffer(channels, length, sampleRate) {
    const buffer = {
      channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      copied: null,
      copyToChannel(samples) { this.copied = Array.from(samples) }
    }
    this.buffers.push(buffer)
    return buffer
  }

  createBufferSource() {
    const source = {
      buffer: null,
      connected: null,
      starts: [],
      stopped: 0,
      connect(destination) { this.connected = destination },
      disconnect() { this.disconnected = true },
      start(when) { this.starts.push(when) },
      stop() { this.stopped += 1 }
    }
    this.sources.push(source)
    return source
  }
}

test('resampling produces bounded 16 kHz mono Float32 PCM', () => {
  const { testApi } = loadPlugin()
  const input = new Float32Array(48_000).fill(0.25)
  const output = testApi.resampleTo16k(input, 48_000)

  assert.equal(output.length, 16_000)
  assert.equal(output instanceof Float32Array, true)
  assert.ok(Math.abs(output[8_000] - 0.25) < 1e-6)
})

test('Float32 little-endian byte encoding and decoding round trips', () => {
  const { testApi } = loadPlugin()
  const samples = new Float32Array([0, 0.5, -1, Math.PI])
  const bytes = testApi.float32ToBytes(samples)
  const view = new DataView(bytes)

  assert.equal(bytes.byteLength, samples.length * 4)
  assert.equal(view.getFloat32(4, true), 0.5)
  assert.deepEqual(Array.from(testApi.bytesToFloat32(bytes)), Array.from(samples))
})

test('VAD never submits initial silence', () => {
  const { testApi } = loadPlugin()
  const vad = testApi.createVad({ silenceMs: 4_000, maxMs: 60_000, threshold: 0.02 })

  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    assert.equal(vad.push(0.001, 100).end, false)
  }
  assert.equal(vad.snapshot().speechStarted, false)
})

test('VAD preserves a 2–3 second mid-sentence hesitation at 4000 ms', () => {
  const { testApi } = loadPlugin()
  const vad = testApi.createVad({ silenceMs: 4_000, maxMs: 60_000, threshold: 0.02 })

  vad.push(0.2, 100)
  assert.equal(vad.push(0.001, 3_000).end, false)
  assert.equal(vad.push(0.2, 100).end, false)
  assert.equal(vad.snapshot().silenceMs, 0)
})

test('VAD ends after 4000 ms of post-speech silence', () => {
  const { testApi } = loadPlugin()
  const vad = testApi.createVad({ silenceMs: 4_000, maxMs: 60_000, threshold: 0.02 })

  vad.push(0.2, 100)
  assert.equal(vad.push(0.001, 3_999).end, false)
  assert.deepEqual(JSON.parse(JSON.stringify(vad.push(0.001, 1))), { end: true, reason: 'silence', speechStarted: true })
})

test('VAD and persisted preference clamp the silence window at 6000 ms', () => {
  const { testApi } = loadPlugin()
  assert.throws(() => testApi.createVad({ silenceMs: 6_001 }), /bounds/)
  assert.doesNotThrow(() => testApi.createVad({ silenceMs: 6_000 }))

  const writes = []
  const runtime = testApi.createVoiceRuntime({
    rest: async () => ({}),
    storage: { get: key => key === 'silenceMs' ? 8_000 : false, set: (key, value) => writes.push([key, value]) },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: async () => ({ cleanup: async () => {}, interrupt() {}, snapshot() { return {} } })
  })
  assert.equal(runtime.snapshot().silenceMs, 4_000)
  runtime.setSilenceMs(8_000)
  assert.equal(runtime.snapshot().silenceMs, 6_000)
  assert.deepEqual(writes.at(-1), ['silenceMs', 6_000])
})

test('VAD enforces the 60-second utterance cap only after speech', () => {
  const { testApi } = loadPlugin()
  const vad = testApi.createVad({ silenceMs: 4_000, maxMs: 60_000, threshold: 0.02 })

  vad.push(0.2, 100)
  assert.equal(vad.push(0.2, 59_899).end, false)
  assert.deepEqual(JSON.parse(JSON.stringify(vad.push(0.2, 1))), { end: true, reason: 'max_duration', speechStarted: true })
})

test('integrated capture drops prolonged initial silence and preserves 60 spoken seconds plus bounded pre-roll', async () => {
  const { testApi } = loadPlugin()
  const turns = []
  let onFrame = null
  const runtime = testApi.createVoiceRuntime({
    rest: async (path, options) => {
      if (path === '/turn') turns.push(testApi.bytesToFloat32(options.upload.bytes))
      return {
        state: path === '/session/stop' ? 'shell_ready' : 'listening',
        session_id: path === '/session/stop' ? null : 's1',
        generation: 1
      }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })

  await runtime.start('')
  const oneSecondSilence = new Float32Array(16_000)
  const oneSecondSpeech = new Float32Array(16_000).fill(0.25)
  for (let second = 0; second < 30; second += 1) onFrame(oneSecondSilence, 0.001)
  for (let second = 0; second < 59; second += 1) onFrame(oneSecondSpeech, 0.25)
  assert.equal(turns.length, 0)
  onFrame(oneSecondSpeech, 0.25)
  await until(() => turns.length === 1)

  assert.equal(turns[0].length, 8_000 + 60 * 16_000)
  assert.deepEqual(Array.from(turns[0].subarray(0, 8_000)), Array(8_000).fill(0))
  assert.equal(turns[0][8_000], 0.25)
  assert.equal(turns[0].at(-1), 0.25)
  await runtime.dispose()
})

test('playback schedules chunks in arrival order and respects each sample rate', () => {
  const { testApi } = loadPlugin()
  const context = new FakeAudioContext()
  const playback = testApi.createPlaybackQueue(context, { maxQueuedSeconds: 2 })

  assert.equal(playback.enqueue(new Float32Array(24_000).fill(0.1), 24_000), true)
  assert.equal(playback.enqueue(new Float32Array(16_000).fill(0.2), 16_000), true)

  assert.deepEqual(context.buffers.map(buffer => buffer.sampleRate), [24_000, 16_000])
  assert.deepEqual(context.sources.map(source => source.starts[0]), [0.03, 1.03])
  assert.equal(playback.snapshot().queuedSeconds, 2)
})

test('playback reapplies bounded first-source lead-in after drain and interrupt', () => {
  const { testApi } = loadPlugin()
  const context = new FakeAudioContext()
  const playback = testApi.createPlaybackQueue(context, { maxQueuedSeconds: 75 })

  playback.enqueue(new Float32Array(24_000), 24_000)
  assert.equal(context.sources[0].starts[0], 0.03)
  context.currentTime = 1
  context.sources[0].onended()
  playback.enqueue(new Float32Array(24_000), 24_000)
  assert.equal(context.sources[1].starts[0], 1.03)

  context.currentTime = 2
  playback.interrupt()
  playback.enqueue(new Float32Array(24_000), 24_000)
  assert.equal(context.sources[2].starts[0], 2.03)
  assert.throws(
    () => testApi.createPlaybackQueue(context, { firstSourceLeadSeconds: 1 }),
    /lead-in/
  )
})

test('default playback accepts 60 seconds completely and rejects over 75 seconds before buffer creation', () => {
  const { testApi } = loadPlugin()
  const acceptedContext = new FakeAudioContext()
  const accepted = testApi.createPlaybackQueue(acceptedContext)
  assert.equal(accepted.enqueue(new Float32Array(60 * 24_000), 24_000), true)
  assert.equal(accepted.snapshot().queuedSeconds, 60)
  assert.equal(acceptedContext.buffers.length, 1)

  const rejectedContext = new FakeAudioContext()
  const rejected = testApi.createPlaybackQueue(rejectedContext)
  assert.equal(rejected.enqueue(new Float32Array(76 * 16_000), 16_000), false)
  assert.equal(rejectedContext.buffers.length, 0)
  assert.equal(rejected.snapshot().droppedChunks, 1)
})

test('interrupt immediately stops sources and clears playback schedule', () => {
  const { testApi } = loadPlugin()
  const context = new FakeAudioContext()
  const playback = testApi.createPlaybackQueue(context, { maxQueuedSeconds: 3 })
  playback.enqueue(new Float32Array(24_000), 24_000)
  playback.enqueue(new Float32Array(24_000), 24_000)

  playback.interrupt()

  assert.deepEqual(context.sources.map(source => source.stopped), [1, 1])
  assert.equal(playback.snapshot().sourceCount, 0)
  assert.equal(playback.snapshot().queuedSeconds, 0)
  assert.equal(playback.snapshot().nextTime, context.currentTime)
})

test('a 9.44-second multi-chunk response is scheduled completely', () => {
  const { testApi } = loadPlugin()
  const context = new FakeAudioContext()
  const playback = testApi.createPlaybackQueue(context)
  const chunkSamples = 24_000 * 2

  for (let index = 0; index < 4; index += 1) {
    assert.equal(playback.enqueue(new Float32Array(chunkSamples), 24_000), true)
  }
  assert.equal(playback.enqueue(new Float32Array(Math.round(1.44 * 24_000)), 24_000), true)

  assert.equal(context.sources.length, 5)
  assert.ok(Math.abs(playback.snapshot().queuedSeconds - 9.44) < 1e-6)
  assert.equal(playback.snapshot().droppedChunks, 0)
})

test('playback raw-byte budget fails before creating Web Audio buffers', () => {
  const { testApi } = loadPlugin()
  const context = new FakeAudioContext()
  const playback = testApi.createPlaybackQueue(context, { maxQueuedSeconds: 30, maxQueuedBytes: 16 })

  assert.equal(playback.enqueue(new Float32Array(4), 24_000), true)
  assert.equal(playback.enqueue(new Float32Array(1), 24_000), false)
  assert.equal(context.buffers.length, 1)
  assert.equal(playback.snapshot().queuedBytes, 16)
})

test('encoded and decoded audio limits are checked before atob or Float32 allocation', () => {
  let atobCalls = 0
  const { testApi } = loadPlugin({ atob: value => { atobCalls += 1; return Buffer.from(value, 'base64').toString('binary') } })

  assert.throws(() => testApi.decodeAudioBase64('A'.repeat(20), { maxDecodedBytes: 4 }), /budget/)
  assert.equal(atobCalls, 0)
  assert.throws(() => testApi.decodeAudioBase64('AAAA'), /divisible by four/)
  assert.equal(atobCalls, 0)
  assert.throws(() => testApi.decodeAudioBase64('not base64!'), /Base64/)
  assert.equal(atobCalls, 0)
})

test('blank and marker prompts reach the backend request unchanged', () => {
  const { testApi } = loadPlugin()
  const blank = testApi.buildSessionStartRequest('')
  const marker = '  MARKER\n exact  '
  const marked = testApi.buildSessionStartRequest(marker)

  assert.deepEqual(JSON.parse(JSON.stringify(blank)), {
    path: '/session/start',
    options: { method: 'POST', body: { system_prompt: '' }, timeoutMs: 130_000 }
  })
  assert.equal(marked.options.body.system_prompt, marker)
})

test('prompt UTF-8 ceiling preserves the exact boundary and atomically rejects one byte over', async () => {
  const { testApi } = loadPlugin()
  assert.equal(testApi.MAX_SYSTEM_PROMPT_BYTES, 65_536)
  const exact = ` \n${'é'.repeat(32_766)}  `
  const oversized = `${exact}x`
  assert.equal(Buffer.byteLength(exact, 'utf8'), testApi.MAX_SYSTEM_PROMPT_BYTES)
  assert.equal(Buffer.byteLength(oversized, 'utf8'), testApi.MAX_SYSTEM_PROMPT_BYTES + 1)
  assert.equal(testApi.buildSessionStartRequest(exact).options.body.system_prompt, exact)
  assert.throws(() => testApi.buildSessionStartRequest(oversized), /65,536 UTF-8 bytes/)

  const values = new Map([['userOwnedModelPrompt', '  previous  ']])
  const writes = []
  const starts = []
  const runtime = testApi.createVoiceRuntime({
    rest: async (path, options) => {
      if (path === '/session/start') starts.push(options.body.system_prompt)
      return {
        state: path === '/session/stop' ? 'shell_ready' : 'listening',
        session_id: path === '/session/stop' ? null : 's1',
        generation: 1
      }
    },
    storage: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback },
      set(key, value) { writes.push([key, value]); values.set(key, value) }
    },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })

  runtime.setSystemPrompt(exact)
  assert.equal(runtime.snapshot().systemPrompt, exact)
  assert.deepEqual(writes.at(-1), ['userOwnedModelPrompt', exact])
  assert.throws(() => runtime.setSystemPrompt(oversized), /65,536 UTF-8 bytes/)
  assert.equal(runtime.snapshot().systemPrompt, exact)
  assert.equal(values.get('userOwnedModelPrompt'), exact)
  assert.equal(writes.length, 1)
  await runtime.start()
  assert.deepEqual(starts, [exact])
  await runtime.end()
  assert.throws(() => runtime.start(oversized), /65,536 UTF-8 bytes/)
  assert.deepEqual(starts, [exact])
  assert.equal(runtime.snapshot().active, false)
  assert.equal(values.get('userOwnedModelPrompt'), exact)
  await runtime.dispose()
})

test('runtime persists the exact user-owned model prompt across lifecycles and recreation', async () => {
  const storedMarker = '  STORED MARKER\n exact  '
  const changedMarker = '\n  CHANGED MARKER  \n'
  const values = new Map([['userOwnedModelPrompt', storedMarker]])
  const writes = []
  const storage = {
    get(key, fallback) { return values.has(key) ? values.get(key) : fallback },
    set(key, value) { writes.push([key, value]); values.set(key, value) }
  }
  const diagnostics = []
  const { testApi } = loadPlugin({ console: { error: (...args) => diagnostics.push(args) } })
  const startRequests = []
  const makeRuntime = promptStorage => testApi.createVoiceRuntime({
    rest: async (path, options) => {
      if (path === '/session/start') startRequests.push(options.body.system_prompt)
      return {
        state: path === '/session/stop' ? 'shell_ready' : 'listening',
        session_id: path === '/session/stop' ? null : `s${startRequests.length}`,
        generation: startRequests.length
      }
    },
    storage: promptStorage,
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })

  const runtimeA = makeRuntime(storage)
  assert.equal(runtimeA.snapshot().systemPrompt, storedMarker)
  runtimeA.setSystemPrompt(changedMarker)
  assert.equal(runtimeA.snapshot().systemPrompt, changedMarker)
  assert.deepEqual(writes.at(-1), ['userOwnedModelPrompt', changedMarker])
  assert.doesNotMatch(JSON.stringify(diagnostics), /STORED MARKER|CHANGED MARKER/)
  await runtimeA.end()
  await runtimeA.dispose()
  assert.equal(values.get('userOwnedModelPrompt'), changedMarker)

  const runtimeB = makeRuntime(storage)
  assert.equal(runtimeB.snapshot().systemPrompt, changedMarker)
  await runtimeB.start()
  await runtimeB.interrupt()
  assert.deepEqual(startRequests, [changedMarker, changedMarker])
  runtimeB.setSystemPrompt('')
  assert.equal(values.get('userOwnedModelPrompt'), '')
  await runtimeB.dispose()

  const runtimeC = makeRuntime(storage)
  assert.equal(runtimeC.snapshot().systemPrompt, '')
  await runtimeC.dispose()

  for (const initial of [undefined, null, false, 17, {}, []]) {
    const fallbackWrites = []
    const fallbackStorage = {
      get: (_key, fallback) => initial === undefined ? fallback : initial,
      set: (key, value) => fallbackWrites.push([key, value])
    }
    const runtime = makeRuntime(fallbackStorage)
    assert.equal(runtime.snapshot().systemPrompt, '')
    assert.deepEqual(fallbackWrites, [])
    assert.doesNotMatch(runtime.snapshot().systemPrompt, /coach|assistant/i)
    await runtime.dispose()
  }
})

test('page and remount use the runtime prompt as the single authority', () => {
  const { testApi } = loadPlugin()
  const firstMarker = '  PAGE MARKER\n exact  '
  const secondMarker = '\n  REMOUNT MARKER  \n'
  let systemPrompt = firstMarker
  const setValues = []
  const startArguments = []
  const runtime = {
    snapshot: () => ({
      state: 'shell_ready', active: false, muted: false, busy: false, serverBusy: false,
      bargeIn: false, silenceMs: 4_000, assistantText: '', userTranscript: '', microphoneLevel: 0,
      metrics: {}, systemPrompt, errorMessage: '',
      server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
    }),
    subscribe: () => () => {},
    setSystemPrompt(value) { setValues.push(value); systemPrompt = value },
    setSystemPromptFromUi(value) { this.setSystemPrompt(value) },
    async start(...args) { startArguments.push(args) },
    startServer() {}, stopServer() {}, setMuted() {}, manualDone() {}, interrupt() {}, end() {},
    setSilenceMs() {}, setBargeIn() {}
  }
  const render = () => testApi.EnglishCoachPage({ runtime })

  const firstPage = render()
  const firstTextarea = descendants(firstPage).find(element => element.type === 'Textarea')
  assert.equal(firstTextarea.props.value, firstMarker)
  assert.equal(firstTextarea.props.maxLength, 65_536)
  firstTextarea.props.onChange({ target: { value: secondMarker } })
  assert.deepEqual(setValues, [secondMarker])

  const start = descendants(firstPage)
    .find(element => element.type === 'Button' && elementText(element) === 'Start')
  start.props.onClick()
  assert.deepEqual(startArguments, [[]])
  assert.equal(systemPrompt, secondMarker)

  const remountedPage = render()
  const remountedTextarea = descendants(remountedPage).find(element => element.type === 'Textarea')
  assert.equal(remountedTextarea.props.value, secondMarker)
})

test('page controls an oversized multibyte prompt change without replacing stored input', () => {
  const storedMarker = '  PREVIOUS MARKER  '
  const values = new Map([['userOwnedModelPrompt', storedMarker]])
  const writes = []
  const { testApi } = loadPlugin()
  const runtime = testApi.createVoiceRuntime({
    rest: async () => ({}),
    storage: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback },
      set(key, value) { writes.push([key, value]); values.set(key, value) }
    },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  const oversized = '界'.repeat(Math.floor(testApi.MAX_SYSTEM_PROMPT_BYTES / 3) + 1)
  const page = testApi.EnglishCoachPage({ runtime })
  const textarea = descendants(page).find(element => element.type === 'Textarea')

  assert.doesNotThrow(() => textarea.props.onChange({ target: { value: oversized } }))
  assert.equal(runtime.snapshot().systemPrompt, storedMarker)
  assert.equal(values.get('userOwnedModelPrompt'), storedMarker)
  assert.deepEqual(writes, [])
  assert.equal(runtime.snapshot().errorMessage, 'System prompt exceeds the maximum of 65,536 UTF-8 bytes.')
  const rerendered = testApi.EnglishCoachPage({ runtime })
  const alert = descendants(rerendered).find(element => element.props?.role === 'alert')
  assert.equal(elementText(alert), 'System prompt exceeds the maximum of 65,536 UTF-8 bytes.')
})

test('resource cleanup releases every tracked browser resource exactly once', async () => {
  const { testApi } = loadPlugin()
  const calls = []
  const tracker = testApi.createResourceTracker({
    clearTimeout: id => calls.push(`timer:${id}`),
    cancelAnimationFrame: id => calls.push(`raf:${id}`)
  })
  tracker.trackTrack({ stop: () => calls.push('track') })
  tracker.trackNode({ disconnect: () => calls.push('node') })
  tracker.trackSource({ stop: () => calls.push('source-stop'), disconnect: () => calls.push('source-disconnect') })
  tracker.trackContext({ close: async () => calls.push('context') })
  tracker.trackTimer(7)
  tracker.trackRaf(8)
  tracker.trackSubscription(() => calls.push('subscription'))

  await tracker.cleanup()
  await tracker.cleanup()

  assert.deepEqual(calls.sort(), [
    'context', 'node', 'raf:8', 'source-disconnect', 'source-stop',
    'subscription', 'timer:7', 'track'
  ].sort())
})

test('default capture factory cleans every partially acquired resource exactly once', async t => {
  const { testApi } = loadPlugin()
  const steps = ['getUserMedia', 'constructor', 'resume', 'mediaSource', 'processor', 'gain', 'sourceConnect', 'processorConnect', 'gainConnect']

  for (const failAt of steps) {
    await t.test(failAt, async () => {
      const track = { stops: 0, stop() { this.stops += 1 } }
      const stream = { getTracks: () => [track] }
      const nodes = []
      let context = null
      const makeNode = name => {
        const node = {
          name,
          disconnects: 0,
          gain: { value: 1 },
          connect() {
            if (failAt === `${name}Connect`) throw new Error(failAt)
          },
          disconnect() { this.disconnects += 1 }
        }
        nodes.push(node)
        return node
      }
      const mediaDevices = {
        async getUserMedia() {
          if (failAt === 'getUserMedia') throw new Error(failAt)
          return stream
        }
      }
      function AudioContextCtor() {
        if (failAt === 'constructor') throw new Error(failAt)
        context = this
        this.state = 'suspended'
        this.sampleRate = 48_000
        this.destination = {}
        this.closes = 0
        this.resume = async () => { if (failAt === 'resume') throw new Error(failAt) }
        this.close = async () => { this.closes += 1 }
        this.createMediaStreamSource = () => {
          if (failAt === 'mediaSource') throw new Error(failAt)
          return makeNode('source')
        }
        this.createScriptProcessor = () => {
          if (failAt === 'processor') throw new Error(failAt)
          return makeNode('processor')
        }
        this.createGain = () => {
          if (failAt === 'gain') throw new Error(failAt)
          return makeNode('gain')
        }
      }

      await assert.rejects(testApi.defaultCaptureFactory({
        mediaDevices,
        AudioContextCtor,
        constraints: { audio: true },
        onFrame() {}
      }), new RegExp(failAt))

      assert.equal(track.stops, failAt === 'getUserMedia' ? 0 : 1)
      if (context) assert.equal(context.closes, 1)
      assert.equal(nodes.every(node => node.disconnects === 1), true)
    })
  }
})

test('default capture and playback factory cleanup is idempotent after ownership transfer', async () => {
  const { testApi } = loadPlugin()
  const track = { stops: 0, stop() { this.stops += 1 } }
  const nodes = []
  const makeNode = () => ({ gain: { value: 1 }, connect() {}, disconnects: 0, disconnect() { this.disconnects += 1 } })
  function CaptureContext() {
    this.state = 'running'; this.sampleRate = 48_000; this.destination = {}; this.closes = 0
    this.close = async () => { this.closes += 1 }
    this.createMediaStreamSource = () => { const node = makeNode(); nodes.push(node); return node }
    this.createScriptProcessor = this.createMediaStreamSource
    this.createGain = this.createMediaStreamSource
  }
  const capture = await testApi.defaultCaptureFactory({
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    AudioContextCtor: CaptureContext,
    constraints: { audio: true },
    onFrame() {}
  })
  await capture.cleanup(); await capture.cleanup()
  assert.equal(track.stops, 1)
  assert.equal(nodes.every(node => node.disconnects === 1), true)

  let playbackContext
  function PlaybackContext() {
    playbackContext = this
    this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.closes = 0
    this.resume = async () => {}
    this.close = async () => { this.closes += 1 }
  }
  const playback = await testApi.defaultPlaybackFactory({
    AudioContextCtor: PlaybackContext,
    queueFactory: () => ({ interrupt() {}, snapshot() { return {} } })
  })
  await playback.cleanup(); await playback.cleanup()
  assert.equal(playbackContext.closes, 1)
})

test('default playback factory closes context when resume or queue construction fails', async t => {
  const { testApi } = loadPlugin()
  for (const failAt of ['constructor', 'resume', 'queue']) {
    await t.test(failAt, async () => {
      let context = null
      function AudioContextCtor() {
        if (failAt === 'constructor') throw new Error(failAt)
        context = this
        this.state = 'suspended'; this.closes = 0
        this.resume = async () => { if (failAt === 'resume') throw new Error(failAt) }
        this.close = async () => { this.closes += 1 }
      }
      await assert.rejects(testApi.defaultPlaybackFactory({
        AudioContextCtor,
        queueFactory: () => { if (failAt === 'queue') throw new Error(failAt); return {} }
      }), new RegExp(failAt))
      if (context) assert.equal(context.closes, 1)
    })
  }
})

test('pre-roll and playback queues are deterministically bounded', () => {
  const { testApi } = loadPlugin()
  const preRoll = testApi.createPreRoll(5)
  preRoll.push(new Float32Array([1, 2, 3]))
  preRoll.push(new Float32Array([4, 5, 6, 7]))
  assert.deepEqual(Array.from(preRoll.samples()), [3, 4, 5, 6, 7])
  assert.equal(preRoll.snapshot().sampleCount, 5)

  const context = new FakeAudioContext()
  const playback = testApi.createPlaybackQueue(context, { maxQueuedSeconds: 1 })
  assert.equal(playback.enqueue(new Float32Array(24_000), 24_000), true)
  assert.equal(playback.enqueue(new Float32Array(1), 24_000), false)
  assert.equal(playback.snapshot().droppedChunks, 1)
  assert.equal(playback.snapshot().queuedSeconds, 1)
})

test('registration and source policy match the native page contract', () => {
  const { plugin } = loadPlugin()
  const registrations = []
  const disposals = []
  const socketDisposals = []
  const ctx = {
    i18n: { register() {}, t: key => key },
    onDispose: fn => disposals.push(fn),
    register: contribution => registrations.push(contribution),
    rest: async () => ({}),
    socket: () => { const dispose = () => {}; socketDisposals.push(dispose); return dispose },
    storage: { get: (_key, fallback) => fallback, set() {} }
  }
  plugin.register(ctx)

  assert.equal(plugin.id, 'minicpm-native-voice')
  assert.equal(plugin.defaultEnabled, false)
  assert.equal(registrations.find(item => item.area === 'routes').data.path, '/minicpm-native-voice')
  assert.equal(registrations.find(item => item.area === 'sidebar.nav').data.label, 'English Coach')
  assert.equal(registrations.find(item => item.area === 'palette').data.id, 'minicpm-native-voice.open')
  assert.equal(disposals.length >= 1, true)

  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual([...new Set(imports)].sort(), ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'].sort())
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|\brgb\s*\(|\b(?:black|white)\b/)
  for (const label of ["Start", "Mute", "I'm done", "Interrupt", "End", "Native audio · Turn-based streaming (V2)"]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('English Coach contributes no bottom status bar item', () => {
  const { plugin } = loadPlugin()
  const registrations = []
  plugin.register({
    i18n: { register() {} },
    onDispose() {},
    register: contribution => registrations.push(contribution),
    rest: async () => ({}),
    socket: () => () => {},
    storage: { get: (_key, fallback) => fallback, set() {} }
  })

  const statusBarAreas = ['statusBar.left', 'statusBar.right']
  assert.equal(registrations.some(item => statusBarAreas.includes(item.area)), false)

  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  assert.doesNotMatch(source, /\bSTATUSBAR_AREAS\b/)
  assert.doesNotMatch(source, /\bVoiceStatus\b/)
})

test('English Coach route renders a clean title in a contained main shell without console errors', () => {
  const errors = []
  const navigations = []
  const { plugin } = loadPlugin({
    console: { ...console, error: (...parts) => errors.push(parts) },
    sdk: {
      Badge: 'Badge', Button: 'Button', Codicon: 'Codicon', Input: 'Input',
      PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar.nav',
      Switch: 'Switch', Textarea: 'Textarea', host: { navigate: path => navigations.push(path) }
    }
  })
  const registrations = []
  plugin.register({
    i18n: { register() {} },
    onDispose() {},
    register: contribution => registrations.push(contribution),
    rest: async () => ({}),
    socket: () => () => {},
    storage: { get: (_key, fallback) => fallback, set() {} }
  })

  const route = registrations.find(item => item.area === 'routes')
  const routeElement = route.render()
  const main = routeElement.type(routeElement.props)
  registrations.find(item => item.area === 'palette').data.run()
  const visibleText = value => {
    if (value === null || value === undefined || typeof value === 'boolean') return ''
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (Array.isArray(value)) return value.map(visibleText).join('')
    return visibleText(value.props?.children)
  }

  assert.equal(main.type, 'main')
  assert.match(visibleText(main), /English Coach/)
  assert.doesNotMatch(visibleText(main), /UI-DIAG|MNVOICE-DIAG/)
  assert.deepEqual(navigations, ['/minicpm-native-voice'])
  assert.deepEqual(errors, [])
  const containment = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
    boxSizing: 'border-box',
    overflow: 'auto'
  }
  for (const [property, value] of Object.entries(containment)) {
    assert.equal(main.props.style[property], value, property)
  }
})

test('turn history reconciles ids and isolates late events without deleting prior turns', async () => {
  const { testApi } = loadPlugin()
  let eventHandler = null
  let onFrame = null
  let turnNumber = 0
  const playedAudio = []
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') return { state: 'listening', session_id: 's1', generation: 1 }
      if (path === '/turn') return { state: 'thinking', session_id: 's1', generation: 1, turn_id: `turn-${++turnNumber}` }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({
      enqueue(samples, rate) { playedAudio.push([samples.length, rate]); return true },
      interrupt() {}, snapshot() { return {} }, cleanup: async () => {}
    })
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
  await runtime.start('')

  onFrame(new Float32Array(1_600).fill(0.2), 0.2)
  const firstSubmit = runtime.manualDone()
  await until(() => runtime.snapshot().turns.length === 1)
  assert.equal(runtime.snapshot().turns[0].userText, 'Native audio · 0.1 s')
  assert.equal(runtime.snapshot().turns[0].assistantText, '')
  assert.equal(runtime.snapshot().turns[0].complete, false)
  eventHandler({ type: 'turn.started', turn_id: 'turn-1', duration_seconds: 0.1, session_id: 's1', generation: 1 })
  eventHandler({ type: 'turn.started', turn_id: 'turn-1', duration_seconds: 0.1, session_id: 's1', generation: 1 })
  await firstSubmit
  assert.equal(runtime.snapshot().turns.length, 1)
  assert.equal(runtime.snapshot().turns[0].id, 'turn-1')

  eventHandler({ type: 'text.delta', turn_id: 'turn-1', text: 'First', session_id: 's1', generation: 1 })
  eventHandler({ type: 'response.done', turn_id: 'turn-1', text: 'First complete', session_id: 's1', generation: 1 })
  eventHandler({ type: 'text.delta', turn_id: 'turn-1', text: ' stale tail', session_id: 's1', generation: 1 })
  assert.equal(runtime.snapshot().turns[0].assistantText, 'First complete')
  eventHandler({ type: 'audio.delta', turn_id: 'turn-1', audio: 'AAAAAA==', sample_rate: 24_000, session_id: 's1', generation: 1 })
  assert.equal(playedAudio.length, 0)
  eventHandler({ type: 'response.done', turn_id: 'turn-1', text: 'duplicate rewrite', session_id: 's1', generation: 1 })
  assert.equal(runtime.snapshot().turns[0].assistantText, 'First complete')

  onFrame(new Float32Array(3_200).fill(0.2), 0.2)
  await runtime.manualDone()
  eventHandler({ type: 'turn.started', turn_id: 'turn-2', duration_seconds: 0.2, session_id: 's1', generation: 1 })
  eventHandler({ type: 'text.delta', turn_id: 'turn-2', text: 'Second', session_id: 's1', generation: 1 })
  eventHandler({ type: 'user.transcript', turn_id: 'turn-1', text: 'what I first said', provider: 'local', session_id: 's1', generation: 1 })

  const view = runtime.snapshot()
  assert.deepEqual(JSON.parse(JSON.stringify(view.turns)), [
    { id: 'turn-1', userText: 'what I first said', assistantText: 'First complete', complete: true },
    { id: 'turn-2', userText: 'Native audio · 0.2 s', assistantText: 'Second', complete: false }
  ])
  assert.equal(view.assistantText, 'Second')
  assert.equal(view.userTranscript, 'Native audio · 0.2 s')
  await runtime.end()
  assert.equal(runtime.snapshot().turns.length, 2)
  await runtime.dispose()
})

test('turn history is capped at 100 turns and each text field is UTF-8 bounded', async () => {
  const { testApi } = loadPlugin()
  let eventHandler = null
  let onFrame = null
  let turnNumber = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') return { state: 'listening', session_id: 's1', generation: 1 }
      if (path === '/turn') return { state: 'thinking', session_id: 's1', generation: 1, turn_id: `turn-${++turnNumber}` }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({ enqueue() { return true }, interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
  await runtime.start('')

  for (let index = 1; index <= 101; index += 1) {
    onFrame(new Float32Array(16).fill(0.2), 0.2)
    await runtime.manualDone()
    eventHandler({ type: 'response.done', turn_id: `turn-${index}`, text: index === 101 ? 'é'.repeat(40_000) : `answer-${index}`, session_id: 's1', generation: 1 })
  }

  const turns = runtime.snapshot().turns
  assert.equal(turns.length, 100)
  assert.equal(turns[0].id, 'turn-2')
  assert.equal(turns.at(-1).id, 'turn-101')
  assert.equal(Buffer.byteLength(turns.at(-1).assistantText, 'utf8'), 65_536)
  await runtime.dispose()
})

test('turn history evicts oldest completed turns to stay within a 1 MiB total UTF-8 budget', async () => {
  const { testApi } = loadPlugin()
  let eventHandler = null
  let onFrame = null
  let turnNumber = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') return { state: 'listening', session_id: 's1', generation: 1 }
      if (path === '/turn') return { state: 'thinking', session_id: 's1', generation: 1, turn_id: `turn-${++turnNumber}` }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({ enqueue() { return true }, interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
  await runtime.start('')

  const field = 'é'.repeat(32_768)
  for (let index = 1; index <= 9; index += 1) {
    onFrame(new Float32Array(16).fill(0.2), 0.2)
    await runtime.manualDone()
    if (index === 9) {
      const pending = runtime.snapshot().turns.at(-1)
      assert.equal(pending.id, 'turn-9')
      assert.equal(pending.complete, false)
    }
    eventHandler({ type: 'user.transcript', turn_id: `turn-${index}`, text: field, provider: 'local', session_id: 's1', generation: 1 })
    eventHandler({ type: 'response.done', turn_id: `turn-${index}`, text: field, session_id: 's1', generation: 1 })
  }

  const turns = runtime.snapshot().turns
  const totalTextBytes = turns.reduce(
    (total, turn) => total + Buffer.byteLength(turn.userText + turn.assistantText, 'utf8'),
    0
  )
  assert.equal(turns.length, 8)
  assert.equal(turns[0].id, 'turn-2')
  assert.equal(turns.at(-1).id, 'turn-9')
  assert.equal(totalTextBytes, 1024 * 1024)
  await runtime.dispose()
})

test('turn history evicts stale incomplete turns before the active pending turn', async () => {
  const { testApi } = loadPlugin()
  let eventHandler = null
  let onFrame = null
  let turnNumber = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') return { state: 'listening', session_id: 's1', generation: 1 }
      if (path === '/turn') return { state: 'thinking', session_id: 's1', generation: 1, turn_id: `turn-${++turnNumber}` }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
  await runtime.start('')

  const field = 'x'.repeat(65_536)
  for (let index = 1; index <= 9; index += 1) {
    onFrame(new Float32Array(16).fill(0.2), 0.2)
    await runtime.manualDone()
    eventHandler({ type: 'user.transcript', turn_id: `turn-${index}`, text: field, provider: 'local', session_id: 's1', generation: 1 })
    eventHandler({ type: 'text.delta', turn_id: `turn-${index}`, text: field, session_id: 's1', generation: 1 })
    if (index < 9) eventHandler({ type: 'state', state: 'listening', session_id: 's1', generation: 1 })
  }

  const turns = runtime.snapshot().turns
  const totalTextBytes = turns.reduce(
    (total, turn) => total + Buffer.byteLength(turn.userText + turn.assistantText, 'utf8'),
    0
  )
  assert.equal(turns.length, 8)
  assert.equal(turns[0].id, 'turn-2')
  assert.equal(turns.at(-1).id, 'turn-9')
  assert.equal(turns.at(-1).complete, false)
  assert.equal(totalTextBytes, 1024 * 1024)
  await runtime.dispose()
})

test('repeated failed submissions stay within the 100-turn and 1 MiB text budgets', async () => {
  const { testApi } = loadPlugin()
  let eventHandler = null
  let onFrame = null
  let starts = 0
  let turnCalls = 0
  let turnResponse = null
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') {
        starts += 1
        return { state: 'listening', session_id: `s${starts}`, generation: starts }
      }
      if (path === '/turn') {
        turnCalls += 1
        return turnResponse.promise
      }
      return { state: 'shell_ready', session_id: null, generation: starts + 1 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })

  const field = 'y'.repeat(65_536)
  let maxTurnCount = 0
  for (let index = 1; index <= 101; index += 1) {
    await runtime.start('')
    onFrame(new Float32Array(16).fill(0.2), 0.2)
    turnResponse = deferred()
    const submitting = runtime.manualDone()
    await until(() => turnCalls === index)
    maxTurnCount = Math.max(maxTurnCount, runtime.snapshot().turns.length)
    eventHandler({ type: 'turn.started', turn_id: `turn-${index}`, session_id: `s${index}`, generation: index })
    if (index >= 93) {
      eventHandler({ type: 'user.transcript', turn_id: `turn-${index}`, text: field, provider: 'local', session_id: `s${index}`, generation: index })
      eventHandler({ type: 'text.delta', turn_id: `turn-${index}`, text: field, session_id: `s${index}`, generation: index })
    }
    turnResponse.reject(new Error(`turn ${index} failed`))
    await assert.rejects(submitting, new RegExp(`turn ${index} failed`))

    const view = runtime.snapshot()
    const totalTextBytes = view.turns.reduce(
      (total, turn) => total + Buffer.byteLength(turn.userText + turn.assistantText, 'utf8'),
      0
    )
    assert.ok(view.turns.length <= 100)
    assert.ok(totalTextBytes <= 1024 * 1024)
    assert.equal(view.turns.at(-1).complete, true)
  }

  assert.equal(maxTurnCount, 100)
  assert.equal(runtime.snapshot().turns.at(-1).id, 'turn-101')
  assert.equal(runtime.snapshot().turns.at(-1).assistantText, field)
  await runtime.dispose()
})

test('chat history renders chronological user-right and assistant-left bubbles in a stable scroll shell', () => {
  const { testApi } = loadPlugin()
  const view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, assistantText: '', userTranscript: '', microphoneLevel: 0,
    turns: [
      { id: 'turn-1', userText: 'hello', assistantText: 'Hi there', complete: true },
      { id: 'turn-2', userText: 'Native audio · 1.2 s', assistantText: '', complete: false }
    ],
    metrics: { privateShape: 1 }, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const page = testApi.EnglishCoachPage({
    runtime: {
      snapshot: () => view, subscribe: () => () => {}, startServer() {}, stopServer() {}, start() {},
      setMuted() {}, manualDone() {}, interrupt() {}, end() {}, setSilenceMs() {}, setBargeIn() {}
    }
  })
  const history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const bubbles = descendants(history).filter(element => element.props?.['data-bubble-side'])

  assert.equal(history.props.style.overflowY, 'auto')
  assert.equal(history.props.style.minHeight, 0)
  assert.deepEqual(bubbles.map(element => [
    element.props['data-turn-id'], element.props['data-bubble-side'], element.props['aria-label'], elementText(element)
  ]), [
    ['turn-1', 'right', 'User turn turn-1', 'hello'],
    ['turn-1', 'left', 'Assistant turn turn-1', 'Hi there'],
    ['turn-2', 'right', 'User turn turn-2', 'Native audio · 1.2 s'],
    ['turn-2', 'left', 'Assistant turn turn-2', 'Thinking…']
  ])
  assert.doesNotMatch(elementText(history), /privateShape|\{"/)
})

test('a newly appended turn scrolls only the conversation history node to its bottom', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let outerScrollCalls = 0
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [{ id: 'turn-1', userText: 'hello', assistantText: 'Hi', complete: true }],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id),
    scrollTo: () => { outerScrollCalls += 1 }
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  let history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 12, scrollHeight: 240, clientHeight: 100 }
  history.props.ref.current = historyNode
  view = {
    ...view,
    turns: [
      ...view.turns,
      { id: 'turn-2', userText: 'new question', assistantText: '', complete: false }
    ]
  }
  listener(view)
  page = renderer.render()
  history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  historyNode.scrollHeight = 360
  raf.flush()

  assert.equal(historyNode.scrollTop, 360)
  assert.equal(outerScrollCalls, 0)
  renderer.unmount()
})

test('the newest assistant draft growth follows the conversation bottom while pinned', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [{ id: 'turn-1', userText: 'hello', assistantText: 'Draft', complete: false }],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id)
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  const history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 152, scrollHeight: 300, clientHeight: 100 }
  history.props.ref.current = historyNode
  history.props.onScroll({ currentTarget: historyNode })
  view = {
    ...view,
    turns: [{ ...view.turns[0], assistantText: 'Draft with another streamed sentence.' }]
  }
  listener(view)
  page = renderer.render()
  historyNode.scrollHeight = 420
  raf.flush()

  assert.equal(historyNode.scrollTop, 420)
  renderer.unmount()
})

test('manual upward history scrolling disables follow for later draft growth', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [{ id: 'turn-1', userText: 'hello', assistantText: 'Draft', complete: false }],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id)
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  let history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 100, scrollHeight: 400, clientHeight: 100 }
  history.props.ref.current = historyNode
  history.props.onScroll({ currentTarget: historyNode })
  view = {
    ...view,
    turns: [{ ...view.turns[0], assistantText: 'Draft with another streamed sentence.' }]
  }
  listener(view)
  page = renderer.render()
  history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  historyNode.scrollHeight = 460
  raf.flush()

  assert.equal(historyNode.scrollTop, 100)
  assert.equal(raf.pending(), 0)
  renderer.unmount()
})

test('manual upward scrolling wins over an already queued draft-follow frame', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [{ id: 'turn-1', userText: 'hello', assistantText: 'Draft', complete: false }],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id)
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  let history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 200, scrollHeight: 300, clientHeight: 100 }
  history.props.ref.current = historyNode
  history.props.onScroll({ currentTarget: historyNode })
  view = {
    ...view,
    turns: [{ ...view.turns[0], assistantText: 'Draft with another streamed sentence.' }]
  }
  listener(view)
  page = renderer.render()
  history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  historyNode.scrollTop = 80
  historyNode.scrollHeight = 460
  history.props.onScroll({ currentTarget: historyNode })
  raf.flush()

  assert.equal(historyNode.scrollTop, 80)
  renderer.unmount()
})

test('a newly appended turn re-arms history follow after manual upward scrolling', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [{ id: 'turn-1', userText: 'hello', assistantText: 'First answer', complete: true }],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id)
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  let history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 80, scrollHeight: 400, clientHeight: 100 }
  history.props.ref.current = historyNode
  history.props.onScroll({ currentTarget: historyNode })
  view = {
    ...view,
    turns: [...view.turns, { id: 'turn-2', userText: 'next', assistantText: '', complete: false }]
  }
  listener(view)
  page = renderer.render()
  historyNode.scrollHeight = 500
  raf.flush()
  assert.equal(historyNode.scrollTop, 500)

  view = {
    ...view,
    turns: [view.turns[0], { ...view.turns[1], assistantText: 'Streaming answer' }]
  }
  listener(view)
  page = renderer.render()
  historyNode.scrollHeight = 540
  raf.flush()

  assert.equal(historyNode.scrollTop, 540)
  renderer.unmount()
})

test('a late update to an older turn does not scroll unpinned history', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [
      { id: 'turn-1', userText: 'audio', assistantText: 'First answer', complete: true },
      { id: 'turn-2', userText: 'next', assistantText: 'Draft', complete: false }
    ],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id)
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  const history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 90, scrollHeight: 430, clientHeight: 100 }
  history.props.ref.current = historyNode
  history.props.onScroll({ currentTarget: historyNode })
  view = {
    ...view,
    turns: [{ ...view.turns[0], userText: 'late transcript' }, view.turns[1]]
  }
  listener(view)
  page = renderer.render()
  historyNode.scrollHeight = 450
  raf.flush()

  assert.equal(historyNode.scrollTop, 90)
  assert.equal(raf.pending(), 0)
  renderer.unmount()
})

test('reconciling the latest turn id does not re-arm unpinned history', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [{ id: 'local-1', userText: 'audio', assistantText: '', complete: false }],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id)
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  const history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 75, scrollHeight: 400, clientHeight: 100 }
  history.props.ref.current = historyNode
  history.props.onScroll({ currentTarget: historyNode })
  view = { ...view, turns: [{ ...view.turns[0], id: 'turn-1' }] }
  listener(view)
  page = renderer.render()
  historyNode.scrollHeight = 420
  raf.flush()

  assert.equal(historyNode.scrollTop, 75)
  assert.equal(raf.pending(), 0)
  renderer.unmount()
})

test('unmount cancels owned history animation frames and subscription', () => {
  const renderer = createHookRenderer()
  const raf = createRafHarness()
  let listener = null
  let view = {
    state: 'thinking', active: true, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, microphoneLevel: 0,
    turns: [{ id: 'turn-1', userText: 'hello', assistantText: 'Draft', complete: false }],
    metrics: {}, systemPrompt: '', errorMessage: '',
    server: { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
  }
  const runtime = {
    snapshot: () => view,
    subscribe(callback) { listener = callback; return () => { listener = null } },
    startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {},
    end() {}, setSilenceMs() {}, setBargeIn() {}
  }
  const { testApi } = loadPlugin({
    react: renderer.react,
    requestAnimationFrame: callback => raf.requestAnimationFrame(callback),
    cancelAnimationFrame: id => raf.cancelAnimationFrame(id)
  })

  let page = renderer.render(testApi.EnglishCoachPage, { runtime })
  const history = descendants(page).find(element => element.props?.['aria-label'] === 'Conversation history')
  const historyNode = { scrollTop: 200, scrollHeight: 300, clientHeight: 100 }
  history.props.ref.current = historyNode
  view = {
    ...view,
    turns: [{ ...view.turns[0], assistantText: 'A longer draft' }]
  }
  listener(view)
  page = renderer.render()
  historyNode.scrollHeight = 380

  assert.equal(raf.pending(), 1)
  renderer.unmount()
  assert.equal(raf.pending(), 0)
  assert.equal(listener, null)
  raf.flush()
  assert.equal(historyNode.scrollTop, 200)
})

test('utterance accumulator caps at 60-second capacity without dropping its beginning', () => {
  const { testApi } = loadPlugin()
  const capture = testApi.createCaptureAccumulator(5)
  assert.equal(capture.append(new Float32Array([1, 2, 3])), false)
  assert.equal(capture.append(new Float32Array([4, 5, 6, 7])), true)
  assert.deepEqual(Array.from(capture.samples()), [1, 2, 3, 4, 5])
  assert.deepEqual(JSON.parse(JSON.stringify(capture.snapshot())), { sampleCount: 5, maxSamples: 5, full: true })
})

test('voice runtime owns exact REST, interruption, event, fallback, and cleanup lifecycle', async () => {
  const { testApi } = loadPlugin()
  const log = []
  let eventHandler = null
  let pollCallback = null
  let onFrame = null
  let captureCleanups = 0
  const rest = async (path, options) => {
    log.push({ kind: 'rest', path, options })
    if (path === '/status') return { state: 'listening', session_id: 's1', generation: 1, turn_id: null, metrics: {} }
    if (path === '/turn') return { state: 'thinking', session_id: 's1', generation: 1, turn_id: 'turn-1', metrics: {} }
    return { state: path === '/session/stop' ? 'shell_ready' : 'listening', session_id: 's1', generation: 1, turn_id: null, metrics: {} }
  }
  const playback = {
    enqueued: [],
    interrupted: 0,
    enqueue(samples, rate) { this.enqueued.push([Array.from(samples), rate]); return true },
    interrupt() { this.interrupted += 1 },
    snapshot() { return { queuedSeconds: 0, droppedChunks: 0 } }
  }
  const runtime = testApi.createVoiceRuntime({
    rest,
    storage: { get: (_key, fallback) => fallback, set: (key, value) => log.push({ kind: 'storage', key, value }) },
    captureFactory: async options => {
      log.push({ kind: 'capture', constraints: options.constraints })
      onFrame = options.onFrame
      return { cleanup: async () => { captureCleanups += 1 } }
    },
    playbackFactory: () => playback,
    setIntervalFn: callback => { pollCallback = callback; return 91 },
    clearIntervalFn: id => log.push({ kind: 'clearInterval', id })
  })
  runtime.bindSocket((_path, handler) => {
    eventHandler = handler
    return () => log.push({ kind: 'socketDispose' })
  })
  runtime.startPolling()

  const marker = '  USER MARKER\n exact  '
  await runtime.start(marker)
  assert.deepEqual(log.find(item => item.kind === 'storage'), {
    kind: 'storage', key: 'userOwnedModelPrompt', value: marker
  })
  const firstRest = log.find(item => item.kind === 'rest')
  assert.equal(firstRest.path, '/session/start')
  assert.equal(firstRest.options.body.system_prompt, marker)
  assert.deepEqual(JSON.parse(JSON.stringify(log.find(item => item.kind === 'capture').constraints)), {
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })

  onFrame(new Float32Array(160).fill(0.2), 0.2)
  await runtime.manualDone()
  eventHandler({ type: 'audio.delta', turn_id: 'turn-1', audio: 'AAAAAA==', sample_rate: 16_000, session_id: 's1', generation: 1 })
  assert.equal(playback.enqueued.length, 1)
  assert.equal(playback.enqueued[0][1], 16_000)
  eventHandler({ type: 'text.delta', turn_id: 'turn-1', text: 'Hello', session_id: 's1', generation: 1 })
  eventHandler({ type: 'response.done', turn_id: 'turn-1', text: 'Hello', session_id: 's1', generation: 1 })
  assert.equal(runtime.snapshot().assistantText, 'Hello')
  assert.equal(runtime.snapshot().state, 'listening')

  await runtime.interrupt()
  const paths = log.filter(item => item.kind === 'rest').map(item => item.path)
  assert.deepEqual(paths.slice(-2), ['/session/stop', '/session/start'])
  assert.equal(log.filter(item => item.path === '/session/start').at(-1).options.body.system_prompt, marker)
  assert.equal(playback.interrupted >= 1, true)

  await pollCallback()
  assert.equal(log.filter(item => item.path === '/status').length, 1)
  await runtime.dispose()
  await runtime.dispose()
  assert.equal(captureCleanups, 1)
  assert.equal(log.filter(item => item.kind === 'socketDispose').length, 1)
  assert.deepEqual(log.filter(item => item.kind === 'clearInterval'), [{ kind: 'clearInterval', id: 91 }])
})

test('response completion waits for delayed local playback drain before listening', async () => {
  const { testApi } = loadPlugin()
  const context = new FakeAudioContext()
  let eventHandler = null
  let onFrame = null
  let turnNumber = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => ({
      state: path === '/session/stop' ? 'shell_ready' : 'listening',
      session_id: path === '/session/stop' ? null : 's1',
      generation: 1,
      turn_id: path === '/turn' ? `turn-${++turnNumber}` : null
    }),
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => testApi.createPlaybackQueue(context)
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
  await runtime.start('')

  onFrame(new Float32Array(160).fill(0.2), 0.2)
  await runtime.manualDone()
  eventHandler({ type: 'audio.delta', turn_id: 'turn-1', audio: 'AAAAAA==', sample_rate: 16_000, session_id: 's1', generation: 1 })
  eventHandler({ type: 'response.done', turn_id: 'turn-1', text: 'complete upstream', session_id: 's1', generation: 1 })

  assert.equal(runtime.snapshot().state, 'speaking')
  assert.equal(context.sources.length, 1)
  eventHandler({ type: 'state', state: 'listening', session_id: 's1', generation: 1 })
  assert.equal(runtime.snapshot().state, 'speaking')
  context.sources[0].onended()
  await until(() => runtime.snapshot().state === 'listening')
  assert.equal(runtime.snapshot().playback.sourceCount, 0)

  onFrame(new Float32Array(160).fill(0.2), 0.2)
  await runtime.manualDone()
  eventHandler({ type: 'audio.delta', turn_id: 'turn-2', audio: 'AAAAAA==', sample_rate: 16_000, session_id: 's1', generation: 1 })
  eventHandler({ type: 'response.done', turn_id: 'turn-2', text: 'interrupt locally', session_id: 's1', generation: 1 })
  assert.equal(runtime.snapshot().state, 'speaking')
  await runtime.interrupt()
  assert.equal(context.sources[1].stopped, 1)
  assert.equal(runtime.snapshot().state, 'listening')
  await runtime.dispose()
})

test('Start synchronously primes one playback initialization shared by duplicate calls', async () => {
  const { testApi } = loadPlugin()
  const playbackReady = deferred()
  const started = deferred()
  let playbackFactories = 0
  let starts = 0
  let captures = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') { starts += 1; return started.promise }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => { captures += 1; return { cleanup: async () => {} } },
    playbackFactory: () => {
      playbackFactories += 1
      return playbackReady.promise
    }
  })

  const first = runtime.start('one')
  assert.equal(playbackFactories, 1)
  const second = runtime.start('two')
  assert.equal(playbackFactories, 1)
  assert.equal(starts, 0)

  playbackReady.resolve({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  await until(() => starts === 1)
  assert.equal(starts, 1)
  started.resolve({ state: 'listening', session_id: 's1', generation: 1 })
  const [a, b] = await Promise.all([first, second])

  assert.equal(starts, 1)
  assert.equal(captures, 1)
  assert.equal(a.session_id, 's1')
  assert.equal(b.session_id, 's1')
  await runtime.dispose()
})

test('synchronous playback factory failures reject Start and enter controlled error state', async () => {
  const { testApi } = loadPlugin()
  let restCalls = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async () => { restCalls += 1; return {} },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: () => { throw new Error('playback exploded') }
  })

  let starting
  assert.doesNotThrow(() => { starting = runtime.start('') })
  await assert.rejects(starting, /playback exploded/)

  assert.equal(restCalls, 0)
  assert.equal(runtime.snapshot().state, 'error')
  assert.match(runtime.snapshot().errorMessage, /playback exploded/)
  await runtime.dispose()
})

test('Normal Start emits no console errors or publication diagnostics', async () => {
  const errors = []
  const { testApi } = loadPlugin({
    console: {
      ...console,
      error: (...parts) => errors.push(parts)
    }
  })
  const runtime = testApi.createVoiceRuntime({
    rest: async path => path === '/session/start'
      ? { state: 'listening', session_id: 's1', generation: 1 }
      : { state: 'shell_ready', session_id: null, generation: 2 },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  const secretPrompt = 'PROMPT-MUST-NOT-BE-LOGGED'

  await runtime.start(secretPrompt)

  assert.deepEqual(errors, [])
  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  assert.doesNotMatch(source, /UI[-_]DIAG|MNVOICE-DIAG|console\.error/)
  await runtime.dispose()
})

test('Dispose during Start before REST resolves cancels continuation and closes created backend', async () => {
  const { testApi } = loadPlugin()
  const started = deferred()
  const paths = []
  let captures = 0
  let playbackCleanups = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      paths.push(path)
      if (path === '/session/start') return started.promise
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => { captures += 1; return { cleanup: async () => {} } },
    playbackFactory: async () => ({
      interrupt() {}, snapshot() { return {} }, cleanup: async () => { playbackCleanups += 1 }
    })
  })

  const starting = runtime.start('')
  await until(() => paths.includes('/session/start'))
  const disposing = runtime.dispose()
  started.resolve({ state: 'listening', session_id: 'stale', generation: 1 })
  await Promise.allSettled([starting, disposing])

  assert.equal(paths.filter(path => path === '/session/start').length, 1)
  assert.equal(paths.filter(path => path === '/session/stop').length, 1)
  assert.equal(captures, 0)
  assert.equal(playbackCleanups, 1)
  assert.equal(runtime.snapshot().active, false)
  assert.equal(runtime.snapshot().state, 'shell_ready')
})

test('Dispose between session success and capture success releases late capture once', async () => {
  const { testApi } = loadPlugin()
  const captureReady = deferred()
  const paths = []
  let captureCalls = 0
  let captureCleanups = 0
  let playbackCleanups = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      paths.push(path)
      if (path === '/session/start') return { state: 'listening', session_id: 'stale', generation: 1 }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => { captureCalls += 1; return captureReady.promise },
    playbackFactory: async () => ({
      interrupt() {}, snapshot() { return {} }, cleanup: async () => { playbackCleanups += 1 }
    })
  })

  const starting = runtime.start('')
  await until(() => captureCalls === 1)
  const disposing = runtime.dispose()
  captureReady.resolve({ cleanup: async () => { captureCleanups += 1 } })
  await Promise.allSettled([starting, disposing])

  assert.equal(paths.filter(path => path === '/session/stop').length, 1)
  assert.equal(captureCleanups, 1)
  assert.equal(playbackCleanups, 1)
  assert.equal(runtime.snapshot().active, false)
})

test('End and Dispose clean late eagerly-primed playback once without resurrecting Start', async t => {
  for (const cancellation of ['end', 'dispose']) {
    await t.test(cancellation, async () => {
      const { testApi } = loadPlugin()
      const playbackReady = deferred()
      let playbackFactories = 0
      let playbackCleanups = 0
      let restCalls = 0
      let captureCalls = 0
      const runtime = testApi.createVoiceRuntime({
        rest: async () => { restCalls += 1; return { session_id: 's1', generation: 1 } },
        storage: { get: (_key, fallback) => fallback, set() {} },
        captureFactory: async () => { captureCalls += 1; return { cleanup: async () => {} } },
        playbackFactory: () => {
          playbackFactories += 1
          return playbackReady.promise
        }
      })

      const starting = runtime.start('')
      assert.equal(playbackFactories, 1)
      const cancelling = runtime[cancellation]()
      playbackReady.resolve({
        interrupt() {},
        snapshot() { return { installed: true } },
        cleanup: async () => { playbackCleanups += 1 }
      })
      await Promise.allSettled([starting, cancelling])

      assert.equal(playbackCleanups, 1)
      assert.equal(restCalls, 0)
      assert.equal(captureCalls, 0)
      assert.equal(runtime.snapshot().playback.installed, undefined)
      assert.equal(runtime.snapshot().active, false)
      if (cancellation === 'dispose') await assert.rejects(runtime.start(''), /disposed/)
      else await runtime.dispose()
    })
  }
})

test('Interrupt x2 is serialized through one lifecycle lane', async () => {
  const { testApi } = loadPlugin()
  const firstStop = deferred()
  const paths = []
  let starts = 0
  let stops = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      paths.push(path)
      if (path === '/session/start') {
        starts += 1
        return { state: 'listening', session_id: `s${starts}`, generation: starts }
      }
      if (path === '/session/stop') {
        stops += 1
        if (stops === 1) await firstStop.promise
      }
      return { state: 'shell_ready', session_id: null, generation: starts + 1 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  await runtime.start('')

  const one = runtime.interrupt()
  const two = runtime.interrupt()
  await until(() => stops === 1)
  assert.equal(stops, 1)
  firstStop.resolve()
  await Promise.all([one, two])

  assert.deepEqual(paths, ['/session/start', '/session/stop', '/session/start', '/session/stop', '/session/start'])
  await runtime.dispose()
})

test('End cancels an in-flight Interrupt before it can restart', async () => {
  const { testApi } = loadPlugin()
  const stopping = deferred()
  const paths = []
  let starts = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      paths.push(path)
      if (path === '/session/start') return { state: 'listening', session_id: `s${++starts}`, generation: starts }
      if (path === '/session/stop') await stopping.promise
      return { state: 'shell_ready', session_id: null, generation: starts + 1 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  await runtime.start('')
  const interrupting = runtime.interrupt()
  await until(() => paths.filter(path => path === '/session/stop').length === 1)
  const ending = runtime.end()
  stopping.resolve()
  await Promise.allSettled([interrupting, ending])

  assert.equal(starts, 1)
  assert.equal(paths.filter(path => path === '/session/stop').length, 1)
  assert.equal(runtime.snapshot().active, false)
})

test('automatic barge-in is cancelled by End without restarting', async () => {
  const { testApi } = loadPlugin()
  const stopping = deferred()
  let onFrame = null
  let eventHandler = null
  let starts = 0
  let stops = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') return { state: 'listening', session_id: `s${++starts}`, generation: starts }
      if (path === '/session/stop') { stops += 1; await stopping.promise }
      return { state: 'shell_ready', session_id: null, generation: starts + 1 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
  runtime.setBargeIn(true)
  await runtime.start('')
  eventHandler({ type: 'state', state: 'speaking', session_id: 's1', generation: 1 })
  onFrame(new Float32Array(4_800).fill(0.2), 0.2)
  await until(() => stops === 1)
  const ending = runtime.end()
  stopping.resolve()
  await ending

  assert.equal(starts, 1)
  assert.equal(stops, 1)
  assert.equal(runtime.snapshot().active, false)
})

test('stale socket events and stale poll completions cannot alter a restarted session', async () => {
  const { testApi } = loadPlugin()
  const stalePoll = deferred()
  let eventHandler = null
  let pollCallback = null
  let starts = 0
  const playback = { enqueued: 0, enqueue() { this.enqueued += 1; return true }, interrupt() {}, snapshot() { return {} }, cleanup: async () => {} }
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/status') return stalePoll.promise
      if (path === '/session/start') return { state: 'listening', session_id: `s${++starts}`, generation: starts }
      return { state: 'shell_ready', session_id: null, generation: starts + 1 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => ({ cleanup: async () => {} }),
    playbackFactory: async () => playback,
    setIntervalFn: callback => { pollCallback = callback; return 7 },
    clearIntervalFn() {}
  })
  runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
  runtime.startPolling()
  await runtime.start('')
  const polling = pollCallback()
  await runtime.interrupt()

  eventHandler({ type: 'text.delta', text: 'OLD', session_id: 's1', generation: 1 })
  eventHandler({ type: 'audio.delta', audio: 'AAAAAA==', sample_rate: 16_000, session_id: 's1', generation: 1 })
  eventHandler({ type: 'state', state: 'error', session_id: 's1', generation: 1 })
  stalePoll.resolve({ state: 'error', session_id: 's1', generation: 1, metrics: { stale: true } })
  await polling

  assert.equal(runtime.snapshot().session_id, 's2')
  assert.equal(runtime.snapshot().state, 'listening')
  assert.equal(runtime.snapshot().assistantText, '')
  assert.equal(playback.enqueued, 0)
  assert.equal(runtime.snapshot().metrics.stale, undefined)
  await runtime.dispose()
})

test('current-generation polling surfaces backend error after the backend clears its session id', async () => {
  const { testApi } = loadPlugin()
  let pollCallback = null
  let captureCleanups = 0
  let playbackCleanups = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') return { state: 'listening', session_id: 's1', generation: 1 }
      if (path === '/status') return { state: 'error', session_id: null, generation: 1, metrics: {} }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => ({ cleanup: async () => { captureCleanups += 1 } }),
    playbackFactory: async () => ({
      enqueue() { return true }, interrupt() {}, snapshot() { return {} },
      cleanup: async () => { playbackCleanups += 1 }
    }),
    setIntervalFn: callback => { pollCallback = callback; return 7 },
    clearIntervalFn() {}
  })
  runtime.startPolling()
  await runtime.start('')

  await pollCallback()
  await until(() => captureCleanups === 1 && playbackCleanups === 1)

  assert.equal(runtime.snapshot().state, 'error')
  assert.equal(runtime.snapshot().active, false)
  assert.match(runtime.snapshot().errorMessage, /backend reported error/)
  assert.equal(playbackCleanups, 1)
  await runtime.dispose()
})

test('End and Interrupt during a pending submit terminalize its bubble and preserve partial text', async t => {
  for (const action of ['end', 'interrupt']) {
    await t.test(action, async () => {
      const { testApi } = loadPlugin()
      const turnResponse = deferred()
      let eventHandler = null
      let onFrame = null
      let starts = 0
      const runtime = testApi.createVoiceRuntime({
        rest: async path => {
          if (path === '/session/start') {
            starts += 1
            return { state: 'listening', session_id: `s${starts}`, generation: starts }
          }
          if (path === '/turn') return turnResponse.promise
          return { state: 'shell_ready', session_id: null, generation: starts + 1 }
        },
        storage: { get: (_key, fallback) => fallback, set() {} },
        captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
        playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
      })
      runtime.bindSocket((_path, handler) => { eventHandler = handler; return () => {} })
      await runtime.start('')
      onFrame(new Float32Array(1_600).fill(0.2), 0.2)

      const submitting = runtime.manualDone()
      await until(() => runtime.snapshot().turns.length === 1)
      eventHandler({ type: 'turn.started', turn_id: 'turn-1', session_id: 's1', generation: 1 })
      if (action === 'interrupt') {
        eventHandler({ type: 'text.delta', turn_id: 'turn-1', text: 'Partial answer', session_id: 's1', generation: 1 })
      }
      const cancelling = runtime[action]()
      await until(() => runtime.snapshot().turns[0].complete, `${action} did not terminalize the pending turn`)
      assert.equal(
        runtime.snapshot().turns[0].assistantText,
        action === 'interrupt' ? 'Partial answer' : 'Turn interrupted.'
      )
      turnResponse.resolve({ state: 'thinking', session_id: 's1', generation: 1, turn_id: 'turn-1' })
      await Promise.all([submitting, cancelling])

      const turn = runtime.snapshot().turns[0]
      assert.equal(turn.complete, true)
      assert.equal(turn.assistantText, action === 'interrupt' ? 'Partial answer' : 'Turn interrupted.')
      if (action === 'interrupt') await runtime.end()
      await runtime.dispose()
    })
  }
})

test('End terminalizes a pending turn after its submission was accepted', async () => {
  const { testApi } = loadPlugin()
  let onFrame = null
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/session/start') return { state: 'listening', session_id: 's1', generation: 1 }
      if (path === '/turn') return { state: 'thinking', session_id: 's1', generation: 1, turn_id: 'turn-1' }
      return { state: 'shell_ready', session_id: null, generation: 2 }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => { onFrame = options.onFrame; return { cleanup: async () => {} } },
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => {} })
  })
  await runtime.start('')
  onFrame(new Float32Array(1_600).fill(0.2), 0.2)
  await runtime.manualDone()
  assert.equal(runtime.snapshot().turns[0].complete, false)

  await runtime.end()

  assert.equal(runtime.snapshot().turns[0].complete, true)
  assert.equal(runtime.snapshot().turns[0].assistantText, 'Turn interrupted.')
  await runtime.dispose()
})

test('turn failure transitions to error only after releasing session resources', async () => {
  const { testApi } = loadPlugin()
  let onFrame = null
  let captureCleanups = 0
  let playbackCleanups = 0
  let stopCalls = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/turn') throw new Error('turn failed')
      if (path === '/session/stop') stopCalls += 1
      return { state: 'listening' }
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async options => {
      onFrame = options.onFrame
      return { cleanup: async () => { captureCleanups += 1 } }
    },
    playbackFactory: async () => ({
      enqueue() { return true },
      interrupt() {},
      snapshot() { return {} },
      cleanup: async () => { playbackCleanups += 1 }
    })
  })
  await runtime.start('')
  onFrame(new Float32Array(1_600).fill(0.2), 0.2)

  await assert.rejects(runtime.manualDone(), /turn failed/)

  assert.equal(runtime.snapshot().state, 'error')
  assert.equal(runtime.snapshot().active, false)
  assert.equal(captureCleanups, 1)
  assert.equal(playbackCleanups, 1)
  assert.equal(stopCalls, 1)
  assert.equal(runtime.snapshot().turns.length, 1)
  assert.equal(runtime.snapshot().turns[0].complete, true)
  assert.equal(runtime.snapshot().turns[0].assistantText, 'Turn failed.')
})

test('server polling runs every three seconds without a voice session and isolates failures', async () => {
  const { testApi } = loadPlugin()
  let pollCallback = null
  let pollMs = null
  let failServerPoll = false
  const paths = []
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      paths.push(path)
      if (path === '/server/status') {
        if (failServerPoll) throw new Error('control plane offline')
        return { configured: true, state: 'ready', running: true, managed: true, pid: 1234, message: 'Ready.' }
      }
      throw new Error(`unexpected voice poll: ${path}`)
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    setIntervalFn: (callback, ms) => { pollCallback = callback; pollMs = ms; return 19 }
  })

  runtime.startPolling()
  await pollCallback()
  assert.equal(pollMs, 3_000)
  assert.deepEqual(paths, ['/server/status'])
  assert.equal(runtime.snapshot().server.state, 'ready')
  assert.equal(runtime.snapshot().state, 'shell_ready')
  assert.equal(runtime.snapshot().active, false)

  failServerPoll = true
  await pollCallback()
  assert.equal(runtime.snapshot().server.state, 'unreachable')
  assert.equal(runtime.snapshot().state, 'shell_ready')
  assert.equal(runtime.snapshot().active, false)
  await runtime.dispose()
})

test('a stale server poll cannot overwrite a completed Start Server result', async () => {
  const { testApi } = loadPlugin()
  const stalePoll = deferred()
  let pollCallback = null
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      if (path === '/server/status') return stalePoll.promise
      if (path === '/server/start') {
        return { configured: true, state: 'ready', running: true, managed: true, pid: 1234, message: 'Ready.' }
      }
      throw new Error(`unexpected path: ${path}`)
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    setIntervalFn: callback => { pollCallback = callback; return 20 }
  })
  runtime.startPolling()

  const polling = pollCallback()
  await runtime.startServer()
  stalePoll.resolve({ configured: true, state: 'stopped', running: false, managed: false, message: 'Stale.' })
  await polling

  assert.equal(runtime.snapshot().server.state, 'ready')
  assert.equal(runtime.snapshot().server.managed, true)
  await runtime.dispose()
})

test('Start Server and Stop Server use bounded REST timeouts and serialize duplicate starts', async () => {
  const { testApi } = loadPlugin()
  const starting = deferred()
  const calls = []
  const runtime = testApi.createVoiceRuntime({
    rest: async (path, options) => {
      calls.push({ path, options })
      if (path === '/server/start') return starting.promise
      if (path === '/server/stop') return { configured: true, state: 'stopped', running: false, managed: false, message: 'Stopped.' }
      throw new Error(`unexpected path: ${path}`)
    },
    storage: { get: (_key, fallback) => fallback, set() {} }
  })

  const first = runtime.startServer()
  const second = runtime.startServer()
  await until(() => calls.length === 1)
  assert.equal(runtime.snapshot().serverBusy, true)
  assert.equal(runtime.snapshot().server.state, 'starting')
  assert.equal(calls[0].path, '/server/start')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.timeoutMs >= 210_000, true)
  starting.resolve({ configured: true, state: 'ready', running: true, managed: true, pid: 1234, message: 'Ready.' })
  await Promise.all([first, second])
  assert.equal(calls.filter(call => call.path === '/server/start').length, 1)
  assert.equal(runtime.snapshot().serverBusy, false)

  await runtime.stopServer()
  const stop = calls.find(call => call.path === '/server/stop')
  assert.equal(stop.options.method, 'POST')
  assert.equal(stop.options.timeoutMs, 20_000)
  assert.equal(runtime.snapshot().server.state, 'stopped')
  await runtime.dispose()
})

test('Stop Server releases active voice resources before requesting server stop', async () => {
  const { testApi } = loadPlugin()
  let pollCallback = null
  const paths = []
  let captureCleanups = 0
  let playbackCleanups = 0
  const runtime = testApi.createVoiceRuntime({
    rest: async path => {
      paths.push(path)
      if (path === '/server/status') return { configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' }
      if (path === '/session/start') return { state: 'listening', session_id: 's1', generation: 1 }
      if (path === '/session/stop') return { state: 'shell_ready', session_id: null, generation: 2 }
      if (path === '/server/stop') return { configured: true, state: 'stopped', running: false, managed: false, message: 'Stopped.' }
      throw new Error(`unexpected path: ${path}`)
    },
    storage: { get: (_key, fallback) => fallback, set() {} },
    captureFactory: async () => ({ cleanup: async () => { captureCleanups += 1 } }),
    playbackFactory: async () => ({ interrupt() {}, snapshot() { return {} }, cleanup: async () => { playbackCleanups += 1 } }),
    setIntervalFn: callback => { pollCallback = callback; return 4 }
  })
  runtime.startPolling()
  await pollCallback()
  await runtime.start('')

  await runtime.stopServer()

  assert.deepEqual(paths.slice(-2), ['/session/stop', '/server/stop'])
  assert.equal(captureCleanups, 1)
  assert.equal(playbackCleanups, 1)
  assert.equal(runtime.snapshot().active, false)
  await runtime.dispose()
})

test('page-local server card and buttons apply server and voice disabled-state rules', () => {
  const { testApi } = loadPlugin()
  const base = {
    state: 'shell_ready', active: false, muted: false, busy: false, serverBusy: false,
    bargeIn: false, silenceMs: 4_000, assistantText: '', userTranscript: '', microphoneLevel: 0,
    metrics: {}, errorMessage: ''
  }
  const render = server => testApi.EnglishCoachPage({
    runtime: {
      snapshot: () => ({ ...base, server }),
      subscribe: () => () => {},
      startServer() {}, stopServer() {}, start() {}, setMuted() {}, manualDone() {}, interrupt() {}, end() {},
      setSilenceMs() {}, setBargeIn() {}
    }
  })
  const buttons = page => Object.fromEntries(
    descendants(page)
      .filter(element => element.type === 'Button')
      .map(element => [elementText(element), element.props])
  )

  const stopped = render({ configured: true, state: 'stopped', running: false, managed: false, message: 'Stopped.' })
  assert.match(elementText(stopped), /Server: stopped/)
  assert.match(elementText(stopped), /Stopped\./)
  assert.equal(buttons(stopped)['Start Server'].disabled, false)
  assert.equal(buttons(stopped)['Stop Server'].disabled, true)
  assert.equal(buttons(stopped).Start.disabled, true)

  const ready = render({ configured: true, state: 'ready', running: true, managed: true, message: 'Ready.' })
  assert.equal(buttons(ready)['Start Server'].disabled, true)
  assert.equal(buttons(ready)['Stop Server'].disabled, false)
  assert.equal(buttons(ready).Start.disabled, false)

  const external = render({ configured: true, state: 'external', running: true, managed: false, message: 'External.' })
  assert.equal(buttons(external)['Start Server'].disabled, true)
  assert.equal(buttons(external)['Stop Server'].disabled, true)
  assert.equal(buttons(external).Start.disabled, false)
})

test('server controls introduce no bottom status-bar source token', () => {
  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  assert.doesNotMatch(source, /statusBar\.|STATUSBAR|STATUS_BAR/)
})
