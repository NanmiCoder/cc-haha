import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getSubagentRunByAgentId,
  getSubagentRunByTool,
  dropSupersededTeammateFragments,
  mergeTeammateTranscriptFragments,
  parseCanonicalNestedAgentToolRef,
  resolveSubagentRunFromMessages,
  truncateSubagentMessages,
} from './subagentRunService.js'
import { sessionService, type MessageEntry } from './sessionService.js'

let tmpDir: string | null = null

async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), `subagent-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  return tmpDir
}

async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  if (!tmpDir) throw new Error('tmpDir not initialized')
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  )
}

async function writeSubagentTranscriptFile(
  projectDir: string,
  sessionId: string,
  agentId: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  if (!tmpDir) throw new Error('tmpDir not initialized')
  const dir = path.join(tmpDir, 'projects', projectDir, sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  await fs.writeFile(
    path.join(dir, `${normalizedAgentId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  )
}

async function writeSubagentMetadata(
  projectDir: string,
  sessionId: string,
  agentId: string,
  agentType: string,
  modifiedAt: number,
): Promise<void> {
  if (!tmpDir) throw new Error('tmpDir not initialized')
  const dir = path.join(tmpDir, 'projects', projectDir, sessionId, 'subagents')
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  const transcriptPath = path.join(dir, `${normalizedAgentId}.jsonl`)
  await fs.writeFile(
    path.join(dir, `${normalizedAgentId}.meta.json`),
    JSON.stringify({ agentType }),
    'utf-8',
  )
  const modifiedDate = new Date(modifiedAt)
  await fs.utimes(transcriptPath, modifiedDate, modifiedDate)
}

/**
 * The sidecar the CLI writes before an agent's query loop starts. Unlike
 * {@link writeSubagentMetadata} it carries the spawning tool_use id, which is
 * what lets a live run be resolved before any result exists.
 */
async function writeSubagentLaunchMetadata(
  projectDir: string,
  sessionId: string,
  agentId: string,
  metadata: {
    agentType: string
    toolUseId?: string
    ownerAgentId?: string
    description?: string
  },
): Promise<void> {
  if (!tmpDir) throw new Error('tmpDir not initialized')
  const dir = path.join(tmpDir, 'projects', projectDir, sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  await fs.writeFile(
    path.join(dir, `${normalizedAgentId}.meta.json`),
    JSON.stringify(metadata),
    'utf-8',
  )
}

function makeAgentToolUseEntry(toolUseId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: { description: 'Explore repo', prompt: 'Read files' },
      }],
    },
    uuid: 'assistant-agent-use',
    timestamp: '2026-01-01T00:00:01.000Z',
  }
}

function makeAgentToolResultEntry(toolUseId: string, agentId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{
          type: 'text',
          text: `Finished exploring the repo\nagentId: ${agentId}\n<usage>input_tokens: 7\noutput_tokens: 11\ntotal_tokens: 18</usage>`,
        }],
      }],
    },
    uuid: 'user-agent-result',
    timestamp: '2026-01-01T00:00:03.000Z',
  }
}

function makeOneShotAgentToolResultEntry(toolUseId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: 'Finished exploring the repo' }],
      }],
    },
    uuid: 'user-one-shot-agent-result',
    timestamp: '2026-01-01T00:00:05.000Z',
  }
}

function makeTaskNotificationEntry(
  toolUseId: string,
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  options: {
    ownerAgentId?: string
    summary?: string
    timestamp?: string
  } = {},
): Record<string, unknown> {
  return {
    type: 'cc-haha-task-notification',
    isMeta: true,
    taskNotification: {
      taskId,
      toolUseId,
      ...(options.ownerAgentId ? { ownerAgentId: options.ownerAgentId } : {}),
      status,
      summary: options.summary ?? 'Agent completed',
    },
    timestamp: options.timestamp ?? '2026-01-01T00:00:06.000Z',
  }
}

describe('subagentRunService helpers', () => {
  it('parses the final parent agent and leaf tool from a recursive canonical ref', () => {
    expect(parseCanonicalNestedAgentToolRef('A/a/B/b/Agent:0')).toEqual({
      parentAgentId: 'b',
      leafToolUseId: 'Agent:0',
    })
    expect(parseCanonicalNestedAgentToolRef('A/invalid.parent/call.0')).toEqual({
      parentAgentId: 'invalid.parent',
      leafToolUseId: 'call.0',
    })
    expect(parseCanonicalNestedAgentToolRef('A/reviewer@review-team/Agent:0')).toEqual({
      parentAgentId: 'reviewer@review-team',
      leafToolUseId: 'Agent:0',
    })
    expect(parseCanonicalNestedAgentToolRef('A/parent\0id/call.0')).toBeNull()
    expect(parseCanonicalNestedAgentToolRef('top-level-tool')).toBeNull()
  })

  it('deduplicates copied transcript history by upstream id while retaining legitimate repeated messages', () => {
    const repeated = (id: string): MessageEntry => ({
      id,
      type: 'assistant',
      content: 'same reply',
      timestamp: '2026-01-01T00:00:02.000Z',
    })
    const copied = repeated('shared-message-id')

    expect(mergeTeammateTranscriptFragments([
      { messages: [copied, repeated('legitimate-repeat-1')] },
      { messages: [{ ...copied }, repeated('legitimate-repeat-2')] },
    ])).toEqual([
      copied,
      repeated('legitimate-repeat-1'),
      repeated('legitimate-repeat-2'),
    ])
  })

  it('drops a rewritten fragment that its successor already carries forward', () => {
    const call: MessageEntry = {
      id: 'tool-call',
      type: 'tool_use',
      content: [{ type: 'tool_use', id: 'Bash:0', name: 'Bash', input: { command: 'ls' } }],
      timestamp: '2026-01-01T00:00:01.000Z',
    } as MessageEntry
    const result: MessageEntry = {
      id: 'tool-result',
      type: 'tool_result',
      content: [{ type: 'tool_result', tool_use_id: 'Bash:0', content: 'ok' }],
      timestamp: '2026-01-01T00:00:02.000Z',
    } as MessageEntry

    expect(dropSupersededTeammateFragments([
      { agentId: 'first', messages: [call] },
      { agentId: 'rewrite', messages: [call, result] },
    ])).toEqual([{ agentId: 'rewrite', messages: [call, result] }])
  })

  it('keeps independent resumes that reuse message ids for different work', () => {
    const reply = (text: string): MessageEntry => ({
      id: 'shared-message-id',
      type: 'assistant',
      content: text,
      timestamp: '2026-01-01T00:00:01.000Z',
    } as MessageEntry)

    expect(dropSupersededTeammateFragments([
      { agentId: 'first', messages: [reply('first run')] },
      { agentId: 'second', messages: [reply('second run'), reply('second run tail')] },
    ])).toHaveLength(2)
  })

  it('resolves agentId, description, and prompt from parent Agent messages by toolUseId', () => {
    const messages = [
      {
        id: 'assistant-agent-use',
        type: 'tool_use',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'Agent',
          input: { description: 'Explore repo', prompt: 'Read files' },
        }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'user-agent-result',
        type: 'tool_result',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: [{ type: 'text', text: 'agentId: abc123\nStarted' }],
        }],
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ] as MessageEntry[]

    expect(resolveSubagentRunFromMessages(messages, 'tool-1')).toMatchObject({
      agentId: 'abc123',
      description: 'Explore repo',
      prompt: 'Read files',
    })
  })

  it('does not truncate transcripts with at most 1000 messages', () => {
    const messages = Array.from({ length: 1000 }, (_, index) => ({ id: String(index) }))

    const result = truncateSubagentMessages(messages)

    expect(result).toEqual({ messages, truncated: false })
  })

  it('truncates long transcripts to first 50 and latest 950 entries', () => {
    const messages = Array.from({ length: 1200 }, (_, index) => ({ id: String(index) }))

    const result = truncateSubagentMessages(messages)

    expect(result.truncated).toBe(true)
    expect(result.messages).toHaveLength(1000)
    expect(result.messages[0]).toEqual({ id: '0' })
    expect(result.messages[49]).toEqual({ id: '49' })
    expect(result.messages[50]).toEqual({ id: '250' })
    expect(result.messages[999]).toEqual({ id: '1199' })
  })
})

