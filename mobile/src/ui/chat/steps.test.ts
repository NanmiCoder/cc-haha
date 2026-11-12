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
  groupIsOpen,
  isSubstantialReply,
  lineDiff,
  outputTail,
  relativePath,
  summarizeActivity,
  toggleGroupOpen,
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
const user = (id: string, text = 'Question'): ChatItem => ({ id, type: 'user', text })
const assistant = (id: string, text = 'Reply'): ChatItem => ({ id, type: 'assistant', text })

const stamped = (item: ChatItem, at: string): ChatItem => ({ ...item, timestamp: at })
const rowKinds = (rows: ReturnType<typeof buildChatRows>) => rows.map((row) => row.kind)

describe('step grouping', () => {
  test('merges consecutive tools and thinking into one group between messages', () => {
    const rows = buildChatRows(
      [
        user('u1'),
        assistant('a1'),
        { id: 't1', type: 'thinking', text: 'Think about it' },
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
    expect(group.kind === 'steps' && activityLabel(group.segments)).toBe('Thinking · Read 1 file · Ran 1 command')
  })

  test('a finished turn keeps the screenshots it read visible on its fold line', () => {
    const shot = { mimeType: 'image/png', url: '/api/sessions/s/tool-images/r1/0', width: 1920, height: 1139 }
    const items: ChatItem[] = [
      user('u1'),
      { ...tool('r1', 'Read', { file_path: '/tmp/todo/shot-final.png' }), images: [shot] },
      tool('b1', 'Bash', { command: 'ls' }),
      assistant('a1'),
    ]
    const settled = buildChatRows(items, false)
    expect(rowKinds(settled)).toEqual(['message', 'turn', 'steps', 'message'])
    const fold = settled[1]
    expect(fold.kind === 'turn' && fold.images).toEqual([{ image: shot, name: 'shot-final.png' }])
    // While the turn runs there is no fold; the step group shows the image itself.
    expect(buildChatRows(items, true).some((row) => row.kind === 'turn')).toBe(false)
    // Turns without images carry no image list.
    const plain = buildChatRows([user('u1'), tool('b1', 'Bash', {}), assistant('a1')], false)
    expect(plain.find((row) => row.kind === 'turn')).not.toHaveProperty('images')
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
    expect(activityLabel(segments)).toBe('Read 3 files · Ran 2 commands')
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
    ).toBe('Read 1 file · Edited 4 files · Created 1 file')
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
      'Thinking · Searched 2 times · Found files · Searched the web · Opened 1 web page · Dispatched 1 subagent · Updated todos · Called github 2 times · Called SomeNewTool'
    )
  })

  test('thinking alone is still a one-line summary; several thoughts are counted', () => {
    expect(activityLabel(summarizeActivity([{ id: 't', type: 'thinking', text: '' }]))).toBe('Thinking')
    expect(
      activityLabel(
        summarizeActivity([
          { id: 't1', type: 'thinking', text: '' },
          tool('1', 'Read', { file_path: '/a' }),
          { id: 't2', type: 'thinking', text: '' },
        ])
      )
    ).toBe('Thought 2 times · Read 1 file')
  })
})

describe('step group disclosure', () => {
  test('live groups open by default and manual choices survive live and settled states', () => {
    let ui = { open: new Set<string>(), closed: new Set<string>() }
    expect(groupIsOpen(ui, 'steps:r1', true)).toBe(true)
    expect(groupIsOpen(ui, 'steps:r1', false)).toBe(false)
    ui = toggleGroupOpen(ui, 'steps:r1', true)
    expect(groupIsOpen(ui, 'steps:r1', true)).toBe(false)
    expect(groupIsOpen(ui, 'steps:r1', false)).toBe(false)
    ui = toggleGroupOpen(ui, 'steps:r1', true)
    expect(groupIsOpen(ui, 'steps:r1', true)).toBe(true)
    expect(groupIsOpen(ui, 'steps:r1', false)).toBe(true)
    expect(groupIsOpen(ui, 'steps:r2', true)).toBe(true)
  })

  test('turn folds still toggle independently without changing the old UI state', () => {
    const initial = { open: new Set<string>(), closed: new Set<string>(), expanded: new Set(['tool-1']) }
    const opened = toggleGroupOpen(initial, 'turn:steps:r1')
    expect(opened.open.has('turn:steps:r1')).toBe(true)
    expect(initial.open.size).toBe(0)
    expect(opened.expanded).toBe(initial.expanded)
    const closed = toggleGroupOpen(opened, 'turn:steps:r1')
    expect(closed.open.has('turn:steps:r1')).toBe(false)
    expect(opened.open.has('turn:steps:r1')).toBe(true)
  })
})

