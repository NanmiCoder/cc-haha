import { describe, expect, test } from 'bun:test'
import type { ChatItem } from '../../core/types'
import { chatReducer, createChatState } from '../../core/chat'
import {
  activityLabel,
  buildChatRows,
  describeStep,
  editCounts,
  editDiff,
  formatInput,
  formatTurnDuration,
  groupTail,
  isSubstantialReply,
  lineDiff,
  outputTail,
  relativePath,
  stepsBehindCaption,
  summarizeActivity,
  turnFoldLabel,
  visibleChatRows,
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

const stamped = (item: ChatItem, at: string): ChatItem => ({ ...item, timestamp: at })
const rowKinds = (rows: ReturnType<typeof buildChatRows>) => rows.map((row) => row.kind)

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
      true
    )
    expect(rowKinds(rows)).toEqual(['message', 'message', 'steps', 'message', 'steps'])
    const group = rows[2]
    expect(group.kind === 'steps' && group.steps.map((step) => step.id)).toEqual(['t1', 'r1', 'b1'])
    expect(group.key).toBe('steps:t1')
    expect(group.kind === 'steps' && activityLabel(group.segments)).toBe('思考 · 已读 1 个文件 · 运行 1 条命令')
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
})

describe('activity summary', () => {
  test('counts by tool kind in first-appearance order and omits nothing the model did', () => {
    const segments = summarizeActivity([
      tool('1', 'Read', { file_path: '/a.ts' }),
      tool('2', 'Read', { file_path: '/b.ts' }),
      tool('3', 'Read', { file_path: '/c.ts' }),
      tool('4', 'Bash', { command: 'ls' }),
      tool('5', 'Bash', { command: 'bun test' }),
    ])
    expect(activityLabel(segments)).toBe('已读 3 个文件 · 运行 2 条命令')
    expect(segments.map((segment) => segment.icon)).toEqual(['file', 'terminal'])
  })

  test('reading or editing one file repeatedly counts the file once, calls without a path count each', () => {
    expect(
      activityLabel(
        summarizeActivity([
          tool('1', 'Read', { file_path: '/a.ts' }),
          tool('2', 'Read', { file_path: '/a.ts' }),
          tool('3', 'Edit', { file_path: '/a.ts' }),
          tool('4', 'Edit', { file_path: '/a.ts' }),
          tool('5', 'Edit', { file_path: '/b.ts' }),
          tool('6', 'Write', { file_path: '/new.ts' }),
          tool('7', 'Edit', {}),
          tool('8', 'Edit', {}),
        ])
      )
    ).toBe('已读 1 个文件 · 编辑 4 个文件 · 新建 1 个文件')
  })

  test('groups search, web, sub-agents, todos and MCP tools under their own clauses', () => {
    expect(
      activityLabel(
        summarizeActivity([
          { id: 't', type: 'thinking', text: '' },
          tool('1', 'Grep', { pattern: 'a' }),
          tool('2', 'Grep', { pattern: 'b' }),
          tool('3', 'Glob', { pattern: '*' }),
          tool('4', 'WebSearch', { query: 'x' }),
          tool('5', 'WebFetch', { url: 'https://a' }),
          tool('6', 'Task', { description: 'd' }),
          tool('7', 'TodoWrite', {}),
          tool('8', 'TaskUpdate', {}),
          tool('9', 'mcp__github__create_issue', {}),
          tool('10', 'mcp__github__list_issues', {}),
          tool('11', 'SomeNewTool', {}),
        ])
      )
    ).toBe(
      '思考 · 搜索 2 次 · 查找文件 · 搜索网页 · 打开 1 个网页 · 派出 1 个子 Agent · 更新待办 · 调用 github 2 次 · 调用 SomeNewTool'
    )
  })

  test('thinking alone is still a one-line summary; several thoughts are counted', () => {
    expect(activityLabel(summarizeActivity([{ id: 't', type: 'thinking', text: '' }]))).toBe('思考')
    expect(
      activityLabel(
        summarizeActivity([
          { id: 't1', type: 'thinking', text: '' },
          tool('1', 'Read', { file_path: '/a' }),
          { id: 't2', type: 'thinking', text: '' },
        ])
      )
    ).toBe('思考 2 次 · 已读 1 个文件')
  })

  test('a live group leaves its unfinished last step to the status caption', () => {
    const steps = [tool('1', 'Read', { file_path: '/a' }), tool('2', 'Bash', { command: 'ls' }, { pending: true })]
    const unfinished = (step: ChatItem) => step.result === undefined
    expect(stepsBehindCaption(steps, unfinished).map((step) => step.id)).toEqual(['1'])
        // A finished last step stays: only the current step is hidden.
    expect(stepsBehindCaption(steps, () => false)).toHaveLength(2)
    expect(stepsBehindCaption([], unfinished)).toEqual([])
  })
})

