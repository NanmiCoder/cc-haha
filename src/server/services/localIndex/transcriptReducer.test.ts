import { describe, expect, it } from 'bun:test'
import type { SessionListSummary, TranscriptChunk, TranscriptProjection } from './types.js'
import {
  LOCAL_INDEX_REBUILD_REQUIRED,
  TranscriptRebuildRequiredError,
  reduceTranscript,
} from './transcriptReducer.js'

const birthtime = '2025-12-31T23:59:00.000Z'
const mtime = '2026-01-02T00:00:00.000Z'

function initialProjection(overrides: Partial<SessionListSummary> = {}): TranscriptProjection {
  return {
    summary: {
      title: 'Untitled Session',
      createdAt: birthtime,
      modifiedAt: mtime,
      messageCount: 0,
      workDir: '/fallback/project',
      ...overrides,
    },
    indexedBytes: 0,
    pendingTailBytes: 0,
    malformedLineCount: 0,
  }
}

function completeChunks(
  entries: Array<Record<string, unknown> | string>,
  byteStart = 0,
): TranscriptChunk[] {
  let nextByte = byteStart
  return entries.map((entry) => {
    const text = `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`
    const chunk = { text, byteStart: nextByte, completeLine: true }
    nextByte += Buffer.byteLength(text)
    return chunk
  })
}

function user(content: unknown, timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    message: { role: 'user', content },
    timestamp,
    ...extra,
  }
}

function assistant(timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    timestamp,
    ...extra,
  }
}

