import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../types/message.js'
import {
  deserializeMessages,
  loadConversationForResume,
  ResumeMessageNotFoundError,
} from './conversationRecovery.js'
import { normalizeMessagesForAPI } from './messages.js'

describe('deserializeMessages malformed attachments', () => {
  test.each([
    ['missing payload', { type: 'attachment' }],
    ['null payload', { type: 'attachment', attachment: null }],
    [
      'invalid hook context',
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: null,
        },
      },
    ],
    [
      'new-file attachment with a non-string filename',
      {
        type: 'attachment',
        attachment: { type: 'new_file', filename: null },
      },
    ],
    [
      'new-directory attachment with a non-string path',
      {
        type: 'attachment',
        attachment: { type: 'new_directory', path: null },
      },
    ],
    [
      'current file attachment with a non-string filename',
      {
        type: 'attachment',
        attachment: { type: 'file', filename: 42 },
      },
    ],
    [
      'current directory attachment with a non-string path',
      {
        type: 'attachment',
        attachment: { type: 'directory', path: 42 },
      },
    ],
    [
      'IDE selection with non-string content',
      {
        type: 'attachment',
        attachment: {
          type: 'selected_lines_in_ide',
          content: null,
        },
      },
    ],
    [
      'invoked-skills attachment with a non-array payload',
      {
        type: 'attachment',
        attachment: { type: 'invoked_skills', skills: null },
      },
    ],
    [
      'hook-success attachment with a non-string payload',
      {
        type: 'attachment',
        attachment: { type: 'hook_success', content: null },
      },
    ],
    [
      'skill-listing attachment with a non-string payload',
      {
        type: 'attachment',
        attachment: { type: 'skill_listing', content: null },
      },
    ],
    [
      'deferred-tools delta without rendered lines',
      {
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['Read'],
          removedNames: [],
        },
      },
    ],
    [
      'MCP instructions delta without rendered blocks',
      {
        type: 'attachment',
        attachment: {
          type: 'mcp_instructions_delta',
          addedNames: ['server'],
          removedNames: [],
        },
      },
    ],
    [
      'agent-listing delta without rendered lines',
      {
        type: 'attachment',
        attachment: {
          type: 'agent_listing_delta',
          addedTypes: ['Explore'],
          removedTypes: [],
        },
      },
    ],
  ])('drops a %s instead of crashing resume', (_name, malformed) => {
    const messages = deserializeMessages([
      malformed as unknown as Message,
    ])

    expect(messages).toEqual([])
  })

  test('keeps non-attachment messages and unknown forward-compatible attachments', () => {
    const messages = deserializeMessages([
      {
        type: 'system',
        subtype: 'local_command',
        content: 'status',
        level: 'info',
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      } as Message,
      {
        type: 'attachment',
        attachment: { type: 'future_attachment' },
      } as unknown as Message,
    ])

    expect(
      messages.some(
        message =>
          message.type === 'system' && message.content === 'status',
      ),
    ).toBe(true)
    expect(
      messages.some(
        message =>
          message.type === 'attachment' &&
          (message.attachment as { type: string }).type ===
            'future_attachment',
      ),
    ).toBe(true)
  })

  test('drops a malformed known attachment at API normalization', () => {
    const malformed = {
      type: 'attachment',
      attachment: {
        type: 'todo_reminder',
        content: null,
        itemCount: 0,
      },
    } as unknown as Message

    expect(normalizeMessagesForAPI([malformed])).toEqual([])
  })

  test('drops a missing attachment envelope at API normalization', () => {
    expect(
      normalizeMessagesForAPI([
        { type: 'attachment' } as unknown as Message,
      ]),
    ).toEqual([])
  })
})

describe('loadConversationForResume resumeSessionAt', () => {
  const ids = {
    prompt: crypto.randomUUID(),
    plan: crypto.randomUUID(),
    toolUse: crypto.randomUUID(),
    toolResult: crypto.randomUUID(),
    after: crypto.randomUUID(),
  }
  const saved = {
    config: process.env.CLAUDE_CONFIG_DIR,
    simple: process.env.CLAUDE_CODE_SIMPLE,
  }
  const sessionId = crypto.randomUUID()
  let dir = ''
  let transcript = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resume-at-'))
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'config')
    // --bare equivalent: resume hooks are not under test here.
    process.env.CLAUDE_CODE_SIMPLE = '1'
    const base = {
      sessionId,
      cwd: dir,
      version: '9.9.9',
      timestamp: new Date().toISOString(),
      isSidechain: false,
      userType: 'external',
    }
    const assistant = (id: string, content: unknown[]) => ({
      id,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const rows = [
      { ...base, uuid: ids.prompt, parentUuid: null, type: 'user', message: { role: 'user', content: 'start' } },
      { ...base, uuid: ids.plan, parentUuid: ids.prompt, type: 'assistant', message: assistant('msg_plan', [{ type: 'text', text: 'PLAN' }]) },
      { ...base, uuid: ids.toolUse, parentUuid: ids.plan, type: 'assistant', message: assistant('msg_tool', [{ type: 'tool_use', id: 'toolu_job', name: 'Bash', input: { command: 'sleep 600' } }]) },
      { ...base, uuid: ids.toolResult, parentUuid: ids.toolUse, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_job', content: 'done' }] } },
      { ...base, uuid: ids.after, parentUuid: ids.toolResult, type: 'assistant', message: assistant('msg_after', [{ type: 'text', text: 'AFTER' }]) },
    ]
    transcript = join(dir, `${sessionId}.jsonl`)
    await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  })

  afterAll(async () => {
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', saved.config],
      ['CLAUDE_CODE_SIMPLE', saved.simple],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  const load = (resumeSessionAt?: string) =>
    loadConversationForResume(sessionId, transcript, { resumeSessionAt })

  test('without a boundary the whole chain is resumed', async () => {
    const result = await load()
    expect(result?.messages.map(message => message.uuid)).toContain(ids.after)
  })

  test('a tool call with no result is a valid boundary and is dropped from the kept context', async () => {
    // The cut is applied to the persisted chain before the unresolved-tool
    // filter; only then are unresolved calls removed from what was kept.
    const result = await load(ids.toolUse)
    expect(result!.messages.map(message => message.uuid)).toEqual([ids.prompt, ids.plan])
    expect(result!.turnInterruptionState).toEqual({ kind: 'none' })
  })

  test('nothing after the boundary is kept or synthesized', async () => {
    const atResult = await load(ids.toolResult)
    expect(atResult!.messages.map(message => message.uuid)).toEqual([
      ids.prompt,
      ids.plan,
      ids.toolUse,
      ids.toolResult,
    ])
    expect(atResult!.turnInterruptionState).toEqual({ kind: 'none' })

    const atPrompt = await load(ids.prompt)
    expect(atPrompt!.messages.map(message => message.uuid)).toEqual([ids.prompt])
  })

  test('an unknown boundary is reported as ResumeMessageNotFoundError', async () => {
    const missing = crypto.randomUUID()
    const error = await load(missing).catch(caught => caught)
    expect(error).toBeInstanceOf(ResumeMessageNotFoundError)
    expect(error.message).toBe(`No message found with message.uuid of: ${missing}`)
  })
})