describe('group status tail', () => {
  test('approval outranks failure outranks background; finished groups say nothing', () => {
    expect(groupTail(['done', 'missing'])).toBeNull()
    expect(groupTail(['done', 'background'])).toEqual({ text: '后台进行中', tone: 'run' })
    expect(groupTail(['error', 'background'])).toEqual({ text: '失败', tone: 'err' })
    expect(groupTail(['error', 'done', 'error'])).toEqual({ text: '2 项失败', tone: 'err' })
    expect(groupTail(['error', 'waiting', 'background'])).toEqual({ text: '等你批准', tone: 'attn' })
  })
})

describe('turn duration', () => {
  test('formats seconds, minutes and hours the way the board reads', () => {
    expect(formatTurnDuration(800)).toBe('')
    expect(formatTurnDuration(1000)).toBe('1 秒')
    expect(formatTurnDuration(45_900)).toBe('45 秒')
    expect(formatTurnDuration(60_000)).toBe('1 分')
    expect(formatTurnDuration(192_000)).toBe('3 分 12 秒')
    expect(formatTurnDuration(3_600_000)).toBe('1 小时')
    expect(formatTurnDuration(3_720_000 + 30_000)).toBe('1 小时 2 分')
    expect(formatTurnDuration(Number.NaN)).toBe('')
  })

  test('uses message times, falls back to the local clock, and never invents a number', () => {
    const u = stamped(user('u'), '2026-10-25T10:00:00.000Z')
    const last = stamped(assistant('a'), '2026-10-25T10:03:12.000Z')
    expect(turnFoldLabel(u, [last])).toBe('用时 3 分 12 秒')
    const start = Date.parse('2026-10-25T10:00:00.000Z')
    expect(turnFoldLabel(user('u2'), [assistant('a2')], { startedAt: start, endedAt: start + 45_000 })).toBe('用时 45 秒')
    expect(turnFoldLabel(user('u3'), [assistant('a3')])).toBe('处理过程')
    expect(turnFoldLabel(u, [stamped(assistant('b'), '2026-10-25T10:00:00.400Z')])).toBe('处理过程')
  })
})