describe('reduceTranscript', () => {
  it('projects the existing summary fields and title precedence from complete lines', () => {
    const repository = {
      requestedWorkDir: '/repo',
      repoRoot: '/repo',
      branch: 'main',
      worktree: true,
      baseRef: 'main',
      worktreePath: '/repo/.claude/worktrees/task',
      worktreeBranch: 'worktree-task',
      worktreeSlug: 'task',
    }
    const worktreeSession = {
      originalCwd: '/repo',
      worktreePath: '/repo/.claude/worktrees/task',
      worktreeName: 'task',
      sessionId: 'same-id',
    }
    const chunks = completeChunks([
      {
        type: 'session-meta',
        isMeta: true,
        workDir: 'D:\\workspace\\repo',
        permissionMode: 'acceptEdits',
        runtimeProviderId: 'provider-a',
        runtimeModelId: 'model-a',
        effortLevel: 'high',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      user('First user title', '2026-01-01T00:01:00.000Z', {
        cwd: 'D:\\workspace\\fallback',
        repository,
      }),
      assistant('2026-01-01T00:02:00.000Z'),
      {
        type: 'ai-title',
        aiTitle: 'AI title',
        timestamp: '2026-01-01T00:03:00.000Z',
      },
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name><command-args>Ship projection</command-args>',
        timestamp: '2026-01-01T00:04:00.000Z',
      },
      {
        type: 'worktree-state',
        worktreeSession,
        timestamp: '2026-01-01T00:05:00.000Z',
      },
      {
        type: 'custom-title',
        customTitle: 'Pinned title',
        timestamp: '2026-01-01T00:06:00.000Z',
      },
    ])

    const result = reduceTranscript(chunks, initialProjection())

    expect(result.summary).toEqual({
      sessionApiFormat: 'unknown',
      title: 'Pinned title',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:02:00.000Z',
      messageCount: 2,
      workDir: 'D:\\workspace\\repo',
      permissionMode: 'acceptEdits',
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-a',
      effortLevel: 'high',
      repository,
      worktreeSession,
    })
    expect(result.indexedBytes).toBe(chunks.reduce(
      (bytes, chunk) => Math.max(bytes, chunk.byteStart + Buffer.byteLength(chunk.text)),
      0,
    ))
    expect(result.pendingTailBytes).toBe(0)
    expect(result.malformedLineCount).toBe(0)
  })

  it.each([
    ['first user', [user('First user', '2026-01-01T00:01:00.000Z')], 'First user'],
    ['AI over first user', [
      user('First user', '2026-01-01T00:01:00.000Z'),
      { type: 'ai-title', aiTitle: 'AI title' },
    ], 'AI title'],
    ['goal over AI', [
      user('First user', '2026-01-01T00:01:00.000Z'),
      { type: 'ai-title', aiTitle: 'AI title' },
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name><command-args>Goal title</command-args>',
      },
    ], '/goal Goal title'],
    ['custom over goal', [
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name><command-args>Goal title</command-args>',
      },
      { type: 'custom-title', customTitle: 'Custom title' },
    ], 'Custom title'],
  ])('keeps %s title precedence', (_label, entries, expectedTitle) => {
    const result = reduceTranscript(
      completeChunks(entries as Array<Record<string, unknown>>),
      initialProjection(),
    )

    expect(result.summary.title).toBe(expectedTitle)
  })

  it('counts malformed complete lines but leaves an incomplete tail pending', () => {
    const complete = completeChunks([
      user('你好', '2026-01-01T00:01:00.000Z'),
      '{malformed json}',
    ])
    const tailText = '{"type":"assistant"'
    const tailByteStart = complete.at(-1)!.byteStart + Buffer.byteLength(complete.at(-1)!.text)

    const result = reduceTranscript([
      ...complete,
      { text: tailText, byteStart: tailByteStart, completeLine: false },
    ], initialProjection())

    expect(result.summary.messageCount).toBe(1)
    expect(result.indexedBytes).toBe(tailByteStart)
    expect(result.pendingTailBytes).toBe(Buffer.byteLength(tailText))
    expect(result.malformedLineCount).toBe(1)
  })

  it('does not reclassify a parsed null entry as a JSON parse failure', () => {
    expect(() => reduceTranscript(
      completeChunks(['null']),
      initialProjection(),
    )).toThrow()
  })

  it('keeps semantic activity time while applying metadata-only appends', () => {
    const firstChunks = completeChunks([
      user('Original title', '2026-01-01T00:01:00.000Z'),
      assistant('2026-01-01T00:02:00.000Z'),
    ])
    const first = reduceTranscript(firstChunks, initialProjection())
    const appendStart = first.indexedBytes
    const metadataChunks = completeChunks([
      {
        type: 'session-meta',
        isMeta: true,
        workDir: '/new/worktree',
        runtimeProviderId: null,
        runtimeModelId: 'model-b',
        effortLevel: 'max',
        timestamp: '2026-01-03T00:00:00.000Z',
      },
      {
        type: 'custom-title',
        customTitle: 'Renamed without activity',
        timestamp: '2026-01-03T00:01:00.000Z',
      },
    ], appendStart)

    const result = reduceTranscript(metadataChunks, first)

    expect(result.summary).toMatchObject({
      title: 'Renamed without activity',
      createdAt: '2026-01-01T00:01:00.000Z',
      modifiedAt: '2026-01-01T00:02:00.000Z',
      messageCount: 2,
      workDir: '/new/worktree',
      runtimeProviderId: null,
      runtimeModelId: 'model-b',
      effortLevel: 'max',
    })
    expect(result.indexedBytes).toBe(
      metadataChunks.at(-1)!.byteStart + Buffer.byteLength(metadataChunks.at(-1)!.text),
    )
  })

  it('preserves title-source precedence across stateful incremental reductions', () => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const aiChunks = completeChunks([
      { type: 'ai-title', aiTitle: 'AI title' },
    ], first.indexedBytes)
    const withAi = reduceTranscript(aiChunks, first)
    const goalChunks = completeChunks([{
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name><command-args>Goal title</command-args>',
    }], withAi.indexedBytes)
    const withGoal = reduceTranscript(goalChunks, withAi)
    const laterAiChunks = completeChunks([
      { type: 'ai-title', aiTitle: 'Later AI title' },
    ], withGoal.indexedBytes)
    const afterLaterAi = reduceTranscript(laterAiChunks, withGoal)
    const customChunks = completeChunks([
      { type: 'custom-title', customTitle: 'Custom title' },
    ], afterLaterAi.indexedBytes)

    expect(withAi.summary.title).toBe('AI title')
    expect(withGoal.summary.title).toBe('/goal Goal title')
    expect(afterLaterAi.summary.title).toBe('/goal Goal title')
    expect(reduceTranscript(customChunks, afterLaterAi).summary.title).toBe('Custom title')
  })

  it('requires a source rebuild for a state-less incremental seed', () => {
    const persistedLookingSeed: TranscriptProjection = {
      summary: {
        title: 'Existing title with unknown source',
        createdAt: '2026-01-01T00:01:00.000Z',
        modifiedAt: '2026-01-01T00:02:00.000Z',
        messageCount: 2,
        workDir: '/existing',
      },
      indexedBytes: 128,
      pendingTailBytes: 0,
      malformedLineCount: 0,
    }
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'Cannot safely rank this' },
    ], persistedLookingSeed.indexedBytes)

    expect(() => reduceTranscript(append, persistedLookingSeed)).toThrow(
      TranscriptRebuildRequiredError,
    )
    try {
      reduceTranscript(append, persistedLookingSeed)
      throw new Error('expected rebuild signal')
    } catch (error) {
      expect((error as TranscriptRebuildRequiredError).code).toBe(LOCAL_INDEX_REBUILD_REQUIRED)
    }
  })

  it('uses the stable rebuild signal for a negative state-less byte offset', () => {
    expect(() => reduceTranscript([{
      text: '{}\n',
      byteStart: -1,
      completeLine: true,
    }])).toThrow(TranscriptRebuildRequiredError)
  })

  it('keeps private reducer state when a no-op reduction clones a stateful seed', () => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const clone = reduceTranscript([], first)
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'AI title after no-op' },
    ], clone.indexedBytes)

    expect(reduceTranscript(append, clone).summary.title).toBe('AI title after no-op')
  })

  it.each([
    ['overlaps', -1],
    ['leaves a gap', 1],
  ])('requires a rebuild when the first incremental chunk %s the indexed boundary', (
    _label,
    delta,
  ) => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'Unsafe append' },
    ], first.indexedBytes + delta)

    expect(() => reduceTranscript(append, first)).toThrow(TranscriptRebuildRequiredError)
  })

  it.each([
    ['gap', 1],
    ['overlap', -1],
    ['out-of-order restart', 0],
  ])('requires a rebuild for a later chunk with a %s', (_label, secondStartDelta) => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'First contiguous append' },
    ], first.indexedBytes)
    const expectedSecondStart = append[0]!.byteStart + Buffer.byteLength(append[0]!.text)
    append.push(...completeChunks([
      { type: 'custom-title', customTitle: 'Unsafe second append' },
    ], secondStartDelta === 0 ? first.indexedBytes : expectedSecondStart + secondStartDelta))

    expect(() => reduceTranscript(append, first)).toThrow(TranscriptRebuildRequiredError)
  })

  it('requires a rebuild when any chunk follows an incomplete tail', () => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const tailText = '{"type":"assistant"'
    const laterText = `${JSON.stringify({ type: 'custom-title', customTitle: 'Too late' })}\n`

    expect(() => reduceTranscript([
      { text: tailText, byteStart: first.indexedBytes, completeLine: false },
      {
        text: laterText,
        byteStart: first.indexedBytes + Buffer.byteLength(tailText),
        completeLine: true,
      },
    ], first)).toThrow(TranscriptRebuildRequiredError)
  })

  it('uses the explicit seed fallbacks when no semantic entries exist', () => {
    const chunks = completeChunks([{
      type: 'session-meta',
      isMeta: true,
      permissionMode: 'not-valid',
      effortLevel: 'not-valid',
    }])

    const result = reduceTranscript(chunks, initialProjection())

    expect(result.summary).toEqual({
      title: 'Untitled Session',
      createdAt: birthtime,
      modifiedAt: mtime,
      messageCount: 0,
      workDir: '/fallback/project',
    })
  })
})