describe('group status tail', () => {
  test('approval outranks failure outranks background; finished groups say nothing', () => {
    expect(groupTail(['done', 'missing'])).toBeNull()
    expect(groupTail(['done', 'background'])).toEqual({ text: 'Running in background', tone: 'run' })
    expect(groupTail(['error', 'background'])).toEqual({ text: 'Failed', tone: 'err' })
    expect(groupTail(['error', 'done', 'error'])).toEqual({ text: '2 failed', tone: 'err' })
    expect(groupTail(['error', 'waiting', 'background'])).toEqual({ text: 'Waiting for your approval', tone: 'attn' })
  })
})

describe('turn duration', () => {
  test('formats seconds, minutes and hours the way the board reads', () => {
    expect(formatTurnDuration(800)).toBe('')
    expect(formatTurnDuration(1000)).toBe('1 sec')
    expect(formatTurnDuration(45_900)).toBe('45 sec')
    expect(formatTurnDuration(60_000)).toBe('1 min')
    expect(formatTurnDuration(192_000)).toBe('3 min 12 sec')
    expect(formatTurnDuration(3_600_000)).toBe('1 h')
    expect(formatTurnDuration(3_720_000 + 30_000)).toBe('1 h 2 min')
    expect(formatTurnDuration(Number.NaN)).toBe('')
  })

  test('uses message times, falls back to the local clock, and never invents a number', () => {
    const u = stamped(user('u'), '2026-10-25T10:00:00.000Z')
    const last = stamped(assistant('a'), '2026-10-25T10:03:12.000Z')
    expect(turnFoldLabel(u, [last])).toBe('Took 3 min 12 sec')
    const start = Date.parse('2026-10-25T10:00:00.000Z')
    expect(turnFoldLabel(user('u2'), [assistant('a2')], { startedAt: start, endedAt: start + 45_000 })).toBe('Took 45 sec')
    expect(turnFoldLabel(user('u3'), [assistant('a3')])).toBe('Process')
    expect(turnFoldLabel(u, [stamped(assistant('b'), '2026-10-25T10:00:00.400Z')])).toBe('Process')
  })
})

