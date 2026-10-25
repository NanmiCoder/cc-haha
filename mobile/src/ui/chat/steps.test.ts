import { describe, expect, test } from 'bun:test'
import type { ChatItem } from '../../core/types'
import { chatReducer, createChatState } from '../../core/chat'
import {
  buildChatRows,
  collapsible,
  describeStep,
  editCounts,
  editDiff,
  formatInput,
  lineDiff,
  outputTail,
  relativePath,
  summarizeSteps,
  summaryLabel,
  visibleSteps,
} from './steps'

const tool = (id: string, toolName: string, input: unknown, extra: Partial<ChatItem> = {}): ChatItem => ({
  id,
  type: 'tool',
  text: '',
  toolName,
  toolUseId: `use-${id}`,
  input,
  ...extra,
})
const user = (id: string, text = '问题'): ChatItem => ({ id, type: 'user', text })
const assistant = (id: string, text = '回复'): ChatItem => ({ id, type: 'assistant', text })

describe('step grouping', () => {
  test('merges consecutive tools and thinking into one group between messages', () => {
    const rows = buildChatRows(
      [
        user('u1'),
        assistant('a1'),
        { id: 't1', type: 'thinking', text: '想一想' },
        tool('r1', 'Read', { file_path: '/repo/a.ts' }),
        tool('b1', 'Bash', { command: 'bun test' }),
        assistant('a2'),
        tool('r2', 'Read', { file_path: '/repo/b.ts' }),
      ],
      false
    )
    expect(rows.map((row) => row.kind)).toEqual(['message', 'message', 'steps', 'message', 'steps'])
    const group = rows[2]
    expect(group.kind === 'steps' && group.steps.map((step) => step.id)).toEqual(['t1', 'r1', 'b1'])
    expect(group.key).toBe('steps:t1')
    // Thinking is a visible step but not an action in the summary.
    expect(group.kind === 'steps' && group.summary).toEqual({ total: 2, read: 1, edit: 0, run: 1 })
  })

  test('only groups after the last user message are live while the turn runs', () => {
    const items = [
      user('u1'),
      tool('r1', 'Read', {}),
      assistant('a1'),
      user('u2'),
      tool('r2', 'Read', {}),
    ]
    const running = buildChatRows(items, true).filter((row) => row.kind === 'steps')
    expect(running.map((row) => row.kind === 'steps' && row.live)).toEqual([false, true])
    const settled = buildChatRows(items, false).filter((row) => row.kind === 'steps')
    expect(settled.map((row) => row.kind === 'steps' && row.live)).toEqual([false, false])
  })

  test('group keys stay stable while a live group grows, so expansion state survives streaming', () => {
    let state = createChatState('s')
    state = chatReducer(state, { type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'one' })
    const first = buildChatRows(state.items, true)[0].key
    state = chatReducer(state, { type: 'tool_result', toolUseId: 'one', content: 'ok', isError: false })
    state = chatReducer(state, { type: 'content_start', blockType: 'tool_use', toolName: 'Bash', toolUseId: 'two' })
    const rows = buildChatRows(state.items, true)
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe(first)
  })

  test('folds older live steps and collapses settled groups of two or more tools', () => {
    const steps = Array.from({ length: 6 }, (_, index) => tool(`s${index}`, 'Read', {}))
    expect(visibleSteps(steps, false)).toMatchObject({ hidden: 2 })
    expect(visibleSteps(steps, false).steps.map((step) => step.id)).toEqual(['s2', 's3', 's4', 's5'])
    expect(visibleSteps(steps, true).hidden).toBe(0)
    expect(visibleSteps(steps.slice(0, 4), false).hidden).toBe(0)
    expect(collapsible(summarizeSteps(steps.slice(0, 1)))).toBe(false)
    expect(collapsible(summarizeSteps(steps.slice(0, 2)))).toBe(true)
    expect(collapsible(summarizeSteps([{ id: 'x', type: 'thinking', text: '' }]))).toBe(false)
  })

  test('summary names reads, edits and runs and omits empty categories', () => {
    const summary = summarizeSteps([
      tool('1', 'Read', {}),
      tool('2', 'Grep', {}),
      tool('3', 'Edit', {}),
      tool('4', 'Write', {}),
      tool('5', 'Bash', {}),
      tool('6', 'WebSearch', {}),
    ])
    expect(summaryLabel(summary)).toBe('做了 6 步 · 读 2 · 改 2 · 运行 1')
    expect(summaryLabel({ total: 3, read: 3, edit: 0, run: 0 })).toBe('做了 3 步 · 读 3')
  })
})