describe('turn folding', () => {
  const turn = (n: number, at = (s: number) => `2026-10-25T10:0${n}:${String(s).padStart(2, '0')}.000Z`): ChatItem[] => [
    stamped(user(`u${n}`), at(0)),
    stamped(assistant(`pre${n}`, '先看一下'), at(2)),
    stamped(tool(`r${n}`, 'Read', { file_path: '/a.ts' }, { result: 'ok' }), at(3)),
    stamped(tool(`b${n}`, 'Bash', { command: 'ls' }, { result: 'ok' }), at(4)),
    stamped(assistant(`final${n}`, '完成了'), at(30)),
  ]

  test('a settled turn folds everything before the final reply into one timed row', () => {
    const rows = buildChatRows(turn(1), false)
    expect(rows.map((row) => row.key)).toEqual(['u1', 'turn:pre1', 'pre1', 'steps:r1', 'final1'])
    expect(rows[1]).toMatchObject({ kind: 'turn', label: '用时 30 秒', hidden: 2 })
    expect(rows[2]).toMatchObject({ turn: 'turn:pre1' })
    expect(rows[3]).toMatchObject({ kind: 'steps', turn: 'turn:pre1', turnEnd: true })
    expect(rows[4]).not.toHaveProperty('turn')
  })

  test('closed folds hide their rows, open folds show them, the fold row and final reply always stay', () => {
    const rows = buildChatRows(turn(1), false)
    expect(visibleChatRows(rows, new Set()).map((row) => row.key)).toEqual(['u1', 'turn:pre1', 'final1'])
    expect(visibleChatRows(rows, new Set(['turn:pre1'])).map((row) => row.key)).toEqual(rows.map((row) => row.key))
  })

  test('the running turn is never folded, earlier turns are', () => {
    const items = [...turn(1), ...turn(2)]
    const running = buildChatRows(items, true)
    expect(running.filter((row) => row.kind === 'turn').map((row) => row.key)).toEqual(['turn:pre1'])
    const settled = buildChatRows(items, false)
    expect(settled.filter((row) => row.kind === 'turn').map((row) => row.key)).toEqual(['turn:pre1', 'turn:pre2'])
  })

  test('a turn without tool steps has nothing to fold', () => {
    const rows = buildChatRows([user('u'), assistant('a')], false)
    expect(rowKinds(rows)).toEqual(['message', 'message'])
  })

  test('errors stay visible and a turn that ends on tools folds into just the row', () => {
    const rows = buildChatRows(
      [user('u'), tool('r', 'Read', {}), { id: 'e', type: 'error', text: '出错了' }, tool('b', 'Bash', {})],
      false
    )
    const visible = visibleChatRows(rows, new Set())
    expect(visible.map((row) => row.key)).toEqual(['u', 'turn:steps:r', 'e'])
  })

  test('the latest turn takes its duration from the local clock when messages carry no time', () => {
    const items = [user('u'), tool('r', 'Read', {}), assistant('a')]
    const rows = buildChatRows(items, false, { clock: { startedAt: 1_000, endedAt: 1_000 + 192_000 } })
    expect(rows.find((row) => row.kind === 'turn')).toMatchObject({ label: '用时 3 分 12 秒' })
    // The clock describes the latest turn only.
    const two = buildChatRows([user('u0'), tool('r0', 'Read', {}), assistant('a0'), ...items], false, {
      clock: { startedAt: 1_000, endedAt: 61_000 },
    })
    expect(two.filter((row) => row.kind === 'turn').map((row) => row.kind === 'turn' && row.label)).toEqual(['处理过程', '用时 1 分'])
  })

  test('fold keys survive the turn finishing, so a user choice made while streaming is not lost', () => {
    const live = buildChatRows([user('u'), assistant('p'), tool('r', 'Read', {})], true)
    expect(live.some((row) => row.kind === 'turn')).toBe(false)
    const done = buildChatRows([user('u'), assistant('p'), tool('r', 'Read', {}), assistant('f')], false)
    expect(done.find((row) => row.kind === 'turn')?.key).toBe('turn:p')
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


describe('turn fold keeps substantial replies visible', () => {
  const user = { id: 'u', type: 'user', text: 'go' } as ChatItem
  const tool = (id: string) => ({ id, type: 'tool', toolName: 'Read', toolUseId: id, input: { file_path: '/a' }, result: 'ok' }) as ChatItem
  const say = (id: string, text: string) => ({ id, type: 'assistant', text }) as ChatItem

  test('a long summary that is followed by one more tool call stays outside the fold', () => {
    const summary = '汇总如下：' + '这个函数返回新数组，不修改原数组。'.repeat(12)
    const rows = buildChatRows([user, tool('t1'), say('a1', summary), tool('t2'), say('a2', '后台命令已完成。')], false)
    const visible = visibleChatRows(rows, new Set()).filter((row) => row.kind === 'message')
    expect(visible.map((row) => (row as { item: ChatItem }).item.id)).toEqual(['u', 'a1', 'a2'])
  })

  test('markdown tables and code blocks count as substantial even when short', () => {
    expect(isSubstantialReply(say('x', '| a | b |\n|---|---|\n| 1 | 2 |'))).toBe(true)
    expect(isSubstantialReply(say('x', '```ts\nlet a = 1\n```'))).toBe(true)
    expect(isSubstantialReply(say('x', '接下来跑一遍相关测试。'))).toBe(false)
  })

  test('short narration before the last tool call is still folded', () => {
    const rows = buildChatRows([user, say('a0', '先看看文件。'), tool('t1'), say('a1', '完成。')], false)
    const visible = visibleChatRows(rows, new Set()).filter((row) => row.kind === 'message')
    expect(visible.map((row) => (row as { item: ChatItem }).item.id)).toEqual(['u', 'a1'])
  })
})

describe('turn fold never hides the answer or a failure silently', () => {
  const user = { id: 'u', type: 'user', text: '修一下' } as ChatItem
  const tool = (id: string, patch: Partial<ChatItem> = {}) =>
    ({ id, type: 'tool', toolName: 'Bash', toolUseId: id, input: { command: 'bun test' }, result: 'ok', ...patch }) as ChatItem
  const say = (id: string, text: string) => ({ id, type: 'assistant', text }) as ChatItem
  const visibleIds = (items: ChatItem[]) =>
    visibleChatRows(buildChatRows(items, false), new Set())
      .filter((row) => row.kind === 'message')
      .map((row) => (row as { item: ChatItem }).item.id)

  test('a short last reply followed by a closing tool call stays visible', () => {
    expect(visibleIds([user, tool('t1'), say('a', '好了，已完成。'), tool('t2', { toolName: 'TodoWrite', input: { todos: [] } })])).toEqual([
      'u',
      'a',
    ])
  })

  test('earlier short narration is still folded, only the last reply is kept', () => {
    expect(visibleIds([user, say('a0', '先看看文件。'), tool('t1'), say('a1', '再跑一遍。'), tool('t2'), say('a2', '完成。'), tool('t3')])).toEqual([
      'u',
      'a2',
    ])
  })

  test('failed tool calls are counted on the fold label', () => {
    const items = [user, tool('t1', { isError: true }), tool('t2', { isError: true }), tool('t3'), say('a', '完成')]
    const label = (buildChatRows(items, false).find((row) => row.kind === 'turn') as { label: string }).label
    expect(label).toBe('处理过程 · 2 步失败')
    expect(turnFoldLabel(user, [tool('x')])).toBe('处理过程')
  })
})