// One assistant reply, written the way Claude Code actually writes it: one JSONL line per content
// block, every line repeating the same complete `usage`. Real transcripts hit 52 lines for a
// single reply, and counting each one is what inflated the token totals 2.2x.
function assistantBlockLines(options: {
  messageId: string
  requestId: string
  timestamp: string
  blocks: Array<Record<string, unknown>>
  usage: Record<string, unknown>
  model?: string
  extra?: Record<string, unknown>
}) {
  return options.blocks.map(block => ({
    type: 'assistant',
    requestId: options.requestId,
    version: '1.0.24',
    message: {
      id: options.messageId,
      role: 'assistant',
      model: options.model ?? 'claude-opus-5',
      content: [block],
      usage: options.usage,
    },
    timestamp: options.timestamp,
    ...options.extra,
  }))
}

const STANDARD_USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 300,
}

function modelTotals(projection: ReturnType<typeof reduceTranscript>) {
  return (projection.activity?.models ?? []).map(model => ({
    model: model.model,
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
    cacheReadInputTokens: model.cacheReadInputTokens,
    cacheCreationInputTokens: model.cacheCreationInputTokens,
  }))
}

describe('reduceTranscript activity usage', () => {
  it('counts one reply once no matter how many content-block lines it was written as', () => {
    const chunks = completeChunks(assistantBlockLines({
      messageId: 'msg_one',
      requestId: 'req_one',
      timestamp: '2026-01-01T10:00:00.000Z',
      usage: STANDARD_USAGE,
      blocks: [
        { type: 'thinking', thinking: 'planning' },
        { type: 'text', text: 'here goes' },
        ...Array.from({ length: 10 }, (_, index) => ({
          type: 'tool_use',
          id: `toolu_${index}`,
          name: 'Bash',
          input: {},
        })),
      ],
    }))

    const result = reduceTranscript(chunks, initialProjection())

    expect(modelTotals(result)).toEqual([{
      model: 'claude-opus-5',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 300,
    }])
    // The tool calls themselves are real and must still all be counted — only usage deduplicates.
    expect(result.activity?.daily[0]?.toolCallCount).toBe(10)
    expect(result.activity?.daily[0]?.messageCount).toBe(12)
  })

  it('counts a genuinely new reply separately', () => {
    const chunks = completeChunks([
      ...assistantBlockLines({
        messageId: 'msg_one',
        requestId: 'req_one',
        timestamp: '2026-01-01T10:00:00.000Z',
        usage: STANDARD_USAGE,
        blocks: [{ type: 'text', text: 'first' }, { type: 'text', text: 'also first' }],
      }),
      ...assistantBlockLines({
        messageId: 'msg_two',
        requestId: 'req_two',
        timestamp: '2026-01-01T10:05:00.000Z',
        usage: STANDARD_USAGE,
        blocks: [{ type: 'text', text: 'second' }],
      }),
    ])

    const result = reduceTranscript(chunks, initialProjection())

    expect(modelTotals(result)[0]).toMatchObject({ inputTokens: 2000, outputTokens: 400 })
  })

  it('does not attribute inherited fork history to the fork usage total', () => {
    const chunks = completeChunks([
      ...assistantBlockLines({
        messageId: 'msg_inherited',
        requestId: 'req_inherited',
        timestamp: '2026-01-01T10:00:00.000Z',
        usage: STANDARD_USAGE,
        blocks: [{ type: 'text', text: 'copied from the source session' }],
        extra: {
          sessionId: 'fork-session',
          forkedFrom: {
            sessionId: 'source-session',
            messageUuid: 'source-assistant',
          },
        },
      }),
      ...assistantBlockLines({
        messageId: 'msg_new',
        requestId: 'req_new',
        timestamp: '2026-01-01T10:05:00.000Z',
        usage: { input_tokens: 7, output_tokens: 3 },
        blocks: [{ type: 'text', text: 'generated in the fork' }],
        extra: { sessionId: 'fork-session' },
      }),
    ])

    const result = reduceTranscript(chunks, initialProjection())

    expect(modelTotals(result)).toEqual([{
      model: 'claude-opus-5',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }])
  })

  it('keeps deduplicating across an incremental read', () => {
    const [firstLine, ...restLines] = assistantBlockLines({
      messageId: 'msg_split',
      requestId: 'req_split',
      timestamp: '2026-01-01T10:00:00.000Z',
      usage: STANDARD_USAGE,
      blocks: [
        { type: 'text', text: 'part one' },
        { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
        { type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} },
      ],
    })
    const head = completeChunks([firstLine!])
    const first = reduceTranscript(head, initialProjection())
    const tail = completeChunks(restLines, first.indexedBytes)

    const second = reduceTranscript(tail, first)

    // The trailing block lines arrive in a later read; their repeated usage must stay uncounted.
    expect(modelTotals(second)[0]).toMatchObject({ inputTokens: 1000, outputTokens: 200 })
  })

  it('counts every line when the log carries no message id to deduplicate on', () => {
    const chunks = completeChunks([0, 1].map(() => ({
      type: 'assistant',
      requestId: 'req_anon',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'x' }],
        usage: STANDARD_USAGE,
      },
      timestamp: '2026-01-01T10:00:00.000Z',
    })))

    const result = reduceTranscript(chunks, initialProjection())

    expect(modelTotals(result)[0]).toMatchObject({ inputTokens: 2000 })
  })

  it('skips usage from foreign log formats but keeps their activity', () => {
    const chunks = completeChunks([
      ...assistantBlockLines({
        messageId: 'msg_foreign',
        requestId: 'req_foreign',
        timestamp: '2026-01-01T10:00:00.000Z',
        usage: STANDARD_USAGE,
        blocks: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }],
        extra: { version: 'unknown' },
      }),
      ...assistantBlockLines({
        messageId: '',
        requestId: 'req_empty_id',
        timestamp: '2026-01-01T10:01:00.000Z',
        usage: STANDARD_USAGE,
        blocks: [{ type: 'text', text: 'malformed' }],
      }),
    ])

    const result = reduceTranscript(chunks, initialProjection())

    expect(result.activity?.models).toEqual([])
    // Rejecting a line for billing must not erase it from the activity heatmap.
    expect(result.activity?.daily[0]?.toolCallCount).toBe(1)
    expect(result.activity?.messageCount).toBe(2)
  })

  it('estimates cost for Claude models and leaves third-party models unpriced', () => {
    const chunks = completeChunks([
      ...assistantBlockLines({
        messageId: 'msg_claude',
        requestId: 'req_claude',
        timestamp: '2026-01-01T10:00:00.000Z',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          server_tool_use: { web_search_requests: 3 },
        },
        blocks: [{ type: 'text', text: 'priced' }],
      }),
      ...assistantBlockLines({
        messageId: 'msg_glm',
        requestId: 'req_glm',
        timestamp: '2026-01-01T10:01:00.000Z',
        model: 'glm-5.2',
        usage: { input_tokens: 9_000_000, output_tokens: 9_000_000 },
        blocks: [{ type: 'text', text: 'unpriced' }],
      }),
    ])

    const result = reduceTranscript(chunks, initialProjection())
    const byModel = Object.fromEntries(
      (result.activity?.models ?? []).map(model => [model.model, model]),
    )

    expect(byModel['claude-opus-5']?.costUSD).toBeCloseTo(5.03, 6)
    expect(byModel['claude-opus-5']?.webSearchRequests).toBe(3)
    // Tokens still count toward activity; dollars stay at zero rather than being invented.
    expect(byModel['glm-5.2']?.inputTokens).toBe(9_000_000)
    expect(byModel['glm-5.2']?.costUSD).toBe(0)
  })

  it('reads the split cache_creation buckets when the legacy total is absent', () => {
    const chunks = completeChunks(assistantBlockLines({
      messageId: 'msg_split_cache',
      requestId: 'req_split_cache',
      timestamp: '2026-01-01T10:00:00.000Z',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 700,
          ephemeral_1h_input_tokens: 300,
        },
      },
      blocks: [{ type: 'text', text: 'cached' }],
    }))

    const result = reduceTranscript(chunks, initialProjection())

    expect(modelTotals(result)[0]?.cacheCreationInputTokens).toBe(1000)
  })

  it('bills advisor iterations under their own model without recounting the parent', () => {
    const chunks = completeChunks(assistantBlockLines({
      messageId: 'msg_advisor',
      requestId: 'req_advisor',
      timestamp: '2026-01-01T10:00:00.000Z',
      usage: {
        ...STANDARD_USAGE,
        iterations: [
          { type: 'message', input_tokens: 999_999, output_tokens: 999_999 },
          {
            type: 'advisor_message',
            model: 'claude-opus-4-8',
            input_tokens: 400,
            output_tokens: 20,
          },
        ],
      },
      blocks: [
        { type: 'text', text: 'one' },
        { type: 'tool_use', id: 'toolu_adv', name: 'Bash', input: {} },
      ],
    }))

    const result = reduceTranscript(chunks, initialProjection())
    const byModel = Object.fromEntries(
      (result.activity?.models ?? []).map(model => [model.model, model]),
    )

    // A plain `message` iteration is already inside the parent's totals — counting it would
    // double-bill the turn.
    expect(byModel['claude-opus-5']).toMatchObject({ inputTokens: 1000, outputTokens: 200 })
    expect(byModel['claude-opus-4-8']).toMatchObject({ inputTokens: 400, outputTokens: 20 })
  })

  it('sums working time across gaps and drops the overnight break', () => {
    const chunks = completeChunks([
      user('start', '2026-01-01T09:00:00.000Z'),
      user('still going', '2026-01-01T09:20:00.000Z'),
      user('after a long break', '2026-01-02T09:00:00.000Z'),
      user('wrapping up', '2026-01-02T09:10:00.000Z'),
    ])

    const result = reduceTranscript(chunks, initialProjection())

    // 20 min + 10 min of work; the 23h40m the user was asleep is not task time.
    expect(result.activity?.activeDurationMs).toBe(30 * 60 * 1000)
  })

  it('carries working time across an incremental read', () => {
    const head = completeChunks([
      user('start', '2026-01-01T09:00:00.000Z'),
      user('next', '2026-01-01T09:05:00.000Z'),
    ])
    const first = reduceTranscript(head, initialProjection())
    const tail = completeChunks([user('later', '2026-01-01T09:11:00.000Z')], first.indexedBytes)

    const second = reduceTranscript(tail, first)

    expect(first.activity?.activeDurationMs).toBe(5 * 60 * 1000)
    expect(second.activity?.activeDurationMs).toBe(11 * 60 * 1000)
  })
})
