import { describe, expect, test } from 'bun:test'
import type { ChatItem } from '../../core/types'
import { captionParts, currentStepLabel, pendingStepLabel } from './captionModel'

const tool = (id: string, toolName: string, input: unknown, patch: Partial<ChatItem> = {}): ChatItem => ({
  id,
  type: 'tool',
  text: '',
  toolName,
  toolUseId: id,
  input,
  ...patch,
})
const user = (id: string): ChatItem => ({ id, type: 'user', text: 'Do something' })
const done = { result: 'ok', pending: false }

describe('currentStepLabel', () => {
  test('Take the most recent tool call without a result', () => {
    const items = [
      user('u'),
      tool('a', 'Read', { file_path: '/repo/a.ts' }, done),
      tool('b', 'Bash', { command: 'bun test src/core/connectHost.test.ts' }, { pending: true }),
    ]
    expect(currentStepLabel(items)).toMatchObject({ verb: 'Run', object: 'bun test src/core/connectHost.test.ts', mono: true })
  })
  test('Sessions opened from history have no pending flag, only no result, and still count as in progress', () => {
    expect(currentStepLabel([user('u'), tool('a', 'Read', { file_path: '/repo/a.ts' })], '/repo')).toMatchObject({
      verb: 'Read',
      object: 'a.ts',
    })
  })
  test('All have results, no tools, or the last is a user message: no current step', () => {
    expect(currentStepLabel([user('u'), tool('a', 'Read', {}, done)])).toBeNull()
    expect(currentStepLabel([])).toBeNull()
    expect(currentStepLabel([tool('a', 'Bash', { command: 'x' }, { pending: true }), user('u')])).toBeNull()
  })
  test('Only after the latest user message; unfinished tools from an earlier turn do not count', () => {
    expect(currentStepLabel([tool('old', 'Bash', { command: 'x' }), user('u2')])).toBeNull()
  })
  test('Steps inside a subagent (with parentToolUseId) are not what the main agent is currently doing', () => {
    const items = [
      user('u'),
      tool('agent', 'Agent', { description: 'Sort out', subagent_type: 'explorer' }, { pending: true }),
      tool('inner', 'Read', { file_path: '/repo/x.ts' }, { pending: true, parentToolUseId: 'agent' }),
    ]
    expect(currentStepLabel(items)).toMatchObject({ verb: 'Subagent', object: 'Sort out' })
  })
  test('With several unfinished tools take the last one', () => {
    const items = [
      user('u'),
      tool('a', 'Read', { file_path: '/a' }, { pending: true }),
      tool('b', 'Grep', { pattern: 'foo' }, { pending: true }),
    ]
    expect(currentStepLabel(items)?.verb).toBe('Search')
  })
})

describe('captionParts Text', () => {
  test('Running: “currently” + verb, keeping the object’s font semantics', () => {
    expect(captionParts({ step: { verb: 'Run', object: 'bun test', mono: true } })).toEqual({
      tone: 'run',
      lead: 'Running',
      object: 'bun test',
      mono: true,
    })
    expect(captionParts({ step: { verb: 'Web search', object: 'weather', mono: false } })).toMatchObject({
      lead: 'Searching the web',
      object: 'weather',
      mono: false,
    })
  })
  test('No tools: thinking; compacting context takes priority over steps', () => {
    expect(captionParts({})).toEqual({ tone: 'run', lead: 'Thinking', mono: false })
    expect(captionParts({ step: null })).toMatchObject({ lead: 'Thinking' })
    expect(captionParts({ compacting: true, step: { verb: 'Run', mono: true } })).toEqual({
      tone: 'run',
      lead: 'Compacting context',
      mono: false,
    })
  })
  test('Wording for thinking blocks, subagents and unknown tools never reads as broken sentences', () => {
    expect(captionParts({ step: { verb: 'Thinking process', mono: false } }).lead).toBe('Thinking')
    expect(captionParts({ step: { verb: 'Subagent', object: 'Sort out', mono: false } }).lead).toBe('Running subagent')
    expect(captionParts({ step: { verb: 'CustomTool', object: 'x', mono: false } }).lead).toBe('Calling CustomTool')
  })
  test('Waiting for your approval: amber, naming which step is being approved; with no step only say waiting for your approval', () => {
    expect(captionParts({ waiting: true, step: { verb: 'Run', object: 'bun test src/core/connectHost.test.ts', mono: true } })).toEqual({
      tone: 'attention',
      lead: 'Waiting for your approval · Run',
      object: 'bun test src/core/connectHost.test.ts',
      mono: true,
    })
    expect(captionParts({ waiting: true })).toMatchObject({ tone: 'attention', lead: 'Waiting for your approval' })
    expect(captionParts({ waiting: true, step: { verb: 'Thinking process', mono: false } })).toMatchObject({ lead: 'Waiting for your approval' })
  })
  test('Waiting for approval takes priority over compacting context', () => {
    expect(captionParts({ waiting: true, compacting: true }).tone).toBe('attention')
  })
})

describe('pendingStepLabel', () => {
  test('With parallel calls it refers to the one waiting for approval, not the last one', () => {
    const items = [
      user('u'),
      tool('edit-a', 'Edit', { file_path: '/p/src/todo.ts', old_string: 'a', new_string: 'b' }),
      tool('edit-b', 'Edit', { file_path: '/p/README.md', old_string: 'a', new_string: 'b' }),
    ]
    expect(currentStepLabel(items, '/p')?.object).toContain('README.md')
    expect(pendingStepLabel(items, 'edit-a', '/p')?.object).toContain('src/todo.ts')
  })
  test('Returns when no matching call or no id is found null', () => {
    const items = [user('u'), tool('t', 'Bash', { command: 'bun test' })]
    expect(pendingStepLabel(items, 'missing')).toBeNull()
    expect(pendingStepLabel(items, undefined)).toBeNull()
  })
})