describe('getSubagentRunByTool', () => {
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
    delete process.env.CLAUDE_CONFIG_DIR
  })

  for (const damaged of ['oversized', 'malformed'] as const) {
    it(`keeps valid Agent evidence when unrelated ${damaged} records are skipped`, async () => {
      await setupTmpConfigDir()
      const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const projectDir = '-tmp-subagent-partial'
      await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('tool-1'), makeAgentToolResultEntry('tool-1', 'abc123')])
      const file = path.join(tmpDir!, 'projects', projectDir, `${sessionId}.jsonl`)
      await fs.appendFile(file, damaged === 'oversized' ? JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(9 * 1024 * 1024) } }) + '\n' : '{bad json\n')
      const result = await getSubagentRunByTool(sessionId, 'tool-1')
      expect(result).toMatchObject({ agentId: 'abc123', status: 'completed', historyComplete: false, truncated: true })
      expect(result?.result).toContain('Finished exploring')
    })
  }

  it('returns unknown recoverable evidence when the addressed record was omitted', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-missing-partial'
    const entry = makeAgentToolUseEntry('tool-1')
    ;(entry.message as any).content[0].input.prompt = 'x'.repeat(9 * 1024 * 1024)
    await writeSessionFile(projectDir, sessionId, [entry])
    expect(await getSubagentRunByTool(sessionId, 'tool-1')).toMatchObject({ status: 'unknown', historyComplete: false, activityComplete: false, truncated: true, canSendMessage: false })
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('tool-1'), makeOneShotAgentToolResultEntry('tool-1')])
    expect(await getSubagentRunByTool(sessionId, 'tool-1')).toMatchObject({ status: 'completed', historyComplete: true })
    expect(await getSubagentRunByTool(sessionId, 'missing')).toBeNull()
  })

  it('keeps incomplete nested lookups unknown instead of reporting absence', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-nested-partial'
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('parent-tool')])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'parent123', [{ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(9 * 1024 * 1024) } }])
    expect(await getSubagentRunByTool(sessionId, 'parent-tool/parent123/missing')).toMatchObject({ status: 'unknown', historyComplete: false, canSendMessage: false })
  })

  it('retains an unreadable child transcript without inferring workflow completion', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-child-partial'
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('tool-1')])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'child123', [{ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(9 * 1024 * 1024) } }])
    expect(await getSubagentRunByAgentId(sessionId, 'child123')).toMatchObject({ agentId: 'child123', status: 'unknown', historyComplete: false, messages: [] })
  })

  it('retains a complete child message above one MiB in the small transcript reader', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-small-large-message'
    const agentId = 'child-large-message'
    const content = 'START' + 'x'.repeat(1100 * 1024) + 'END'
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('tool-1')])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [{
      type: 'assistant', uuid: 'child-reply', isSidechain: true,
      message: { role: 'assistant', content },
    }])
    const result = await getSubagentRunByAgentId(sessionId, agentId)
    expect(result).toMatchObject({ agentId, historyComplete: true })
    expect(result?.messages).toHaveLength(1)
    expect(result?.messages[0]?.content).toBe(content)
  })

  it('keeps the visible tail of a large sidechain transcript inside its own agent run', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-large-sidechain'
    const agentId = 'sidechain123'
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('tool-1')])
    const entries = Array.from({ length: 220 }, (_, index) => ({
      type: index === 0 ? 'user' : 'assistant',
      uuid: `sidechain-${index}`,
      parentUuid: index ? `sidechain-${index - 1}` : null,
      isSidechain: true,
      message: { role: index === 0 ? 'user' : 'assistant', content: index === 219 ? 'Latest visible child reply' : 'x'.repeat(8192) },
      timestamp: '2026-01-01T00:00:00.000Z',
    }))
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, entries)
    const result = await getSubagentRunByAgentId(sessionId, agentId)
    expect(result?.messages.length).toBeGreaterThan(0)
    expect(result?.messages.at(-1)?.content).toBe('Latest visible child reply')
    expect(result).toMatchObject({ historyComplete: false, activityComplete: false, truncated: true })
    expect(result!.messages.length).toBeLessThan(entries.length)
  })

  it('previews a large addressed call and result while retaining their identity', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-large-target'
    const call = makeAgentToolUseEntry('tool-1')
    ;(call.message as any).content[0].input = { prompt: 'Investigate this code: ' + 'x'.repeat(1100 * 1024), description: 'Large target', subagent_type: 'Explore' }
    const result = makeOneShotAgentToolResultEntry('tool-1')
    ;(result.message as any).content[0].content[0].text = 'Investigation finished: ' + 'x'.repeat(1100 * 1024)
    await writeSessionFile(projectDir, sessionId, [call, result])
    const run = await getSubagentRunByTool(sessionId, 'tool-1')
    expect(run).toMatchObject({ historyComplete: false, truncated: true })
    expect(run?.description).toBe('Large target')
    const lookup = await sessionService.getSubagentRunLookup(sessionId, 'tool-1')
    expect((lookup.messages[0]?.content as any[])[0]).toMatchObject({ id: 'tool-1', name: 'Agent', input: { description: 'Large target', subagent_type: 'Explore' } })
    expect(run?.prompt).toContain('Investigate this code:')
    expect(run?.result).toContain('Investigation finished:')
    expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThan(128 * 1024)
  })

  it('returns bounded evidence when addressed entries exceed the aggregate count budget', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-many-targets'
    await writeSessionFile(projectDir, sessionId, Array.from({ length: 2050 }, (_, index) => ({ ...makeAgentToolUseEntry('tool-1'), uuid: `call-${index}` })))
    const run = await getSubagentRunByTool(sessionId, 'tool-1')
    expect(run).toMatchObject({ status: 'unknown', historyComplete: false, truncated: true })
    expect(run?.prompt).toBeTruthy()
  })

  it('preserves bounded previews when addressed payloads exceed the aggregate byte budget', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-many-bytes'
    await writeSessionFile(projectDir, sessionId, Array.from({ length: 160 }, (_, index) => {
      const entry = makeAgentToolUseEntry('tool-1')
      ;(entry.message as any).content[0].input.prompt = 'x'.repeat(16 * 1024)
      return { ...entry, uuid: `call-${index}` }
    }))
    const lookup = await sessionService.getSubagentRunLookup(sessionId, 'tool-1')
    expect(lookup.historyComplete).toBe(false)
    expect(lookup.messages.length).toBeGreaterThan(0)
    expect(lookup.messages.length).toBeLessThan(160)
    expect(Buffer.byteLength(JSON.stringify(lookup))).toBeLessThan(2 * 1024 * 1024)
  })

  it('bounds parent lookup and large child display without claiming complete activity or partial token totals', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-large'
    const body = Array.from({ length: 24 }, (_, index) => ({ type: 'assistant', uuid: `body-${index}`, timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'assistant', content: 'x'.repeat(256 * 1024) } }))
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('tool-1'), ...body, makeAgentToolResultEntry('tool-1', 'abc123')])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'abc123', body)
    const original = (sessionService as any).readJsonlFile
    ;(sessionService as any).readJsonlFile = () => { throw new Error('unbounded transcript read') }
    try {
      const result = await getSubagentRunByTool(sessionId, 'tool-1')
      expect(result).toMatchObject({ agentId: 'abc123', truncated: true, historyComplete: false, activityComplete: false })
      expect(result!.messages.length).toBeGreaterThan(0)
      expect(result!.messages.length).toBeLessThan(24)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024)
      expect(result!.messages.at(-1)!.id).toBe('body-23')
    } finally {
      ;(sessionService as any).readJsonlFile = original
    }
  })

  it('rejects oversized launch sidecars before parsing them', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-sidecar'
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry('tool-1')])
    await writeSubagentLaunchMetadata(projectDir, sessionId, 'abc123', { agentType: 'general', toolUseId: 'tool-1', description: 'x'.repeat(128 * 1024) })
    await expect(getSubagentRunByTool(sessionId, 'tool-1')).rejects.toMatchObject({ statusCode: 413, code: 'SUBAGENT_METADATA_LIMIT' })
  })

  it('returns parent metadata and visible persisted subagent transcript messages', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      makeAgentToolResultEntry(toolUseId, agentId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>tool-1</tool-use-id>\n<status>completed</status>\n<summary>Agent completed</summary>\n<result>Finished exploring the repo</result>\n<output-file>/tmp/agent.out</output-file>\n</task-notification>',
        },
        uuid: 'task-notification',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Read the source' },
        uuid: 'subagent-user',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Found the service seam' }],
          usage: { input_tokens: 13, output_tokens: 17 },
        },
        uuid: 'subagent-assistant',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({
      sessionId,
      toolUseId,
      agentId,
      taskId: 'task-1',
      status: 'completed',
      description: 'Explore repo',
      prompt: 'Read files',
      summary: 'Agent completed',
      result: 'Finished exploring the repo',
      outputFile: '/tmp/agent.out',
      usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
      truncated: false,
      updatedAt: '2026-01-01T00:00:06.000Z',
      source: 'subagent-jsonl',
    })
    expect(result?.messages).toHaveLength(2)
    expect(result?.messages[0]).toMatchObject({
      type: 'user',
      content: 'Read the source',
      isSidechain: undefined,
    })
    expect(result?.messages[1]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'text', text: 'Found the service seam' }],
      usage: { input_tokens: 13, output_tokens: 17 },
    })
    // Below the truncation threshold the Activity projection IS `messages`, so
    // the server omits it rather than shipping the same array twice. The text
    // check catches a re-introduced duplicate even if the field name changes.
    expect(result?.activityMessages).toBeUndefined()
    expect(JSON.stringify(result).split('Found the service seam')).toHaveLength(2)
  })

  it('keeps Activity complete when the conversation projection crosses 1000 messages', async () => {
    await setupTmpConfigDir()
    const sessionId = '31313131-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-long-run'
    const agentId = 'longrun123'
    const transcript = Array.from({ length: 1_200 }, (_, index): Record<string, unknown> => ({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: index === 120
          ? [{
              type: 'tool_use',
              id: 'todo-in-truncated-middle',
              name: 'TodoWrite',
              input: { todos: [{ content: 'Keep the middle activity', status: 'in_progress' }] },
            }]
          : `message ${index}`,
      },
      uuid: `long-message-${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }))

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      makeAgentToolResultEntry(toolUseId, agentId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, transcript)

    const firstPoll = await getSubagentRunByTool(sessionId, toolUseId)
    const secondPoll = await getSubagentRunByTool(sessionId, toolUseId)

    expect(firstPoll).toMatchObject({ truncated: true })
    expect(firstPoll?.messages).toHaveLength(1_000)
    expect(firstPoll?.messages.some(message => message.id === 'long-message-120')).toBe(false)
    expect(firstPoll?.activityMessages).toHaveLength(1_200)
    expect(firstPoll?.activityMessages.some(message => message.id === 'long-message-120')).toBe(true)
    expect(secondPoll?.activityMessages.map(message => message.id)).toEqual(
      firstPoll?.activityMessages.map(message => message.id),
    )
  })

  it('returns child shell notifications without exposing notification turns or their response', async () => {
    await setupTmpConfigDir()
    const sessionId = '12121212-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      makeAgentToolResultEntry(toolUseId, agentId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'shell.call:0',
            name: 'Bash',
            input: { command: 'bun test', run_in_background: true },
          }],
        },
        uuid: 'child-shell-use',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'shell.call:0',
            content: 'Command running in background with ID: shell-task-1',
          }],
        },
        uuid: 'child-shell-result',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>shell-task-1</task-id>\n<tool-use-id>shell.call:0</tool-use-id>\n<status>killed</status>\n<summary>Child shell was stopped &amp; cleaned up</summary>\n<output-file>/tmp/shell-task-1.output</output-file>\n</task-notification>',
        },
        uuid: 'child-shell-notification',
        timestamp: '2026-01-01T00:00:07.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Internal notification response' }],
        },
        uuid: 'child-notification-response',
        timestamp: '2026-01-01T00:00:08.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result?.messages).toHaveLength(2)
    expect(JSON.stringify(result?.messages)).not.toContain('<task-notification>')
    expect(JSON.stringify(result?.messages)).not.toContain('Internal notification response')
    expect(result?.taskNotifications).toEqual([{
      taskId: 'shell-task-1',
      toolUseId: 'shell.call:0',
      status: 'stopped',
      summary: 'Child shell was stopped & cleaned up',
      outputFile: '/tmp/shell-task-1.output',
      timestamp: '2026-01-01T00:00:07.000Z',
    }])
    expect(result?.updatedAt).toBe('2026-01-01T00:00:07.000Z')
  })

  it('uses the live task id to resolve a running one-shot SubAgent transcript', async () => {
    await setupTmpConfigDir()
    const sessionId = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Read the source' },
        uuid: 'subagent-user',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'subagent-tool-1',
            name: 'Read',
            input: { file_path: '/tmp/example.ts' },
          }],
        },
        uuid: 'subagent-assistant-tool',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'subagent-tool-1',
            content: 'export const ready = true',
          }],
        },
        uuid: 'subagent-tool-result',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId, agentId)

    expect(result).toMatchObject({
      sessionId,
      toolUseId,
      agentId,
      taskId: agentId,
      status: 'running',
      source: 'subagent-jsonl',
      canSendMessage: false,
    })
    expect(result?.messages).toHaveLength(3)
    expect(result?.messages[1]).toMatchObject({
      type: 'tool_use',
      content: [{ type: 'tool_use', id: 'subagent-tool-1', name: 'Read' }],
    })
    expect(result?.messages[2]).toMatchObject({
      type: 'tool_result',
      content: [{ type: 'tool_result', tool_use_id: 'subagent-tool-1' }],
    })
  })

  it('streams a running one-shot SubAgent transcript resolved from launch metadata alone', async () => {
    await setupTmpConfigDir()
    const sessionId = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'call_00_live'
    const agentId = 'a46d5bd4ae656c8d5'

    // A synchronously dispatched agent that is still running: the parent has
    // only the tool_use, so there is no result text to mine an agent id from
    // and no background task id for the client to pass in.
    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
    ])
    await writeSubagentLaunchMetadata(projectDir, sessionId, agentId, {
      agentType: 'general-purpose',
      description: 'Explore repo',
      toolUseId,
    })
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Read the source' },
        uuid: 'subagent-user',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'subagent-tool-1',
            name: 'Bash',
            input: { command: 'git log --oneline -5' },
          }],
        },
        uuid: 'subagent-assistant-tool',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({
      sessionId,
      toolUseId,
      agentId,
      status: 'running',
      source: 'subagent-jsonl',
      // Still running, but synchronously dispatched: the parent turn is
      // waiting on its result, so there is no inbox to send into.
      canSendMessage: false,
    })
    expect(result?.messages).toHaveLength(2)
    expect(result?.messages[1]).toMatchObject({
      type: 'tool_use',
      content: [{ type: 'tool_use', id: 'subagent-tool-1', name: 'Bash' }],
    })
  })

  it('resolves a canonical nested Agent ref from its running parent transcript', async () => {
    await setupTmpConfigDir()
    const sessionId = '34343434-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const parentToolUseId = 'Agent:parent'
    const parentAgentId = 'parent123'
    const leafToolUseId = 'call.0'
    const childAgentId = 'child456'
    const canonicalRef = `${parentToolUseId}/${parentAgentId}/${leafToolUseId}`

    // The parent Agent is still running, so the root transcript has no result
    // linking it to parentAgentId and cannot join its nested tool calls yet.
    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(parentToolUseId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, parentAgentId, [
      {
        ...makeAgentToolUseEntry(leafToolUseId),
        uuid: 'nested-agent-use',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ])
    await writeSubagentLaunchMetadata(projectDir, sessionId, childAgentId, {
      agentType: 'general-purpose',
      toolUseId: leafToolUseId,
    })
    await writeSubagentTranscriptFile(projectDir, sessionId, childAgentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Nested child is still inspecting files' }],
        },
        uuid: 'nested-child-message',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, canonicalRef)

    expect(result).toMatchObject({
      toolUseId: canonicalRef,
      agentId: childAgentId,
      status: 'running',
      description: 'Explore repo',
      source: 'subagent-jsonl',
    })
    expect(result?.messages).toHaveLength(1)
  })

  it('keeps live nested sidecar lookup scoped to the physical parent owner', async () => {
    await setupTmpConfigDir()
    const sessionId = '37373737-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const leafToolUseId = 'Agent:0'
    const parents = [
      { toolUseId: 'Agent:parent-a', agentId: 'parent-live-a', childAgentId: 'child-live-a' },
      { toolUseId: 'Agent:parent-b', agentId: 'parent-live-b', childAgentId: 'child-live-b' },
    ]

    await writeSessionFile(projectDir, sessionId, parents.map((parent, index) => ({
      ...makeAgentToolUseEntry(parent.toolUseId),
      uuid: `root-parent-use-${index}`,
    })))
    for (const [index, parent] of parents.entries()) {
      await writeSubagentTranscriptFile(projectDir, sessionId, parent.agentId, [{
        ...makeAgentToolUseEntry(leafToolUseId),
        uuid: `parent-leaf-use-${index}`,
        timestamp: `2026-01-01T00:00:0${index + 2}.000Z`,
      }])
      await writeSubagentLaunchMetadata(projectDir, sessionId, parent.childAgentId, {
        agentType: 'general-purpose',
        toolUseId: leafToolUseId,
        ownerAgentId: parent.agentId,
      })
      await writeSubagentTranscriptFile(projectDir, sessionId, parent.childAgentId, [{
        type: 'assistant',
        message: { role: 'assistant', content: `Live child for ${parent.agentId}` },
        uuid: `live-child-message-${index}`,
        timestamp: `2026-01-01T00:00:0${index + 4}.000Z`,
      }])
    }

    const results = await Promise.all(parents.map(parent => getSubagentRunByTool(
      sessionId,
      `${parent.toolUseId}/${parent.agentId}/${leafToolUseId}`,
    )))

    expect(results.map(result => result?.agentId)).toEqual(
      parents.map(parent => parent.childAgentId),
    )
    expect(results.map(result => result?.messages[0]?.content)).toEqual(
      parents.map(parent => `Live child for ${parent.agentId}`),
    )
    expect(results.map(result => result?.status)).toEqual(['running', 'running'])
  })

  it('does not guess between ownerless legacy sidecars that reuse a nested leaf id', async () => {
    await setupTmpConfigDir()
    const sessionId = '39393939-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const parentToolUseId = 'Agent:legacy-parent'
    const parentAgentId = 'legacy-parent'
    const leafToolUseId = 'Agent:0'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(parentToolUseId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, parentAgentId, [{
      ...makeAgentToolUseEntry(leafToolUseId),
      uuid: 'legacy-parent-leaf-use',
      timestamp: '2026-01-01T00:00:02.000Z',
    }])
    for (const [index, childAgentId] of ['legacy-child-a', 'legacy-child-b'].entries()) {
      await writeSubagentLaunchMetadata(projectDir, sessionId, childAgentId, {
        agentType: 'general-purpose',
        toolUseId: leafToolUseId,
      })
      await writeSubagentTranscriptFile(projectDir, sessionId, childAgentId, [{
        type: 'assistant',
        message: { role: 'assistant', content: `Ambiguous legacy child ${index}` },
        uuid: `ambiguous-legacy-child-${index}`,
        timestamp: `2026-01-01T00:00:0${index + 3}.000Z`,
      }])
    }

    const result = await getSubagentRunByTool(
      sessionId,
      `${parentToolUseId}/${parentAgentId}/${leafToolUseId}`,
    )

    expect(result).toMatchObject({
      agentId: null,
      status: 'running',
      messages: [],
      source: 'session-history',
    })
  })

  it('keeps joined nested terminal notifications scoped to the physical parent owner', async () => {
    await setupTmpConfigDir()
    const sessionId = '38383838-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const leafToolUseId = 'call.0'
    const parents = [
      {
        toolUseId: 'Agent:terminal-parent-a',
        agentId: 'parent-terminal-a',
        childAgentId: 'child-terminal-a',
        status: 'completed' as const,
        summary: 'Parent A child completed',
      },
      {
        toolUseId: 'Agent:terminal-parent-b',
        agentId: 'parent-terminal-b',
        childAgentId: 'child-terminal-b',
        status: 'failed' as const,
        summary: 'Parent B child failed',
      },
    ]

    await writeSessionFile(projectDir, sessionId, [
      ...parents.map((parent, index) => ({
        ...makeAgentToolUseEntry(parent.toolUseId),
        uuid: `root-terminal-parent-use-${index}`,
      })),
      ...parents.map((parent, index) => ({
        ...makeAgentToolResultEntry(parent.toolUseId, parent.agentId),
        uuid: `root-terminal-parent-result-${index}`,
        timestamp: `2026-01-01T00:00:0${index + 2}.500Z`,
      })),
      ...parents.map((parent, index) => makeTaskNotificationEntry(
        leafToolUseId,
        parent.childAgentId,
        parent.status,
        {
          ownerAgentId: parent.agentId,
          summary: parent.summary,
          timestamp: `2026-01-01T00:00:1${index}.000Z`,
        },
      )),
    ])
    for (const [index, parent] of parents.entries()) {
      await writeSubagentTranscriptFile(projectDir, sessionId, parent.agentId, [{
        ...makeAgentToolUseEntry(leafToolUseId),
        uuid: `terminal-parent-leaf-use-${index}`,
        timestamp: `2026-01-01T00:00:0${index + 2}.000Z`,
      }])
      await writeSubagentTranscriptFile(projectDir, sessionId, parent.childAgentId, [{
        type: 'assistant',
        message: { role: 'assistant', content: `Terminal child for ${parent.agentId}` },
        uuid: `terminal-child-message-${index}`,
        timestamp: `2026-01-01T00:00:0${index + 4}.000Z`,
      }])
    }

    const results = await Promise.all(parents.map(parent => getSubagentRunByTool(
      sessionId,
      `${parent.toolUseId}/${parent.agentId}/${leafToolUseId}`,
    )))

    expect(results.map(result => result?.agentId)).toEqual(
      parents.map(parent => parent.childAgentId),
    )
    expect(results.map(result => result?.status)).toEqual(
      parents.map(parent => parent.status),
    )
    expect(results.map(result => result?.summary)).toEqual(
      parents.map(parent => parent.summary),
    )
    expect(results.map(result => result?.messages[0]?.content)).toEqual(
      parents.map(parent => `Terminal child for ${parent.agentId}`),
    )
  })

  it('resolves a nested Team member ref through the newest UUID transcript fragment', async () => {
    await setupTmpConfigDir()
    const sessionId = '45454545-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const parentToolUseId = 'Agent:team-parent'
    const parentTeamRef = 'reviewer@review-team'
    const leafToolUseId = 'Agent:0'
    const olderFragmentId = '11111111-2222-3333-4444-555555555555'
    const latestFragmentId = '66666666-7777-8888-9999-aaaaaaaaaaaa'
    const staleChildAgentId = 'stale-child'
    const childAgentId = 'current-child'
    const canonicalRef = `${parentToolUseId}/${parentTeamRef}/${leafToolUseId}`

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(parentToolUseId),
      makeAgentToolResultEntry(parentToolUseId, parentTeamRef),
      makeTaskNotificationEntry(leafToolUseId, childAgentId, 'completed'),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, olderFragmentId, [
      {
        ...makeAgentToolUseEntry(leafToolUseId),
        uuid: 'older-nested-agent-use',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        ...makeAgentToolResultEntry(leafToolUseId, staleChildAgentId),
        uuid: 'older-nested-agent-result',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])
    await writeSubagentMetadata(projectDir, sessionId, olderFragmentId, 'reviewer', 1_000)
    await writeSubagentTranscriptFile(projectDir, sessionId, latestFragmentId, [
      {
        ...makeAgentToolUseEntry(leafToolUseId),
        uuid: 'latest-nested-agent-use',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        ...makeAgentToolResultEntry(leafToolUseId, childAgentId),
        uuid: 'latest-nested-agent-result',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
    ])
    await writeSubagentMetadata(projectDir, sessionId, latestFragmentId, 'reviewer', 2_000)
    await writeSubagentTranscriptFile(projectDir, sessionId, childAgentId, [
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'Current nested teammate child completed' },
        uuid: 'team-nested-child-message',
        timestamp: '2026-01-01T00:00:07.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, canonicalRef)

    expect(result).toMatchObject({
      toolUseId: canonicalRef,
      agentId: childAgentId,
      taskId: childAgentId,
      status: 'completed',
      description: 'Explore repo',
      source: 'subagent-jsonl',
    })
    expect(result?.messages.map(message => message.id)).toEqual([
      'team-nested-child-message',
    ])
  })

  it('uses the raw leaf id for a joined nested Agent terminal notification', async () => {
    await setupTmpConfigDir()
    const sessionId = '56565656-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const parentToolUseId = 'Agent:parent'
    const parentAgentId = 'parent123'
    const leafToolUseId = 'Agent:0'
    const childAgentId = 'child456'
    const canonicalRef = `${parentToolUseId}/${parentAgentId}/${leafToolUseId}`

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(parentToolUseId),
      makeAgentToolResultEntry(parentToolUseId, parentAgentId),
      makeTaskNotificationEntry(leafToolUseId, childAgentId, 'completed'),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, parentAgentId, [
      {
        ...makeAgentToolUseEntry(leafToolUseId),
        uuid: 'nested-agent-use',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        ...makeAgentToolResultEntry(leafToolUseId, childAgentId),
        uuid: 'nested-agent-result',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, childAgentId, [
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'Nested work completed' },
        uuid: 'nested-child-message',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, canonicalRef)

    expect(result).toMatchObject({
      toolUseId: canonicalRef,
      agentId: childAgentId,
      taskId: childAgentId,
      status: 'completed',
      source: 'subagent-jsonl',
    })
  })

  it('resolves the agent id from launch metadata even before the transcript has entries', async () => {
    await setupTmpConfigDir()
    const sessionId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'call_00_cold'
    const agentId = 'b91f2c3d4e5a6b7c8'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
    ])
    await writeSubagentLaunchMetadata(projectDir, sessionId, agentId, {
      agentType: 'general-purpose',
      toolUseId,
    })

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({ agentId, status: 'running' })
    expect(result?.messages).toHaveLength(0)
  })

  it('ignores launch metadata written for a different tool call', async () => {
    await setupTmpConfigDir()
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'call_00_mine'
    const otherAgentId = 'f00dcafe12345678a'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
    ])
    await writeSubagentLaunchMetadata(projectDir, sessionId, otherAgentId, {
      agentType: 'general-purpose',
      toolUseId: 'call_99_someone_else',
    })
    await writeSubagentTranscriptFile(projectDir, sessionId, otherAgentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Not for this card' },
        uuid: 'other-subagent-user',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result?.agentId).toBeNull()
    expect(result?.messages).toHaveLength(0)
  })

  it('uses the terminal notification task id when a one-shot result omits agentId', async () => {
    await setupTmpConfigDir()
    const sessionId = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      makeOneShotAgentToolResultEntry(toolUseId),
      makeTaskNotificationEntry(toolUseId, agentId, 'completed'),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'subagent-tool-1', name: 'Read', input: {} }],
        },
        uuid: 'subagent-assistant-tool',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'subagent-tool-1', content: 'done' }],
        },
        uuid: 'subagent-tool-result',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({
      agentId,
      taskId: agentId,
      status: 'completed',
      source: 'subagent-jsonl',
    })
    expect(result?.messages).toHaveLength(2)
  })

  it('aggregates resumed named teammate fragments and returns the latest resumable transcript id', async () => {
    await setupTmpConfigDir()
    const sessionId = '11111111-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-team-1'
    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{
              type: 'text',
              text: 'Spawned successfully.\nagent_id: id-worker-a@workbench-id-0808\nname: id-worker-a\nteam_name: workbench-id-0808',
            }],
          }],
        },
        uuid: 'team-agent-result',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'older123', [{
      type: 'assistant',
      message: { role: 'assistant', content: 'First teammate turn' },
      uuid: 'older-message',
      timestamp: '2026-01-01T00:00:03.000Z',
    }])
    await writeSubagentMetadata(projectDir, sessionId, 'older123', 'id-worker-a', 1_000)
    await writeSubagentTranscriptFile(projectDir, sessionId, 'latest456', [{
      type: 'assistant',
      message: { role: 'assistant', content: 'Resumed teammate turn' },
      uuid: 'latest-message',
      timestamp: '2026-01-01T00:00:04.000Z',
    }])
    await writeSubagentMetadata(projectDir, sessionId, 'latest456', 'id-worker-a', 2_000)

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({
      agentId: 'latest456',
      status: 'completed',
      source: 'subagent-jsonl',
      // A named teammate keeps its mailbox after a turn ends.
      canSendMessage: true,
    })
    expect(result?.messages.map((message) => message.content)).toEqual([
      'First teammate turn',
      'Resumed teammate turn',
    ])
  })

  it('keeps the owning resumed fragment in each nested Agent activity route', async () => {
    await setupTmpConfigDir()
    const sessionId = '91919191-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-team-route'
    const nestedToolUseId = 'Agent:0'
    const olderAgentId = 'older-route-123'
    const latestAgentId = 'latest-route-456'
    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'agent_id: reviewer@review-team',
          }],
        },
        uuid: 'team-route-result',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, olderAgentId, [
      {
        ...makeAgentToolUseEntry(nestedToolUseId),
        uuid: 'older-route-use',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        ...makeAgentToolResultEntry(nestedToolUseId, 'older-child'),
        uuid: 'older-route-result',
        timestamp: '2026-01-01T00:00:03.500Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'shared-shell', name: 'Bash', input: { command: 'old check', run_in_background: true } },
          { type: 'tool_use', id: 'shared-todo', name: 'TodoWrite', input: { todos: [] } },
        ] },
        uuid: 'older-shared-tools',
        timestamp: '2026-01-01T00:00:03.600Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared-shell', content: 'Command running in background with ID: older-shell-task' }] },
        uuid: 'older-shell-result',
        timestamp: '2026-01-01T00:00:03.700Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: '<task-notification>\n<task-id>older-shell-task</task-id>\n<tool-use-id>shared-shell</tool-use-id>\n<status>completed</status>\n<summary>Older shell complete</summary>\n</task-notification>' },
        uuid: 'older-shell-notification',
        timestamp: '2026-01-01T00:00:03.800Z',
      },
    ])
    await writeSubagentMetadata(projectDir, sessionId, olderAgentId, 'reviewer', 1_000)
    await writeSubagentTranscriptFile(projectDir, sessionId, latestAgentId, [
      {
        ...makeAgentToolUseEntry(nestedToolUseId),
        uuid: 'latest-route-use',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        ...makeAgentToolResultEntry(nestedToolUseId, 'latest-child'),
        uuid: 'latest-route-result',
        timestamp: '2026-01-01T00:00:04.500Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'shared-shell', name: 'Bash', input: { command: 'new check', run_in_background: true } },
          { type: 'tool_use', id: 'shared-todo', name: 'TodoWrite', input: { todos: [] } },
        ] },
        uuid: 'latest-shared-tools',
        timestamp: '2026-01-01T00:00:04.600Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared-shell', content: 'Command running in background with ID: latest-shell-task' }] },
        uuid: 'latest-shell-result',
        timestamp: '2026-01-01T00:00:04.700Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: '<task-notification>\n<task-id>latest-shell-task</task-id>\n<tool-use-id>shared-shell</tool-use-id>\n<status>failed</status>\n<summary>Latest shell failed</summary>\n</task-notification>' },
        uuid: 'latest-shell-notification',
        timestamp: '2026-01-01T00:00:04.800Z',
      },
    ])
    await writeSubagentMetadata(projectDir, sessionId, latestAgentId, 'reviewer', 2_000)

    const result = await getSubagentRunByTool(sessionId, toolUseId)
    const agentIds = (messages: MessageEntry[] | undefined) => messages?.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.flatMap((block) => (
            block && typeof block === 'object' &&
            (block as { type?: unknown }).type === 'tool_use' &&
            (block as { name?: unknown }).name === 'Agent'
              ? [String((block as { id?: unknown }).id)]
              : []
          ))
        : []
    ))

    expect(result?.agentId).toBe(latestAgentId)
    const scopedIds = [
      `${olderAgentId}/${nestedToolUseId}`,
      `${latestAgentId}/${nestedToolUseId}`,
    ]
    expect(agentIds(result?.messages)).toEqual(scopedIds)
    expect(agentIds(result?.activityMessages ?? result?.messages)).toEqual(scopedIds)
    const resultIds = result?.messages.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.flatMap((block) => (
            block && typeof block === 'object' &&
            (block as { type?: unknown }).type === 'tool_result'
              ? [String((block as { tool_use_id?: unknown }).tool_use_id)]
              : []
          ))
        : []
    ))
    expect(resultIds?.filter(id => id.endsWith(`/${nestedToolUseId}`))).toEqual(scopedIds)
    const toolIds = (name: string) => result?.messages.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.flatMap((block) => (
            block && typeof block === 'object' &&
            (block as { type?: unknown }).type === 'tool_use' &&
            (block as { name?: unknown }).name === name
              ? [String((block as { id?: unknown }).id)]
              : []
          ))
        : []
    ))
    expect(toolIds('Bash')).toEqual([
      `${olderAgentId}/shared-shell`,
      `${latestAgentId}/shared-shell`,
    ])
    expect(toolIds('TodoWrite')).toEqual([
      `${olderAgentId}/shared-todo`,
      `${latestAgentId}/shared-todo`,
    ])
    expect(result?.activityTaskNotifications.map(notification => notification.toolUseId)).toEqual([
      `${olderAgentId}/shared-shell`,
      `${latestAgentId}/shared-shell`,
    ])
  })

  it('deduplicates child task notifications across resumed teammate fragments', async () => {
    await setupTmpConfigDir()
    const sessionId = '78787878-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-team-1'
    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'agent_id: reviewer@review-team',
          }],
        },
        uuid: 'team-agent-result',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'older123', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'First teammate turn' },
        uuid: 'older-message',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>shell-task</task-id>\n<tool-use-id>shell-tool</tool-use-id>\n<status>completed</status>\n<summary>Old completion</summary>\n</task-notification>',
        },
        uuid: 'older-notification',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
    ])
    await writeSubagentMetadata(projectDir, sessionId, 'older123', 'reviewer', 1_000)
    await writeSubagentTranscriptFile(projectDir, sessionId, 'latest456', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'Resumed teammate turn' },
        uuid: 'latest-message',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>shell-task</task-id>\n<tool-use-id>shell-tool</tool-use-id>\n<status>failed</status>\n<summary>Latest failure</summary>\n</task-notification>',
        },
        uuid: 'latest-notification',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
    ])
    await writeSubagentMetadata(projectDir, sessionId, 'latest456', 'reviewer', 2_000)

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result?.taskNotifications).toEqual([{
      taskId: 'shell-task',
      toolUseId: 'shell-tool',
      status: 'failed',
      summary: 'Latest failure',
      timestamp: '2026-01-01T00:00:06.000Z',
    }])
  })

  it('keeps an async launch acknowledgement running until a terminal notification arrives', async () => {
    await setupTmpConfigDir()
    const sessionId = 'abababab-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Async agent launched successfully.\nagentId: ${agentId}\nThe agent is working in the background.`,
          }],
        },
        uuid: 'async-launch-result',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId, agentId)

    expect(result).toMatchObject({
      agentId,
      taskId: agentId,
      status: 'running',
      source: 'live-task',
      // An in-flight background agent has a live inbox: a follow-up queues.
      canSendMessage: true,
    })
  })

  it('ignores unsafe live task ids instead of using them as transcript paths', async () => {
    await setupTmpConfigDir()
    const sessionId = 'cdcdcdcd-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    await writeSessionFile(projectDir, sessionId, [makeAgentToolUseEntry(toolUseId)])

    const result = await getSubagentRunByTool(sessionId, toolUseId, 'agent-/../../outside')

    expect(result).toMatchObject({
      agentId: null,
      status: 'running',
      source: 'session-history',
    })
    expect(result?.taskId).toBeUndefined()
    expect(result?.messages).toEqual([])
  })

  it('does not report usage when parent and transcript usage are unknown', async () => {
    await setupTmpConfigDir()
    const sessionId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Finished exploring the repo\nagentId: ${agentId}`,
          }],
        },
        uuid: 'user-agent-result-without-usage',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Read the source' },
        uuid: 'subagent-user',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Found the service seam' }],
        },
        uuid: 'subagent-assistant',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result?.usage).toBeUndefined()
  })

  it('marks parent Agent tool errors as failed when no task notification overrides them', async () => {
    await setupTmpConfigDir()
    const sessionId = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: "Agent type 'general' not found",
            is_error: true,
          }],
        },
        uuid: 'user-agent-error-result',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({
      sessionId,
      toolUseId,
      status: 'failed',
      result: "Agent type 'general' not found",
      source: 'session-history',
    })
  })

  it('returns null when the parent Agent tool use is not present', async () => {
    await setupTmpConfigDir()
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-subagent-run', sessionId, [
      makeAgentToolResultEntry('tool-1', 'abc123'),
    ])

    await expect(getSubagentRunByTool(sessionId, 'tool-1')).resolves.toBeNull()
  })
})

describe('getSubagentRunByAgentId', () => {
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('reads a run that has no parent Agent tool call', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const projectDir = '-tmp-workflow-agent'
    const agentId = 'wfagent1'

    // A workflow agent is spawned by the workflow runtime, so the parent
    // session has no Agent tool_use to key off — only the transcript exists.
    await writeSessionFile(projectDir, sessionId, [])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Survey lib/response.js' },
        uuid: 'wf-user',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'res.send(403) sends a JSON body' }],
          usage: { input_tokens: 11, output_tokens: 7 },
        },
        uuid: 'wf-assistant',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
    ])

    const result = await getSubagentRunByAgentId(sessionId, agentId)

    expect(result).toMatchObject({ sessionId, agentId, source: 'subagent-jsonl' })
    expect(result?.messages.length).toBeGreaterThan(0)
    // A workflow agent answers once into its script; there is no inbox.
    expect(result?.canSendMessage).toBe(false)
  })

  it('returns workflow-agent task notifications beside its filtered transcript', async () => {
    await setupTmpConfigDir()
    const sessionId = '90909090-bbbb-cccc-dddd-ffffffffffff'
    const projectDir = '-tmp-workflow-agent'
    const agentId = 'wfagent2'

    await writeSessionFile(projectDir, sessionId, [])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'Waiting for the background check' },
        uuid: 'wf-assistant',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>wf-shell-task</task-id>\n<tool-use-id>wf-shell-tool</tool-use-id>\n<status>completed</status>\n<summary>Workflow check passed</summary>\n</task-notification>',
        },
        uuid: 'wf-notification',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'Internal notification response' },
        uuid: 'wf-notification-response',
        timestamp: '2026-01-01T00:00:07.000Z',
      },
    ])

    const result = await getSubagentRunByAgentId(sessionId, agentId)

    expect(result?.messages.map(message => message.id)).toEqual(['wf-assistant'])
    expect(result?.taskNotifications).toEqual([{
      taskId: 'wf-shell-task',
      toolUseId: 'wf-shell-tool',
      status: 'completed',
      summary: 'Workflow check passed',
      timestamp: '2026-01-01T00:00:06.000Z',
    }])
    expect(result?.updatedAt).toBe('2026-01-01T00:00:06.000Z')
  })

  it('returns null when no transcript exists for that agent', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000000'
    await writeSessionFile('-tmp-workflow-missing', sessionId, [])

    expect(await getSubagentRunByAgentId(sessionId, 'nope')).toBeNull()
  })
})
