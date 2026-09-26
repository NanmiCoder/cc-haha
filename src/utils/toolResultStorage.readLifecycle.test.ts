import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { normalizePathForComparison } from './file.js'
import { expandPath } from './path.js'
import { FILE_UNCHANGED_STUB } from '../tools/FileReadTool/prompt.js'
import {
  clearReadFileStateForReplacements,
  createContentReplacementState,
  getReadReplacementPaths,
  applyToolResultBudget,
  cloneContentReplacementState,
  enforceToolResultBudget,
  LARGE_READ_RESULT_CLEARED_MESSAGE,
  markReadProviderRequestCompleted,
  prepareReadProviderRequestForQuery,
  reconstructContentReplacementState,
  reconstructForSubagentResume,
  TOOL_RESULT_CLEARED_MESSAGE,
} from './toolResultStorage.js'

const readSkip = new Set(['Read'])

function messagesFor(
  entries: Array<{
    id: string
    name: string
    path?: string
    content?: string
    error?: boolean
  }>,
): Message[] {
  return entries.flatMap(entry => {
    const input = entry.path ? { file_path: entry.path } : {}
    return [
      {
        type: 'assistant',
        message: {
          id: `assistant-${entry.id}`,
          role: 'assistant',
          content: [
            { type: 'tool_use', id: entry.id, name: entry.name, input },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: entry.id,
              is_error: entry.error,
              content: entry.content ?? '',
            },
          ],
        },
      },
    ] as Message[]
  })
}

function resultContent(messages: Message[], id: string): unknown {
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    const block = message.message.content.find(
      item => item.type === 'tool_result' && item.tool_use_id === id,
    )
    if (block && block.type === 'tool_result') return block.content
  }
  return undefined
}

async function consume(
  messages: Message[],
  state: ReturnType<typeof createContentReplacementState>,
) {
  const first = await enforceToolResultBudget(messages, state, readSkip)
  markReadProviderRequestCompleted(state)
  return { first, second: await enforceToolResultBudget(messages, state, readSkip) }
}

