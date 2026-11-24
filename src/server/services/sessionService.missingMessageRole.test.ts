import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reduceTranscript } from './localIndex/transcriptReducer.js'
import { SessionService } from './sessionService.js'
import { projectTrajectoryRows, type ProjectionEntry } from './trajectoryProjection.js'

const sessionId = '2a044b6e-30cf-48cd-869a-86550731887a'
const environmentKeys = ['CLAUDE_CONFIG_DIR', 'CC_HAHA_LOCAL_INDEX', 'HOME', 'USERPROFILE'] as const

let directory: string
let transcriptPath: string
let service: SessionService
let previous: Record<string, string | undefined>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-missing-role-1993-'))
  previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
  process.env.HOME = directory
  process.env.USERPROFILE = directory
  const projectDir = join(directory, 'projects', 'fixture-project')
  await mkdir(projectDir, { recursive: true })
  transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  service = new SessionService()
})

afterEach(async () => {
  for (const key of environmentKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(directory, { recursive: true, force: true })
})

/**
 * Sanitized transcript fixture from Issue #1993:
 * Third-party Anthropic-compatible streaming endpoint (vLLM with exclude_unset=True)
 * omits `message.role` while cc-haha still persists top-level `type: "assistant"`.
 */
function buildIssue1993Entries(): Record<string, unknown>[] {
  return [
    {
      parentUuid: null,
      type: 'user',
      uuid: '3599dee7-02a9-4074-b3f4-1d9d7cd09b53',
      timestamp: '2026-11-23T15:48:45.000Z',
      sessionId,
      message: {
        role: 'user',
        content: 'Explain why this reply disappears after completion.',
      },
    },
    {
      parentUuid: '3599dee7-02a9-4074-b3f4-1d9d7cd09b53',
      message: {
        id: 'chatcmpl-96b23cb0ee3c414e',
        content: [
          {
            type: 'thinking',
            thinking: 'Reasoning about missing message.role in streamed message_start.',
            signature: 'sig_redacted_fixture',
          },
        ],
        model: 'qwen3.5-27b-uncensored',
        stop_reason: null,
        stop_sequence: null,
      },
      type: 'assistant',
      uuid: '62f9d947-5f46-4f62-92a9-dd70bb96da5d',
      timestamp: '2026-11-23T15:48:50.177Z',
      sessionId,
    },
    {
      parentUuid: '62f9d947-5f46-4f62-92a9-dd70bb96da5d',
      message: {
        id: 'chatcmpl-96b23cb0ee3c414e',
        content: [
          {
            type: 'text',
            text: 'Visible assistant reply preserved in transcript.',
          },
        ],
        model: 'qwen3.5-27b-uncensored',
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      type: 'assistant',
      uuid: '39e42023-09cb-49f6-87bf-3982ee459098',
      timestamp: '2026-11-23T15:48:53.996Z',
      sessionId,
    },
  ]
}

async function seedTranscript(entries: Record<string, unknown>[]): Promise<string> {
  const jsonl = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
  await writeFile(transcriptPath, jsonl, 'utf8')
  return jsonl
}

function toProjectionEntries(entries: Record<string, unknown>[]): ProjectionEntry[] {
  let offset = 0
  return entries.map(entry => {
    const line = JSON.stringify(entry)
    const byteStart = offset
    const byteEnd = byteStart + Buffer.byteLength(line, 'utf8')
    offset = byteEnd + 1
    return { entry, byteStart, byteEnd }
  })
}

test('Issue #1993 read-path parity: assistant entries omitting message.role stay visible in chat history as well as trajectory', async () => {
  const entries = buildIssue1993Entries()
  await seedTranscript(entries)

  // Baseline: trajectory already projects assistant entries by top-level entry.type
  const trajectoryRows = projectTrajectoryRows(toProjectionEntries(entries), {
    turnBase: 0,
    skipSidechain: true,
  })
  const assistantRow = trajectoryRows.find(row => row.kind === 'assistant')
  expect(assistantRow).toBeDefined()
  expect(assistantRow?.hasThinking).toBe(true)
  expect(assistantRow?.preview).toContain('Visible assistant reply preserved in transcript.')

  // Chat history surfaces must not silently drop these assistant records
  const expectedIds = [
    '3599dee7-02a9-4074-b3f4-1d9d7cd09b53',
    '62f9d947-5f46-4f62-92a9-dd70bb96da5d',
    '39e42023-09cb-49f6-87bf-3982ee459098',
  ]

  const messages = await service.getSessionMessages(sessionId, { includeSubagents: false })
  expect(messages.map(m => m.id)).toEqual(expectedIds)
  expect(messages.slice(1).map(m => m.type)).toEqual(['assistant', 'assistant'])

  const history = await service.getSessionHistory(sessionId)
  expect(history.messages.map(m => m.id)).toEqual(expectedIds)

  const page = await service.getSessionHistoryPage(sessionId, { full: true })
  expect(page.messages.map(m => m.id)).toEqual(expectedIds)

  const detail = await service.getSession(sessionId, { includeSubagents: false })
  expect(detail?.messages.map(m => m.id)).toEqual(expectedIds)

  const recovery = await service.getSessionHistoryRecovery(sessionId)
  expect(recovery.messages.some(m => m.id === '3599dee7-02a9-4074-b3f4-1d9d7cd09b53')).toBe(true)
  // Recovery must retain assistant records when they carry usage or tool activity
  expect(recovery.status).toBe('ready')
})

test('Issue #1993 metadata & tool_use parity: assistant records without message.role count toward messageCount, modifiedAt, and tool_use projection', async () => {
  const entries: Record<string, unknown>[] = [
    ...buildIssue1993Entries(),
    {
      parentUuid: '39e42023-09cb-49f6-87bf-3982ee459098',
      type: 'assistant',
      uuid: '8b28fa40-9e3c-4f25-8ab1-b3d8671de551',
      timestamp: '2026-11-23T15:48:59.500Z',
      sessionId,
      message: {
        id: 'chatcmpl-96b23cb0ee3c414f',
        model: 'qwen3.5-27b-uncensored',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_missing_role_1',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 25 },
      },
    },
  ]
  const jsonl = await seedTranscript(entries)

  const messages = await service.getSessionMessages(sessionId, { includeSubagents: false })
  const toolMessage = messages.find(m => m.id === '8b28fa40-9e3c-4f25-8ab1-b3d8671de551')
  expect(toolMessage?.type).toBe('tool_use')

  const { sessions } = await service.listSessions()
  const listed = sessions.find(item => item.id === sessionId)
  expect(listed?.messageCount).toBe(4)
  expect(listed?.modifiedAt).toBe('2026-11-23T15:48:59.500Z')

  // Local index transcriptReducer must stay in parity with SessionService
  const lines = jsonl.trimEnd().split('\n')
  let offset = 0
  const chunks = lines.map(line => {
    const text = `${line}\n`
    const byteStart = offset
    const byteLength = Buffer.byteLength(text, 'utf8')
    offset += byteLength
    return { byteStart, byteLength, text, completeLine: true }
  })
  const reduced = reduceTranscript(chunks)
  expect(reduced.summary.messageCount).toBe(4)
  expect(reduced.summary.modifiedAt).toBe('2026-11-23T15:48:59.500Z')

  // Recovery must account for usage on assistant entries missing message.role
  const recovery = await service.getSessionHistoryRecovery(sessionId)
  expect(recovery.tokenUsage).toEqual({
    input_tokens: 100,
    output_tokens: 25,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  })
})

test('Issue #1993 fallback safety: user entries omitting message.role fall back cleanly while non-transcript entries remain ignored', async () => {
  await seedTranscript([
    {
      type: 'user',
      uuid: 'u-missing-role-1',
      parentUuid: null,
      timestamp: '2026-11-23T15:49:00.000Z',
      sessionId,
      message: {
        content: 'User prompt without nested message.role',
      },
    },
    {
      type: 'summary',
      uuid: 'non-transcript-1',
      timestamp: '2026-11-23T15:49:01.000Z',
      sessionId,
      message: {
        content: 'Not a user/assistant/system transcript message',
      },
    },
    {
      type: 'assistant',
      uuid: 'assistant-without-message-object',
      timestamp: '2026-11-23T15:49:02.000Z',
      sessionId,
    },
  ])

  const messages = await service.getSessionMessages(sessionId, { includeSubagents: false })
  expect(messages.map(m => ({ id: m.id, type: m.type }))).toEqual([
    { id: 'u-missing-role-1', type: 'user' },
  ])
})