describe('turn folding', () => {
  const turn = (n: number, at = (s: number) => `2026-10-25T10:0${n}:${String(s).padStart(2, '0')}.000Z`): ChatItem[] => [
    stamped(user(`u${n}`), at(0)),
    stamped(assistant(`pre${n}`, 'Take a look first'), at(2)),
    stamped(tool(`r${n}`, 'Read', { file_path: '/a.ts' }, { result: 'ok' }), at(3)),
    stamped(tool(`b${n}`, 'Bash', { command: 'ls' }, { result: 'ok' }), at(4)),
    stamped(assistant(`final${n}`, 'Finished'), at(30)),
  ]

  test('a settled turn folds everything before the final reply into one timed row', () => {
    const rows = buildChatRows(turn(1), false)
    expect(rows.map((row) => row.key)).toEqual(['u1', 'turn:pre1', 'pre1', 'steps:r1', 'final1'])
    expect(rows[1]).toMatchObject({ kind: 'turn', label: 'Took 30 sec', hidden: 2 })
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
      [user('u'), tool('r', 'Read', {}), { id: 'e', type: 'error', text: 'Something went wrong' }, tool('b', 'Bash', {})],
      false
    )
    const visible = visibleChatRows(rows, new Set())
    expect(visible.map((row) => row.key)).toEqual(['u', 'turn:steps:r', 'e'])
  })

  test('the latest turn takes its duration from the local clock when messages carry no time', () => {
    const items = [user('u'), tool('r', 'Read', {}), assistant('a')]
    const rows = buildChatRows(items, false, { clock: { startedAt: 1_000, endedAt: 1_000 + 192_000 } })
    expect(rows.find((row) => row.kind === 'turn')).toMatchObject({ label: 'Took 3 min 12 sec' })
    // The clock describes the latest turn only.
    const two = buildChatRows([user('u0'), tool('r0', 'Read', {}), assistant('a0'), ...items], false, {
      clock: { startedAt: 1_000, endedAt: 61_000 },
    })
    expect(two.filter((row) => row.kind === 'turn').map((row) => row.kind === 'turn' && row.label)).toEqual(['Process', 'Took 1 min'])
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
      verb: 'Read',
      object: 'src/app/connect.tsx',
      mono: true,
    })
    expect(label('Write', { file_path: '/elsewhere/a.md' })).toMatchObject({ verb: 'Write', object: '/elsewhere/a.md' })
    expect(label('Bash', { command: 'bun test src\n&& echo done' })).toMatchObject({ verb: 'Run', object: 'bun test src' })
    expect(label('Grep', { pattern: 'useTheme' })).toMatchObject({ verb: 'Search', object: 'useTheme', mono: true })
    expect(label('Glob', { pattern: '**/*.tsx' })).toMatchObject({ verb: 'Find', object: '**/*.tsx' })
    expect(label('WebFetch', { url: 'https://example.com' })).toMatchObject({ verb: 'Open', mono: true })
    expect(label('WebSearch', { query: 'expo router' })).toMatchObject({ verb: 'Web search', object: 'expo router', mono: false })
    expect(label('Task', { description: 'Build the scan page UI' })).toMatchObject({ verb: 'Subagent', object: 'Build the scan page UI', mono: false })
    expect(label('Agent', { description: 'Run tests' })).toMatchObject({ verb: 'Subagent', object: 'Run tests' })
    expect(label('TodoWrite', { todos: [{}, {}, {}] })).toMatchObject({ verb: 'Updated todos', object: '3 items' })
    expect(label('mcp__github__create_issue', { title: 'x' })).toMatchObject({ verb: 'Called', object: 'github · create_issue', mono: true })
    expect(label('ExitPlanMode', { plan: '# plan' })).toMatchObject({ verb: 'Submit plan', mono: false })
    expect(label('AskUserQuestion', { questions: [{ question: 'How should old fields be handled?' }] })).toMatchObject({ verb: 'Ask', object: 'How should old fields be handled?' })
    expect(label('SomeNewTool', { description: 'Do something' })).toMatchObject({ verb: 'SomeNewTool', object: 'Do something' })
    expect(describeStep({ id: 't', type: 'thinking', text: '...' })).toEqual({ verb: 'Thinking process', mono: false })
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
      verb: 'Edit',
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
    expect(lines.filter((line) => line.kind === 'hunk').map((line) => line.text)).toEqual(['Change 1', 'Change 2'])
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
    const summary = 'Summary: ' + 'This function returns a new array and does not modify the original.'.repeat(12)
    const rows = buildChatRows([user, tool('t1'), say('a1', summary), tool('t2'), say('a2', 'Background command finished.')], false)
    const visible = visibleChatRows(rows, new Set()).filter((row) => row.kind === 'message')
    expect(visible.map((row) => (row as { item: ChatItem }).item.id)).toEqual(['u', 'a1', 'a2'])
  })

  test('markdown tables and code blocks count as substantial even when short', () => {
    expect(isSubstantialReply(say('x', '| a | b |\n|---|---|\n| 1 | 2 |'))).toBe(true)
    expect(isSubstantialReply(say('x', '```ts\nlet a = 1\n```'))).toBe(true)
    expect(isSubstantialReply(say('x', 'Next, run the related tests.'))).toBe(false)
  })

  test('short narration before the last tool call is still folded', () => {
    const rows = buildChatRows([user, say('a0', 'Let me look at the file first.'), tool('t1'), say('a1', 'Done.')], false)
    const visible = visibleChatRows(rows, new Set()).filter((row) => row.kind === 'message')
    expect(visible.map((row) => (row as { item: ChatItem }).item.id)).toEqual(['u', 'a1'])
  })
})

describe('turn fold never hides the answer or a failure silently', () => {
  const user = { id: 'u', type: 'user', text: 'Fix it' } as ChatItem
  const tool = (id: string, patch: Partial<ChatItem> = {}) =>
    ({ id, type: 'tool', toolName: 'Bash', toolUseId: id, input: { command: 'bun test' }, result: 'ok', ...patch }) as ChatItem
  const say = (id: string, text: string) => ({ id, type: 'assistant', text }) as ChatItem
  const visibleIds = (items: ChatItem[]) =>
    visibleChatRows(buildChatRows(items, false), new Set())
      .filter((row) => row.kind === 'message')
      .map((row) => (row as { item: ChatItem }).item.id)

  test('a short last reply followed by a closing tool call stays visible', () => {
    expect(visibleIds([user, tool('t1'), say('a', 'OK, done.'), tool('t2', { toolName: 'TodoWrite', input: { todos: [] } })])).toEqual([
      'u',
      'a',
    ])
  })

  test('earlier short narration is still folded, only the last reply is kept', () => {
    expect(visibleIds([user, say('a0', 'Let me look at the file first.'), tool('t1'), say('a1', 'Run it again.'), tool('t2'), say('a2', 'Done.'), tool('t3')])).toEqual([
      'u',
      'a2',
    ])
  })

  test('failed tool calls are counted on the fold label', () => {
    const items = [user, tool('t1', { isError: true }), tool('t2', { isError: true }), tool('t3'), say('a', 'Done')]
    const label = (buildChatRows(items, false).find((row) => row.kind === 'turn') as { label: string }).label
    expect(label).toBe('Process · 2 steps failed')
    expect(turnFoldLabel(user, [tool('x')])).toBe('Process')
  })
})