describe('incremental Read result lifecycle', () => {
  test('keeps one large Read until a successful provider request completes', async () => {
    const messages = messagesFor([{ id: 'r1', name: 'Read', path: 'src/a.ts', content: 'x'.repeat(30_000) }])
    const state = createContentReplacementState()
    const first = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(first.messages, 'r1')).toBe('x'.repeat(30_000))
    const retry = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(retry.messages, 'r1')).toBe('x'.repeat(30_000))
    markReadProviderRequestCompleted(state)
    const after = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(after.messages, 'r1')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(after.newlyReplaced).toEqual([
      { kind: 'tool-result', toolUseId: 'r1', replacement: LARGE_READ_RESULT_CLEARED_MESSAGE },
    ])
  })

  test('clears the entire group only above the threshold and keeps groups separated by other tools', async () => {
    const state = createContentReplacementState()
    const under = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(10_000) },
      { id: 'r2', name: 'Read', path: 'src/b.ts', content: 'b'.repeat(10_000) },
    ])
    const underState = createContentReplacementState()
    await consume(under, underState)
    const underResult = await enforceToolResultBudget(under, underState, readSkip)
    expect(resultContent(underResult.messages, 'r1')).toBe('a'.repeat(10_000))
    expect(resultContent(underResult.messages, 'r2')).toBe('b'.repeat(10_000))

    const largeState = createContentReplacementState()
    const large = messagesFor([
      { id: 'r3', name: 'Read', path: 'src/c.ts', content: 'c'.repeat(10_000) },
      { id: 'r4', name: 'Read', path: 'src/d.ts', content: 'd'.repeat(10_000) },
      { id: 'r5', name: 'Read', path: 'src/e.ts', content: 'e'.repeat(10_000) },
    ])
    const first = await enforceToolResultBudget(large, largeState, readSkip)
    markReadProviderRequestCompleted(largeState)
    const after = await enforceToolResultBudget(large, largeState, readSkip)
    expect(resultContent(after.messages, 'r3')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(resultContent(after.messages, 'r4')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(resultContent(after.messages, 'r5')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(first.messages).toHaveLength(6)

    const separated = messagesFor([
      { id: 'r6', name: 'Read', path: 'src/f.ts', content: 'f'.repeat(20_000) },
      { id: 'g1', name: 'Grep', content: 'match' },
      { id: 'r7', name: 'Read', path: 'src/g.ts', content: 'g'.repeat(20_000) },
    ])
    const separatedState = createContentReplacementState()
    await enforceToolResultBudget(separated, separatedState, readSkip)
    markReadProviderRequestCompleted(separatedState)
    const separatedAfter = await enforceToolResultBudget(separated, separatedState, readSkip)
    expect(resultContent(separatedAfter.messages, 'r6')).toBe('f'.repeat(20_000))
    expect(resultContent(separatedAfter.messages, 'r7')).toBe('g'.repeat(20_000))
  })

  test('ordinary assistant text does not end a Read group', async () => {
    const messages = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(15_000) },
    ])
    messages.push({
      type: 'assistant',
      message: { id: 'text', role: 'assistant', content: [{ type: 'text', text: 'context' }] },
    } as Message)
    messages.push(...messagesFor([{ id: 'r2', name: 'Read', path: './src/b.ts', content: 'b'.repeat(15_000) }]))
    const state = createContentReplacementState()
    await enforceToolResultBudget(messages, state, readSkip)
    markReadProviderRequestCompleted(state)
    const after = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(after.messages, 'r1')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(resultContent(after.messages, 'r2')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
  })

  test('carries a Read group across provider rounds', async () => {
    const state = createContentReplacementState()
    const firstRound = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(15_000) },
    ])
    await enforceToolResultBudget(firstRound, state, readSkip)
    markReadProviderRequestCompleted(state)
    const secondRound = [
      ...firstRound,
      ...messagesFor([
        { id: 'r2', name: 'Read', path: 'src/b.ts', content: 'b'.repeat(15_000) },
      ]),
    ]
    const before = await enforceToolResultBudget(secondRound, state, readSkip)
    expect(resultContent(before.messages, 'r1')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(resultContent(before.messages, 'r2')).toBe('b'.repeat(15_000))
    markReadProviderRequestCompleted(state)
    const after = await enforceToolResultBudget(secondRound, state, readSkip)
    expect(resultContent(after.messages, 'r1')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(resultContent(after.messages, 'r2')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
  })

  test('successful Edit invalidates old Reads, failed Edit leaves them usable', async () => {
    const read = messagesFor([{ id: 'r1', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(100) }])
    const state = createContentReplacementState()
    await consume(read, state)
    const failed = [...read, ...messagesFor([{ id: 'e1', name: 'Edit', path: './src/a.ts', error: true, content: 'failed' }])]
    const failedResult = await enforceToolResultBudget(failed, state, readSkip)
    expect(resultContent(failedResult.messages, 'r1')).toBe('a'.repeat(100))
    markReadProviderRequestCompleted(state)

    const successful = [...read, ...messagesFor([{ id: 'e2', name: 'Edit', path: './src/a.ts', content: 'updated' }])]
    const before = await enforceToolResultBudget(successful, state, readSkip)
    expect(resultContent(before.messages, 'r1')).toBe('a'.repeat(100))
    expect(before.newlyReplaced).not.toContainEqual({
      kind: 'tool-result',
      toolUseId: 'r1',
      replacement: TOOL_RESULT_CLEARED_MESSAGE,
    })
    markReadProviderRequestCompleted(state)
    const after = await enforceToolResultBudget(successful, state, readSkip)
    expect(resultContent(after.messages, 'r1')).toBe(TOOL_RESULT_CLEARED_MESSAGE)
  })

  test('only the old Read is cleared when a file is read again after Edit', async () => {
    const oldRead = messagesFor([{ id: 'r1', name: 'Read', path: 'src/a.ts', content: 'old' }])
    const edit = messagesFor([{ id: 'e1', name: 'Edit', path: 'src/a.ts', content: 'updated' }])
    const newRead = messagesFor([{ id: 'r2', name: 'Read', path: './src/a.ts', content: 'new' }])
    const state = createContentReplacementState()
    await consume(oldRead, state)
    markReadProviderRequestCompleted(state)
    const all = [...oldRead, ...edit, ...newRead]
    const before = await enforceToolResultBudget(all, state, readSkip)
    expect(resultContent(before.messages, 'r1')).toBe('old')
    expect(resultContent(before.messages, 'r2')).toBe('new')
    markReadProviderRequestCompleted(state)
    const result = await enforceToolResultBudget(all, state, readSkip)
    expect(resultContent(result.messages, 'r1')).toBe(TOOL_RESULT_CLEARED_MESSAGE)
    expect(resultContent(result.messages, 'r2')).toBe('new')
  })

  test('repeated successful edits do not create duplicate replacements', async () => {
    const read = messagesFor([{ id: 'r1', name: 'Read', path: 'src/a.ts', content: 'old' }])
    const edits = [
      ...messagesFor([{ id: 'e1', name: 'Edit', path: 'src/a.ts', content: 'one' }]),
      ...messagesFor([{ id: 'e2', name: 'Edit', path: './src/a.ts', content: 'two' }]),
    ]
    const state = createContentReplacementState()
    await consume(read, state)
    markReadProviderRequestCompleted(state)
    const first = await enforceToolResultBudget([...read, ...edits], state, readSkip)
    expect(resultContent(first.messages, 'r1')).toBe('old')
    markReadProviderRequestCompleted(state)
    const second = await enforceToolResultBudget([...read, ...edits], state, readSkip)
    expect(first.newlyReplaced).toHaveLength(0)
    expect(second.newlyReplaced).toHaveLength(1)
    expect(resultContent(second.messages, 'r1')).toBe(TOOL_RESULT_CLEARED_MESSAGE)
  })

  test('successful Write invalidates the previous Read for the same normalized path', async () => {
    const read = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'old' },
    ])
    const write = messagesFor([
      { id: 'w1', name: 'Write', path: './src/a.ts', content: 'new' },
    ])
    const state = createContentReplacementState()
    await consume(read, state)
    markReadProviderRequestCompleted(state)
    const before = await enforceToolResultBudget(
      [...read, ...write],
      state,
      readSkip,
    )
    expect(resultContent(before.messages, 'r1')).toBe('old')
    markReadProviderRequestCompleted(state)
    const result = await enforceToolResultBudget([...read, ...write], state, readSkip)
    expect(resultContent(result.messages, 'r1')).toBe(TOOL_RESULT_CLEARED_MESSAGE)
  })

  test('states remain isolated and resume reapplies persisted replacements', async () => {
    const messages = messagesFor([{ id: 'r1', name: 'Read', path: 'src/a.ts', content: 'x'.repeat(30_000) }])
    const main = createContentReplacementState()
    const sub = createContentReplacementState()
    await enforceToolResultBudget(messages, main, readSkip)
    await enforceToolResultBudget(messages, sub, readSkip)
    markReadProviderRequestCompleted(main)
    const mainAfter = await enforceToolResultBudget(messages, main, readSkip)
    expect(resultContent(mainAfter.messages, 'r1')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(resultContent((await enforceToolResultBudget(messages, sub, readSkip)).messages, 'r1')).toBe('x'.repeat(30_000))

    const resumed = reconstructContentReplacementState(messages, mainAfter.newlyReplaced)
    expect(getReadReplacementPaths(resumed)).toEqual(
      new Set([normalizePathForComparison(expandPath('src/a.ts'))]),
    )
    const resumedResult = await enforceToolResultBudget(messages, resumed, readSkip)
    expect(resultContent(resumedResult.messages, 'r1')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(resultContent(messages, 'r1')).toBe('x'.repeat(30_000))

    const oldRead = messagesFor([{ id: 'old', name: 'Read', path: 'src/resume.ts', content: 'old' }])
    const edit = messagesFor([{ id: 'edit', name: 'Edit', path: 'src/resume.ts', content: 'updated' }])
    const currentRead = messagesFor([{ id: 'current', name: 'Read', path: './src/resume.ts', content: 'current' }])
    const currentResumed = reconstructContentReplacementState(
      [...oldRead, ...edit, ...currentRead],
      [{ kind: 'tool-result', toolUseId: 'old', replacement: TOOL_RESULT_CLEARED_MESSAGE }],
    )
    expect(getReadReplacementPaths(currentResumed)).toEqual(new Set())

    const parent = createContentReplacementState()
    const parentReads = messagesFor([
      { id: 'p1', name: 'Read', path: 'src/p.ts', content: 'p'.repeat(20_000) },
    ])
    await enforceToolResultBudget(parentReads, parent, readSkip)
    const child = cloneContentReplacementState(parent)
    const childReads = messagesFor([
      { id: 'c1', name: 'Read', path: 'src/c.ts', content: 'c'.repeat(10_000) },
    ])
    await enforceToolResultBudget(childReads, child, readSkip)
    markReadProviderRequestCompleted(child)
    const childAfter = await enforceToolResultBudget(childReads, child, readSkip)
    expect(resultContent(childAfter.messages, 'c1')).toBe('c'.repeat(10_000))
  })

  test('does not retain an in-memory replacement when persistence fails', async () => {
    const messages = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'x'.repeat(30_000) },
    ])
    const state = createContentReplacementState()
    await applyToolResultBudget(messages, state, undefined, readSkip)
    markReadProviderRequestCompleted(state)
    let readStateCleared = false
    const failed = await applyToolResultBudget(
      messages,
      state,
      async () => {
        throw new Error('persistence failed')
      },
      readSkip,
      () => {
        readStateCleared = true
      },
    )
    expect(resultContent(failed, 'r1')).toBe('x'.repeat(30_000))
    expect(state.replacements.has('r1')).toBe(false)
    expect(readStateCleared).toBe(false)
    markReadProviderRequestCompleted(state)
    const recovered = await applyToolResultBudget(
      messages,
      state,
      async records => {
        expect(records).toHaveLength(1)
        expect(state.replacements.has('r1')).toBe(false)
      },
      readSkip,
    )
    expect(resultContent(recovered, 'r1')).toBe(LARGE_READ_RESULT_CLEARED_MESSAGE)
    expect(state.replacements.has('r1')).toBe(true)
  })

  test('resume requires an unpersisted Read to complete a provider request', async () => {
    const messages = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'x'.repeat(30_000) },
    ])
    const state = reconstructContentReplacementState(messages, [])

    const before = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(before.messages, 'r1')).toBe('x'.repeat(30_000))
    prepareReadProviderRequestForQuery(state, before.messages, new Set(['r1']))
    markReadProviderRequestCompleted(state)
    const excluded = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(excluded.messages, 'r1')).toBe('x'.repeat(30_000))

    prepareReadProviderRequestForQuery(state, excluded.messages)
    markReadProviderRequestCompleted(state)
    const consumed = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(consumed.messages, 'r1')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )
  })

  test('does not acknowledge a Read removed before the provider request', async () => {
    const messages = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'x'.repeat(30_000) },
    ])
    const state = createContentReplacementState()
    await applyToolResultBudget(messages, state, undefined, readSkip, undefined, true)
    const compacted = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: '[Old tool result content cleared]' },
    ])
    prepareReadProviderRequestForQuery(state, compacted)
    markReadProviderRequestCompleted(state)
    const retry = await enforceToolResultBudget(messages, state, readSkip)
    expect(resultContent(retry.messages, 'r1')).toBe('x'.repeat(30_000))
  })

  test('reuses the observed Read candidates when the final messages are unchanged', async () => {
    const messages = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'x'.repeat(30_000) },
    ])
    const state = createContentReplacementState()
    const prepared = await enforceToolResultBudget(
      messages,
      state,
      readSkip,
      undefined,
      true,
    )
    prepareReadProviderRequestForQuery(state, prepared.messages)
    markReadProviderRequestCompleted(state)
    const result = await enforceToolResultBudget(messages, state, readSkip)

    expect(resultContent(result.messages, 'r1')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )
  })

  test('does not acknowledge Read results removed by provider-side cache edits', async () => {
    const messages = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'x'.repeat(30_000) },
    ])
    const state = createContentReplacementState()
    await enforceToolResultBudget(
      messages,
      state,
      readSkip,
      undefined,
      true,
    )
    prepareReadProviderRequestForQuery(state, messages, new Set(['r1']))
    markReadProviderRequestCompleted(state)
    const result = await enforceToolResultBudget(messages, state, readSkip)

    expect(resultContent(result.messages, 'r1')).toBe('x'.repeat(30_000))
  })

  test('does not treat unchanged or failed Reads as valid newer file reads', async () => {
    const original = messagesFor([
      { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(30_000) },
    ])
    const unchanged = messagesFor([
      {
        id: 'r2',
        name: 'Read',
        path: './src/a.ts',
        content: FILE_UNCHANGED_STUB,
      },
    ])
    const failed = messagesFor([
      {
        id: 'r3',
        name: 'Read',
        path: 'src/a.ts',
        error: true,
        content: 'read failed',
      },
    ])
    const state = createContentReplacementState()
    const all = [...original, ...unchanged, ...failed]
    await enforceToolResultBudget(all, state, readSkip)
    markReadProviderRequestCompleted(state)
    const result = await enforceToolResultBudget(all, state, readSkip)

    expect(resultContent(result.messages, 'r1')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )
    expect(resultContent(result.messages, 'r2')).toBe(FILE_UNCHANGED_STUB)
    expect(resultContent(result.messages, 'r3')).toBe('read failed')
    const resumed = reconstructContentReplacementState(all, result.newlyReplaced)
    expect(getReadReplacementPaths(resumed)).toEqual(
      new Set([normalizePathForComparison(expandPath('src/a.ts'))]),
    )
  })

  test('unchanged and failed Reads preserve the active Read group', async () => {
    const messages = [
      ...messagesFor([
        { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(15_000) },
        {
          id: 'r2',
          name: 'Read',
          path: 'src/a.ts',
          error: true,
          content: 'read failed',
        },
        { id: 'r3', name: 'Read', path: 'src/b.ts', content: 'b'.repeat(11_000) },
      ]),
      ...messagesFor([
        {
          id: 'r4',
          name: 'Read',
          path: 'src/c.ts',
          content: FILE_UNCHANGED_STUB,
        },
      ]),
      ...messagesFor([
        { id: 'r5', name: 'Read', path: 'src/d.ts', content: 'd'.repeat(1_000) },
      ]),
    ]
    const state = createContentReplacementState()
    await enforceToolResultBudget(messages, state, readSkip)
    markReadProviderRequestCompleted(state)
    const result = await enforceToolResultBudget(messages, state, readSkip)

    expect(resultContent(result.messages, 'r1')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )
    expect(resultContent(result.messages, 'r3')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )
    expect(resultContent(result.messages, 'r2')).toBe('read failed')
    expect(resultContent(result.messages, 'r4')).toBe(FILE_UNCHANGED_STUB)
    expect(resultContent(result.messages, 'r5')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )

    const boundaryMessages = [
      ...messagesFor([
        { id: 'b1', name: 'Read', path: 'src/b1.ts', content: 'b'.repeat(24_000) },
      ]),
      ...messagesFor([
        {
          id: 'b2',
          name: 'Read',
          path: 'src/b1.ts',
          content: FILE_UNCHANGED_STUB,
        },
      ]),
      ...messagesFor([
        { id: 'b3', name: 'Read', path: 'src/b3.ts', content: 'c'.repeat(1_000) },
      ]),
    ]
    const boundaryState = createContentReplacementState()
    await enforceToolResultBudget(boundaryMessages, boundaryState, readSkip)
    markReadProviderRequestCompleted(boundaryState)
    const boundaryResult = await enforceToolResultBudget(
      boundaryMessages,
      boundaryState,
      readSkip,
    )
    expect(resultContent(boundaryResult.messages, 'b1')).toBe('b'.repeat(24_000))
    expect(resultContent(boundaryResult.messages, 'b3')).toBe('c'.repeat(1_000))
  })

  test('resume keeps persisted Reads in the continuous group without restoring them as active', async () => {
    const messages = [
      ...messagesFor([
        { id: 'r1', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(20_000) },
        { id: 'r2', name: 'Read', path: 'src/b.ts', content: 'b'.repeat(10_000) },
      ]),
    ]
    const resumed = reconstructContentReplacementState(messages, [
      {
        kind: 'tool-result',
        toolUseId: 'r1',
        replacement: LARGE_READ_RESULT_CLEARED_MESSAGE,
      },
    ])
    const before = await enforceToolResultBudget(messages, resumed, readSkip)
    expect(resultContent(before.messages, 'r2')).toBe('b'.repeat(10_000))
    markReadProviderRequestCompleted(resumed)
    const after = await enforceToolResultBudget(messages, resumed, readSkip)
    expect(resultContent(after.messages, 'r2')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )
    expect(getReadReplacementPaths(resumed)).toEqual(
      new Set([normalizePathForComparison(expandPath('src/a.ts'))]),
    )

    const oldRead = messagesFor([
      { id: 'old', name: 'Read', path: 'src/resume.ts', content: 'old' },
    ])
    const edit = messagesFor([
      { id: 'edit', name: 'Edit', path: 'src/resume.ts', content: 'updated' },
    ])
    const currentRead = messagesFor([
      { id: 'current', name: 'Read', path: './src/resume.ts', content: 'current' },
    ])
    const replacement = {
      kind: 'tool-result' as const,
      toolUseId: 'old',
      replacement: TOOL_RESULT_CLEARED_MESSAGE,
    }
    const resumePath = normalizePathForComparison(expandPath('src/resume.ts'))
    const oldCache = new Map([[resumePath, { content: 'old', timestamp: 1 }]])
    const oldState = reconstructContentReplacementState(
      [...oldRead, ...edit],
      [replacement],
    )
    clearReadFileStateForReplacements(oldCache, oldState)
    expect(oldCache.size).toBe(0)

    const currentCache = new Map([
      [resumePath, { content: 'current', timestamp: 2 }],
    ])
    const currentState = reconstructContentReplacementState(
      [...oldRead, ...edit, ...currentRead],
      [replacement],
    )
    clearReadFileStateForReplacements(currentCache, currentState)
    expect(currentCache.get(resumePath)?.content).toBe('current')
  })

  test('fork subagent resume excludes parent Reads while restoring child continuity', async () => {
    const parent = createContentReplacementState()
    const parentRead = messagesFor([
      { id: 'parent', name: 'Read', path: 'src/parent.ts', content: 'p'.repeat(20_000) },
    ])
    await enforceToolResultBudget(parentRead, parent, readSkip)

    const childRead = messagesFor([
      { id: 'child', name: 'Read', path: 'src/child.ts', content: 'c'.repeat(10_000) },
    ])
    const resumed = reconstructForSubagentResume(
      parent,
      [...parentRead, ...childRead],
      [],
    )
    expect(resumed).toBeDefined()
    const before = await enforceToolResultBudget(
      [...parentRead, ...childRead],
      resumed!,
      readSkip,
    )
    expect(resultContent(before.messages, 'child')).toBe('c'.repeat(10_000))
    markReadProviderRequestCompleted(resumed)
    const after = await enforceToolResultBudget(
      [...parentRead, ...childRead],
      resumed!,
      readSkip,
    )
    expect(resultContent(after.messages, 'child')).toBe('c'.repeat(10_000))

    const childOwnReads = [
      ...messagesFor([
        { id: 'child-a', name: 'Read', path: 'src/a.ts', content: 'a'.repeat(20_000) },
        { id: 'child-b', name: 'Read', path: 'src/b.ts', content: 'b'.repeat(10_000) },
      ]),
    ]
    const childState = reconstructForSubagentResume(
      parent,
      childOwnReads,
      [
        {
          kind: 'tool-result',
          toolUseId: 'child-a',
          replacement: LARGE_READ_RESULT_CLEARED_MESSAGE,
        },
      ],
    )
    expect(childState).toBeDefined()
    await enforceToolResultBudget(childOwnReads, childState!, readSkip)
    markReadProviderRequestCompleted(childState)
    const childAfter = await enforceToolResultBudget(
      childOwnReads,
      childState!,
      readSkip,
    )
    expect(resultContent(childAfter.messages, 'child-b')).toBe(
      LARGE_READ_RESULT_CLEARED_MESSAGE,
    )
  })
})