describe('step labels', () => {
  test('maps every documented tool to its verb and object', () => {
    const workDir = '/Users/me/code/cc-haha'
    const label = (name: string, input: unknown) => describeStep(tool('x', name, input), workDir)
    expect(label('Read', { file_path: `${workDir}/src/app/connect.tsx` })).toEqual({
      verb: '读取',
      object: 'src/app/connect.tsx',
      mono: true,
    })
    expect(label('Write', { file_path: '/elsewhere/a.md' })).toMatchObject({ verb: '写入', object: '/elsewhere/a.md' })
    expect(label('Bash', { command: 'bun test src\n&& echo done' })).toMatchObject({ verb: '运行', object: 'bun test src' })
    expect(label('Grep', { pattern: 'useTheme' })).toMatchObject({ verb: '搜索', object: 'useTheme', mono: true })
    expect(label('Glob', { pattern: '**/*.tsx' })).toMatchObject({ verb: '查找', object: '**/*.tsx' })
    expect(label('WebFetch', { url: 'https://example.com' })).toMatchObject({ verb: '打开', mono: true })
    expect(label('WebSearch', { query: 'expo router' })).toMatchObject({ verb: '搜网页', object: 'expo router', mono: false })
    expect(label('Task', { description: '做扫码页界面' })).toMatchObject({ verb: '子 Agent', object: '做扫码页界面', mono: false })
    expect(label('Agent', { description: '跑测试' })).toMatchObject({ verb: '子 Agent', object: '跑测试' })
    expect(label('TodoWrite', { todos: [{}, {}, {}] })).toMatchObject({ verb: '更新待办', object: '3 项' })
    expect(label('mcp__github__create_issue', { title: 'x' })).toMatchObject({ verb: '调用', object: 'github · create_issue', mono: true })
    expect(label('ExitPlanMode', { plan: '# 计划' })).toMatchObject({ verb: '提交计划', mono: false })
    expect(label('AskUserQuestion', { questions: [{ question: '旧字段怎么处理？' }] })).toMatchObject({ verb: '提问', object: '旧字段怎么处理？' })
    expect(label('SomeNewTool', { description: '做点事' })).toMatchObject({ verb: 'SomeNewTool', object: '做点事' })
    expect(describeStep({ id: 't', type: 'thinking', text: '...' })).toEqual({ verb: '思考过程', mono: false })
  })

  test('reads streaming partial JSON once it is complete and ignores it before', () => {
    const streaming = tool('x', 'Read', undefined, { partialInput: '{"file_path":"/re' })
    expect(describeStep(streaming).object).toBeUndefined()
    const complete = tool('x', 'Read', undefined, { partialInput: '{"file_path":"/repo/a.ts"}' })
    expect(describeStep(complete, '/repo').object).toBe('a.ts')
  })

  test('relative paths only strip a real directory prefix', () => {
    expect(relativePath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(relativePath('/repository/a.ts', '/repo')).toBe('/repository/a.ts')
    expect(relativePath('C:\\repo\\a.ts', 'C:\\repo')).toBe('a.ts')
    expect(relativePath('/repo/a.ts', null)).toBe('/repo/a.ts')
  })
})

describe('edit statistics', () => {
  test('counts changed lines, not every line of both strings', () => {
    const before = 'a\nb\nc\nd'
    const after = 'a\nB\nc\nd\ne'
    expect(editCounts({ old_string: before, new_string: after })).toEqual({ added: 2, removed: 1 })
    expect(describeStep(tool('e', 'Edit', { file_path: '/x', old_string: before, new_string: after }))).toMatchObject({
      verb: '编辑',
      added: 2,
      removed: 1,
    })
  })

  test('sums MultiEdit and reports nothing when the strings are missing', () => {
    expect(
      editCounts({
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: '', new_string: 'one\ntwo' },
        ],
      })
    ).toEqual({ added: 3, removed: 1 })
    expect(editCounts({ file_path: '/x' })).toEqual({})
    expect(editCounts(null)).toEqual({})
  })

  test('line diff keeps context around the change and puts removals first', () => {
    expect(lineDiff('keep\nold\nend', 'keep\nnew\nend')).toEqual([
      { text: 'keep', kind: 'context' },
      { text: 'old', kind: 'remove' },
      { text: 'new', kind: 'add' },
      { text: 'end', kind: 'context' },
    ])
    expect(lineDiff('same', 'same')).toEqual([{ text: 'same', kind: 'context' }])
  })

  test('large rewrites fall back to remove-then-add without quadratic work', () => {
    const before = Array.from({ length: 400 }, (_, index) => `old ${index}`).join('\n')
    const after = Array.from({ length: 400 }, (_, index) => `new ${index}`).join('\n')
    const lines = lineDiff(before, after)
    expect(lines.filter((line) => line.kind === 'remove')).toHaveLength(400)
    expect(lines.filter((line) => line.kind === 'add')).toHaveLength(400)
    expect(lines[0].kind).toBe('remove')
  })

  test('multi-edit diff labels each hunk', () => {
    const lines = editDiff({
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    })
    expect(lines.filter((line) => line.kind === 'hunk').map((line) => line.text)).toEqual(['第 1 处', '第 2 处'])
  })
})

describe('step details', () => {
  test('keeps only the tail of long output and says how much was omitted', () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const tail = outputTail(text, 5)
    expect(tail.omitted).toBe(15)
    expect(tail.text.split('\n')).toEqual(['line 16', 'line 17', 'line 18', 'line 19', 'line 20'])
    expect(outputTail('one\ntwo\n')).toEqual({ text: 'one\ntwo', omitted: 0 })
  })

  test('formats other tool input one field per line and truncates huge values', () => {
    expect(formatInput({ title: 'x', labels: ['a'] })).toBe('title: x\nlabels: ["a"]')
    expect(formatInput({ body: 'y'.repeat(700) }).endsWith('…')).toBe(true)
    expect(formatInput(null)).toBe('')
  })
})
