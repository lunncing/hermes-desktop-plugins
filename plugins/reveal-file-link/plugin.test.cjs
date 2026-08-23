const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const PLUGIN_PATH = path.join(__dirname, 'plugin.js')
const DEFAULT_LABEL = '在文件夹中显示'
const MAX_LABEL_CHARS = 128

function loadPlugin() {
  let activeHooks = null
  const sdk = {
    cn: (...parts) => parts.filter(Boolean).join(' ')
  }
  const react = {
    useRef(initialValue) {
      assert.ok(activeHooks, 'useRef called outside a component render')
      return activeHooks.useRef(initialValue)
    },
    useState(initialValue) {
      assert.ok(activeHooks, 'useState called outside a component render')
      return activeHooks.useState(initialValue)
    }
  }
  const runtime = {
    jsx: (type, props) => ({ type, props: props || {} })
  }
  const context = {
    react,
    runtime,
    sdk,
    globalThis: null
  }
  context.globalThis = context

  let source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  source = source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '')
  source = source.replace(/export\s+(const|function|class)\s+/g, '$1 ')
  source = source.replace(/export default\s+/, 'const plugin = ')
  source = `
    const { cn } = sdk
    const { useRef, useState } = react
    const { jsx } = runtime
    ${source}
    globalThis.__loaded = { plugin, normalizeLabel, normalizePath, RevealFileControl }
  `
  vm.runInNewContext(source, context, { filename: PLUGIN_PATH })

  function renderComponent(Component, props) {
    const slots = []
    const instance = {
      cursor: 0,
      useRef(initialValue) {
        const index = this.cursor++
        if (!slots[index]) slots[index] = { kind: 'ref', value: { current: initialValue } }
        assert.equal(slots[index].kind, 'ref')
        return slots[index].value
      },
      useState(initialValue) {
        const index = this.cursor++
        if (!slots[index]) {
          slots[index] = {
            kind: 'state',
            value: typeof initialValue === 'function' ? initialValue() : initialValue
          }
        }
        assert.equal(slots[index].kind, 'state')
        const setValue = nextValue => {
          const previous = slots[index].value
          slots[index].value = typeof nextValue === 'function' ? nextValue(previous) : nextValue
          render()
        }
        return [slots[index].value, setValue]
      }
    }
    let tree
    function render() {
      instance.cursor = 0
      activeHooks = instance
      try {
        tree = Component(props)
      } finally {
        activeHooks = null
      }
    }
    render()
    return { get tree() { return tree } }
  }

  return { ...context.__loaded, renderComponent, source: fs.readFileSync(PLUGIN_PATH, 'utf8') }
}

function registerPlugin(loaded, revealPath = async () => true) {
  const registrations = []
  let disposed = false
  const returned = loaded.plugin.register({
    os: { revealPath },
    register(contribution) {
      registrations.push(contribution)
      return () => { disposed = true }
    }
  })
  assert.equal(registrations.length, 1)
  return { contribution: registrations[0], disposed: () => disposed, returned }
}

function renderDirective(loaded, revealPath, props) {
  const { contribution } = registerPlugin(loaded, revealPath)
  const element = contribution.data.render(props)
  assert.equal(element.type, loaded.RevealFileControl)
  return loaded.renderComponent(element.type, element.props)
}

test('metadata and registration claim the reveal-file transcript directive', () => {
  const loaded = loadPlugin()
  const registration = registerPlugin(loaded)

  assert.equal(loaded.plugin.id, 'reveal-file-link')
  assert.equal(loaded.plugin.name, 'Reveal File Link')
  assert.equal(loaded.plugin.defaultEnabled, true)
  assert.equal(registration.contribution.id, 'reveal-file')
  assert.equal(registration.contribution.area, 'transcript.directives')
  assert.equal(registration.contribution.data.name, 'reveal-file')
  assert.equal(typeof registration.contribution.data.render, 'function')
})

test('labels use the exact default and trim and bound custom model output', () => {
  const { normalizeLabel } = loadPlugin()

  assert.equal(normalizeLabel(), DEFAULT_LABEL)
  assert.equal(normalizeLabel('   '), DEFAULT_LABEL)
  assert.equal(normalizeLabel('  Show in folder  '), 'Show in folder')
  assert.equal(normalizeLabel('x'.repeat(MAX_LABEL_CHARS + 20)), 'x'.repeat(MAX_LABEL_CHARS))
})

test('accepts absolute Windows drive, UNC, and POSIX paths without rewriting them', () => {
  const { normalizePath } = loadPlugin()
  const accepted = [
    'C:\\Reports\\report.pptx',
    'd:/Reports/report.pptx',
    '\\\\server\\share\\report.pptx',
    '/Users/me/report.pptx'
  ]

  for (const filePath of accepted) assert.equal(normalizePath(filePath), filePath)
  assert.equal(normalizePath('  C:\\Reports\\report.pptx  '), 'C:\\Reports\\report.pptx')
})

