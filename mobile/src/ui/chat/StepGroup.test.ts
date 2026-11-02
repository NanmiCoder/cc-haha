import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('live tool groups show every step inline and keep the reader disclosure choice across streaming updates', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Pressable: 'Pressable', View: 'View' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      DiffView: 'DiffView', HaloDot: 'HaloDot', Icon: 'Icon', Mono: 'Mono', Spinner: 'Spinner', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./ToolImages'))}, () => ({ ToolImageStrip: 'ToolImageStrip' }))
    const { StepGroup } = require(${JSON.stringify(import.meta.resolve('./StepGroup'))})
    const { chatReducer, createChatState } = require(${JSON.stringify(import.meta.resolve('../../core/chat'))})
    const { buildChatRows, toggleGroupOpen } = require(${JSON.stringify(import.meta.resolve('./steps'))})
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      if (typeof node.type?.type === 'function') return flatten(node.type.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    let state = createChatState('streaming-tools')
    let ui = { expanded: new Set(), open: new Set(), closed: new Set() }
    const event = value => { state = chatReducer(state, value) }
    const group = () => buildChatRows(state.items, state.turnActive).find(row => row.kind === 'steps')
    const render = (row = group()) => flatten(StepGroup.type({
      row,
      context: { workDir: '/repo', waiting: new Set(), background: new Set(), activeThinkingId: state.activeThinkingId, turnActive: state.turnActive },
      ui,
      onToggleStep: () => {},
      onToggleOpen: (key, live) => { ui = toggleGroupOpen(ui, key, live) },
    }))
    const disclosure = nodes => nodes.find(node => node.type === 'Pressable' && ['收起步骤', '展开步骤'].includes(node.props.accessibilityHint))
    const labels = nodes => nodes.filter(node => node.type === 'Pressable').map(node => node.props.accessibilityLabel)
    event({ type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'read-1' })
    event({ type: 'tool_use_complete', toolName: 'Read', toolUseId: 'read-1', input: { file_path: '/repo/src/app.ts' } })
    event({ type: 'tool_result', toolUseId: 'read-1', content: 'export {}', isError: false })
    event({ type: 'thinking', text: 'Inspect the test command next.' })
    event({ type: 'content_start', blockType: 'tool_use', toolName: 'Bash', toolUseId: 'bash-1' })
    event({ type: 'tool_use_complete', toolName: 'Bash', toolUseId: 'bash-1', input: { command: 'bun test' } })
    let nodes = render()
    // Previously the group was closed, and its currently running step was
    // removed even after opening it. Both must remain in the live timeline.
    assert.equal(disclosure(nodes).props.accessibilityState.expanded, true, 'a live group must open without a tap')
    assert.ok(labels(nodes).includes('读取 src/app.ts'), 'earlier steps stay visible while the next tool starts')
    assert.ok(labels(nodes).includes('思考过程'))
    assert.ok(labels(nodes).includes('运行 bun test'), 'show the executing step in place')
    const firstKey = group().key
    event({ type: 'tool_result', toolUseId: 'bash-1', content: 'passed', isError: false })
    assert.equal(disclosure(render()).props.accessibilityState.expanded, true, 'gaps between tools must not fold the live run')
    disclosure(render()).props.onPress()
    assert.equal(disclosure(render()).props.accessibilityState.expanded, false, 'a reader may collapse the live group')
    event({ type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'read-2' })
    event({ type: 'tool_use_complete', toolName: 'Read', toolUseId: 'read-2', input: { file_path: '/repo/src/check.ts' } })
    assert.equal(group().key, firstKey)
    assert.equal(disclosure(render()).props.accessibilityState.expanded, false, 'new steps preserve a manual collapse')
    disclosure(render()).props.onPress()
    assert.equal(disclosure(render()).props.accessibilityState.expanded, true)
    assert.ok(labels(render()).includes('读取 src/check.ts'))
    event({ type: 'status', state: 'idle' })
    assert.equal(disclosure(render()).props.accessibilityState.expanded, true, 'manual expansion survives the turn finishing')
    ui = { expanded: new Set(), open: new Set(), closed: new Set() }
    assert.equal(disclosure(render()).props.accessibilityState.expanded, false, 'settled history starts folded')
    disclosure(render()).props.onPress()
    assert.equal(disclosure(render()).props.accessibilityState.expanded, true, 'history remains expandable')
    ui = { expanded: new Set(), open: new Set(), closed: new Set() }
    const onlyCurrent = { ...group(), key: 'steps:current', live: true, steps: [{ id: 'current', type: 'tool', toolName: 'Bash', toolUseId: 'current', pending: true, input: { command: 'bun lint' } }] }
    assert.ok(labels(render(onlyCurrent)).includes('运行 bun lint'), 'the first unfinished tool must not vanish')

    // A screenshot the agent read: under its step while open, under the summary once folded.
    state = createChatState('screenshot')
    ui = { expanded: new Set(), open: new Set(), closed: new Set() }
    const shot = { type: 'image', source: { type: 'ref', media_type: 'image/png', url: '/api/sessions/s/tool-images/read-shot/0', width: 1920, height: 1139 } }
    event({ type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'read-shot' })
    event({ type: 'tool_use_complete', toolName: 'Read', toolUseId: 'read-shot', input: { file_path: '/tmp/todo/shot-final.png' } })
    event({ type: 'tool_result', toolUseId: 'read-shot', content: [shot], isError: false })
    event({ type: 'content_start', blockType: 'tool_use', toolName: 'Bash', toolUseId: 'after-shot' })
    const strips = nodes => nodes.filter(node => node.type === 'ToolImageStrip')
    let open = render()
    assert.equal(strips(open).length, 1, 'the live group shows the image under its step')
    assert.deepEqual(strips(open)[0].props.images, [{ image: { mimeType: 'image/png', url: '/api/sessions/s/tool-images/read-shot/0', width: 1920, height: 1139 }, name: 'shot-final.png' }])
    const order = open.filter(node => node.type === 'ToolImageStrip' || /^(读取|运行)/.test(node.props?.accessibilityLabel ?? ''))
    assert.deepEqual(order.map(node => node.type === 'ToolImageStrip' ? 'strip' : node.props.accessibilityLabel.split(' ')[0]), ['读取', 'strip', '运行'])
    event({ type: 'tool_result', toolUseId: 'after-shot', content: 'ok', isError: false })
    event({ type: 'status', state: 'idle' })
    const folded = render()
    assert.equal(disclosure(folded).props.accessibilityState.expanded, false)
    assert.equal(strips(folded).length, 1, 'a folded group keeps its images visible under the summary')
    assert.equal(strips(folded)[0].props.images[0].name, 'shot-final.png')
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
