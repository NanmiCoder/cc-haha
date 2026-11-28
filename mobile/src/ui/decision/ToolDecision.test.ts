import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

test('ToolDecision hides remember checkbox and clamps remember=false when supportsAllowAlways is false, and renders subagent attribution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-tool-decision-'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let cursor = 0
    let states: any[] = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      useState: (initial: any) => {
        const slot = cursor++
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
        return [states[slot], (next: any) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }]
      },
    }))
    const jsx = (type: any, props: any, key: any) => ({ type, props, key })
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-dev-runtime'))}, () => ({ jsxDEV: jsx, Fragment: 'Fragment' }))
    mock.module(${JSON.stringify(import.meta.resolve('react/jsx-runtime'))}, () => ({ jsx, jsxs: jsx, Fragment: 'Fragment' }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      ScrollView: 'ScrollView',
      View: 'View',
      useWindowDimensions: () => ({ height: 844 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Button: 'Button',
      Checkbox: 'Checkbox',
      CodeBlock: 'CodeBlock',
      DiffStat: 'DiffStat',
      DiffView: 'DiffView',
      Mono: 'Mono',
      useColors: () => ({ ink: '#111', ink2: '#333', ink3: '#666', fill: '#eee', code: '#f7f7f7', hair: '#ddd' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({
      DecisionHeader: 'DecisionHeader',
      DecisionSurface: 'DecisionSurface',
      NoteChip: 'NoteChip',
      NoteInput: 'NoteInput',
      QuietButton: 'QuietButton',
      SubmittedRow: 'SubmittedRow',
    }))
    const { ToolDecision } = require(${JSON.stringify(import.meta.resolve('./ToolDecision'))})
    const flat = (node: any): any[] => {
      if (!node || typeof node !== 'object') return []
      if (Array.isArray(node)) return node.flatMap(flat)
      return [node, ...flat(node.props?.children), ...flat(node.props?.right)]
    }
    const render = (props: any) => {
      cursor = 0
      return flat(ToolDecision(props))
    }

    // 1. Default mode with supportsAllowAlways: false (command approval + subagent attribution)
    let replied: any
    states = []
    let tree = render({
      request: { requestId: 'r1', toolName: 'run_command', supportsAllowAlways: false, subagentName: '@verifier' },
      input: { CommandLine: 'bun test' },
      ready: true,
      sent: false,
      respond: (opts: any) => { replied = opts; return true },
    })
    assert.equal(tree.some((n) => n.type === 'Checkbox'), false, 'remember checkbox hidden when supportsAllowAlways=false')
    assert.ok(JSON.stringify(tree).includes('来自 ') && JSON.stringify(tree).includes('@verifier'), 'subagent attribution shown')
    tree.find((n) => n.type === 'Button' && n.props?.title === '允许').props.onPress()
    assert.deepEqual(replied, { allowed: true, remember: false })

    // 2. File edit approval with input.supportsAllowAlways: false also hides checkbox
    states = []
    tree = render({
      request: { requestId: 'r2', toolName: 'edit_file' },
      input: { Path: 'src/a.ts', Target: 'old', Replacement: 'new', supportsAllowAlways: false },
      ready: true,
      sent: false,
      respond: (opts: any) => { replied = opts; return true },
    })
    assert.equal(tree.some((n) => n.type === 'Checkbox'), false, 'file edit hides remember checkbox when input.supportsAllowAlways=false')
    tree.find((n) => n.type === 'Button' && n.props?.title === '允许').props.onPress()
    assert.deepEqual(replied, { allowed: true, remember: false })

    // 3. Default (allow_always supported): checkbox renders and sends remember=true when toggled
    states = []
    const propsSupported = {
      request: { requestId: 'r3', toolName: 'Bash' },
      input: { command: 'ls' },
      ready: true,
      sent: false,
      respond: (opts: any) => { replied = opts; return true },
    }
    tree = render(propsSupported)
    const checkbox = tree.find((n) => n.type === 'Checkbox')
    assert.ok(checkbox, 'remember checkbox renders when supportsAllowAlways is omitted')
    checkbox.props.onChange(true)
    tree = render(propsSupported)
    tree.find((n) => n.type === 'Button' && n.props?.title === '允许').props.onPress()
    assert.deepEqual(replied, { allowed: true, remember: true })
  `
  const scriptPath = join(dir, 'tool.ts')
  writeFileSync(scriptPath, script)
  try {
    execFileSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8' })
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; signal?: string; status?: number }
    throw new Error(`${failure.status} ${failure.signal || ''} ${failure.stderr || ''} ${failure.stdout || ''}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
