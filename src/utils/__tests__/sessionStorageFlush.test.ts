import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  enqueueSessionEntryAfterPendingForTesting,
  flushSessionStorage,
  getTranscriptPathForSession,
  loadTranscriptFile,
  readAgentMetadata,
  recordContentReplacementDurably,
  recordTranscript,
  resetProjectForTesting,
  writeAgentMetadata,
} from '../sessionStorage.js'
import { switchSession } from '../../bootstrap/state.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import type { CustomTitleMessage } from '../../types/logs.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTranscriptEntrypoint = process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT
const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalUserType = process.env.USER_TYPE

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `session-storage-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('sessionStorage flush', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    process.env.USER_TYPE = 'external'
    resetProjectForTesting()
  })

  afterEach(async () => {
    resetProjectForTesting()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalTranscriptEntrypoint === undefined) {
      delete process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT
    } else {
      process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT = originalTranscriptEntrypoint
    }
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
    }
    if (originalTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('round-trips a nested Agent lifecycle owner through its sidecar', async () => {
    switchSession('11111111-2222-4333-8444-555555555555' as SessionId)
    resetProjectForTesting()
    const agentId = asAgentId('cold-resume-agent')

    await writeAgentMetadata(agentId, {
      agentType: 'general-purpose',
      toolUseId: 'toolu_nested_agent',
      ownerAgentId: 'parent-agent',
    })

    expect(await readAgentMetadata(agentId)).toEqual({
      agentType: 'general-purpose',
      toolUseId: 'toolu_nested_agent',
      ownerAgentId: 'parent-agent',
    })
  })

  it('records the desktop transcript entrypoint without changing the runtime entrypoint', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222'
    switchSession(sessionId as SessionId)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
    process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT = 'claude-desktop'
    resetProjectForTesting()

    await recordTranscript([{
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      message: { role: 'user', content: 'desktop resume visibility' },
    } as never])
    await flushSessionStorage()

    const transcript = await fs.readFile(getTranscriptPathForSession(sessionId), 'utf-8')
    const userEntry = transcript
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.type === 'user')

    expect(userEntry?.entrypoint).toBe('claude-desktop')
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-cli')
  })

  it('persists explicit desktop file attachments so resumed sessions retain their content', async () => {
    const sessionId = '44444444-4444-4444-8444-444444444444'
    const attachmentUuid = '55555555-5555-4555-8555-555555555555'
    switchSession(sessionId as SessionId)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
    process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT = 'claude-desktop'
    resetProjectForTesting()

    await recordTranscript([
      {
        type: 'user',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        timestamp: '2026-07-21T00:00:00.000Z',
        message: { role: 'user', content: '@"/workspace/README.md" summarize it' },
      } as never,
      {
        type: 'attachment',
        uuid: attachmentUuid,
        timestamp: '2026-07-21T00:00:01.000Z',
        attachment: {
          type: 'file',
          filename: '/workspace/README.md',
          displayPath: 'README.md',
          content: {
            type: 'text',
            file: {
              filePath: '/workspace/README.md',
              content: 'desktop attachment resume canary',
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          },
        },
      },
    ] as never[])
    await flushSessionStorage()

    const transcriptPath = getTranscriptPathForSession(sessionId)
    const transcript = await fs.readFile(transcriptPath, 'utf-8')
    expect(transcript).toContain('desktop attachment resume canary')

    const restored = await loadTranscriptFile(transcriptPath)
    expect(restored.messages.get(attachmentUuid as never)).toMatchObject({
      type: 'attachment',
      attachment: {
        type: 'file',
        content: {
          type: 'text',
          file: { content: 'desktop attachment resume canary' },
        },
      },
    })
  })

  it('keeps desktop internal attachments and sdk-cli file attachments out of external transcripts', async () => {
    const desktopSessionId = '66666666-6666-4666-8666-666666666666'
    switchSession(desktopSessionId as SessionId)
    process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT = 'claude-desktop'
    resetProjectForTesting()

    await recordTranscript([
      {
        type: 'user',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        timestamp: '2026-07-21T00:00:00.000Z',
        message: { role: 'user', content: 'desktop internal attachment' },
      } as never,
      {
        type: 'attachment',
        uuid: '77777777-7777-4777-8777-777777777777',
        timestamp: '2026-07-21T00:00:01.000Z',
        attachment: {
          type: 'todo_reminder',
          content: [],
          itemCount: 0,
        },
      },
    ] as never[])
    await flushSessionStorage()
    const desktopTranscript = await fs.readFile(
      getTranscriptPathForSession(desktopSessionId),
      'utf-8',
    )
    expect(desktopTranscript).not.toContain('todo_reminder')

    const cliSessionId = '88888888-8888-4888-8888-888888888888'
    switchSession(cliSessionId as SessionId)
    process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT = 'sdk-cli'
    resetProjectForTesting()

    await recordTranscript([
      {
        type: 'user',
        uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        timestamp: '2026-07-21T00:00:00.000Z',
        message: { role: 'user', content: '@"/workspace/private.md" summarize it' },
      } as never,
      {
        type: 'attachment',
        uuid: '99999999-9999-4999-8999-999999999999',
        timestamp: '2026-07-21T00:00:01.000Z',
        attachment: {
          type: 'file',
          filename: '/workspace/private.md',
          displayPath: 'private.md',
          content: {
            type: 'text',
            file: {
              filePath: '/workspace/private.md',
              content: 'must remain filtered outside desktop',
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          },
        },
      },
    ] as never[])
    await flushSessionStorage()
    const cliTranscript = await fs.readFile(
      getTranscriptPathForSession(cliSessionId),
      'utf-8',
    )
    expect(cliTranscript).not.toContain('must remain filtered outside desktop')
  })

  it('drains writes that are queued by pending operations during flush', async () => {
    const transcriptPath = path.join(tmpDir, 'late-enqueue.jsonl')
    const entry: CustomTitleMessage = {
      type: 'custom-title',
      customTitle: 'late enqueue',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )

    await flushSessionStorage()
    await writePromise

    const content = await fs.readFile(transcriptPath, 'utf-8')
    expect(content).toContain('"customTitle":"late enqueue"')
  })

  it('waits for a content replacement to be appended', async () => {
    const sessionId = 'aaaaaaaa-1111-4111-8111-111111111111'
    switchSession(sessionId as SessionId)
    resetProjectForTesting()
    await recordTranscript([{
      type: 'user',
      uuid: 'bbbbbbbb-2222-4222-8222-222222222222',
      message: { role: 'user', content: 'materialize transcript' },
    } as never])
    await flushSessionStorage()

    await recordContentReplacementDurably([
      {
        kind: 'tool-result',
        toolUseId: 'read-1',
        replacement: '[Large tool result content cleared]',
      },
    ])

    const transcript = await fs.readFile(
      getTranscriptPathForSession(sessionId),
      'utf-8',
    )
    expect(transcript).toContain('"toolUseId":"read-1"')
  })

  it('rejects a durable replacement when the transcript identity changes', async () => {
    const sessionId = 'cccccccc-3333-4333-8333-333333333333'
    switchSession(sessionId as SessionId)
    resetProjectForTesting()
    await recordTranscript([{
      type: 'user',
      uuid: 'dddddddd-4444-4444-8444-444444444444',
      message: { role: 'user', content: 'materialize transcript' },
    } as never])
    await flushSessionStorage()

    const transcriptPath = getTranscriptPathForSession(sessionId)
    const replacementResult = recordContentReplacementDurably([
      {
        kind: 'tool-result',
        toolUseId: 'read-discarded',
        replacement: '[Large tool result content cleared]',
      },
    ]).then(
      () => undefined,
      error => error as Error,
    )
    await fs.rename(transcriptPath, `${transcriptPath}.replaced`)
    await fs.writeFile(transcriptPath, '')
    await flushSessionStorage()

    expect(await replacementResult).toBeInstanceOf(Error)
    expect(await fs.readFile(transcriptPath, 'utf-8')).not.toContain(
      'read-discarded',
    )
  })
})