test('rejects empty, relative, URL, overlong, and control-character paths', () => {
  const { normalizePath } = loadPlugin()
  const rejected = [
    undefined,
    '',
    '   ',
    'report.pptx',
    './report.pptx',
    '..\\report.pptx',
    'C:report.pptx',
    'file:///tmp/report.pptx',
    'https://example.com/report.pptx',
    'custom:report.pptx',
    'C:\\bad\0name.pptx',
    'C:\\bad\nname.pptx',
    `/${'x'.repeat(1024)}`
  ]

  for (const filePath of rejected) assert.equal(normalizePath(filePath), null, String(filePath))
})

test('one click reveals the exact normalized path once and restores the normal label', async () => {
  const loaded = loadPlugin()
  const calls = []
  const view = renderDirective(loaded, async filePath => {
    calls.push(filePath)
    return true
  }, {
    attrs: { path: '  C:\\Reports\\report.pptx  ' },
    source: '',
    streaming: false
  })

  assert.equal(view.tree.type, 'button')
  assert.equal(view.tree.props.type, 'button')
  assert.equal(view.tree.props.children, DEFAULT_LABEL)
  await view.tree.props.onClick()
  assert.deepEqual(calls, ['C:\\Reports\\report.pptx'])
  assert.equal(view.tree.props.children, DEFAULT_LABEL)
  assert.equal(view.tree.props.disabled, false)
})

test('streaming and in-flight state block clicks, including direct handler re-entry', async () => {
  const loaded = loadPlugin()
  const streamingCalls = []
  const streamingView = renderDirective(loaded, async filePath => {
    streamingCalls.push(filePath)
    return true
  }, {
    attrs: { path: '/tmp/report.pptx' },
    source: '',
    streaming: true
  })

  assert.equal(streamingView.tree.props.disabled, true)
  await streamingView.tree.props.onClick()
  assert.deepEqual(streamingCalls, [])

  let finish
  const calls = []
  const pendingView = renderDirective(loaded, filePath => {
    calls.push(filePath)
    return new Promise(resolve => { finish = resolve })
  }, {
    attrs: { path: '/tmp/report.pptx' },
    source: '',
    streaming: false
  })
  const firstClick = pendingView.tree.props.onClick()
  assert.equal(pendingView.tree.props.disabled, true)
  await pendingView.tree.props.onClick()
  assert.deepEqual(calls, ['/tmp/report.pptx'])
  finish(true)
  await firstClick
  assert.equal(pendingView.tree.props.disabled, false)
})

test('false and thrown reveal results show a retryable inline error', async () => {
  const loaded = loadPlugin()
  const results = [false, new Error('not available'), true]
  const calls = []
  const view = renderDirective(loaded, async filePath => {
    calls.push(filePath)
    const result = results.shift()
    if (result instanceof Error) throw result
    return result
  }, {
    attrs: { path: '/tmp/report.pptx', label: 'Show it' },
    source: '',
    streaming: false
  })

  await view.tree.props.onClick()
  assert.match(view.tree.props.children, /重试/)
  assert.equal(view.tree.props.disabled, false)
  await view.tree.props.onClick()
  assert.match(view.tree.props.children, /重试/)
  assert.equal(view.tree.props.disabled, false)
  await view.tree.props.onClick()
  assert.equal(view.tree.props.children, 'Show it')
  assert.equal(calls.length, 3)
})

test('invalid paths stay disabled and never reach the OS API', async () => {
  const loaded = loadPlugin()
  const calls = []
  const view = renderDirective(loaded, async filePath => {
    calls.push(filePath)
    return true
  }, {
    attrs: { path: 'report.pptx' },
    source: '',
    streaming: false
  })

  assert.equal(view.tree.props.disabled, true)
  await view.tree.props.onClick()
  assert.deepEqual(calls, [])
})

test('runtime source uses only approved imports and contains no alternate open or process path', () => {
  const { source } = loadPlugin()
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])

  assert.deepEqual(imports, ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  assert.match(source, /ctx\.os\.revealPath/)
  assert.doesNotMatch(source, /openExternal|openPath|child_process|(?:^|\W)(?:spawn|exec|shell)(?:\W|$)/i)
  assert.doesNotMatch(source, /\b(?:window|document|process)\b/)
})

test('registration returns the contribution disposer and the control is accessible and link-like', () => {
  const loaded = loadPlugin()
  const registration = registerPlugin(loaded)
  assert.equal(typeof registration.returned, 'function')
  registration.returned()
  assert.equal(registration.disposed(), true)

  const view = renderDirective(loaded, async () => true, {
    attrs: { path: '/tmp/report.pptx' },
    source: '',
    streaming: false
  })
  assert.equal(view.tree.props.type, 'button')
  assert.equal(view.tree.props.title, DEFAULT_LABEL)
  assert.equal(view.tree.props['aria-label'], DEFAULT_LABEL)
  assert.match(view.tree.props.className, /text-\(--ui-accent\)/)
  assert.match(view.tree.props.className, /underline/)
  assert.doesNotMatch(view.tree.props.className, /bg-\(--ui-accent\)|primary/i)
})
