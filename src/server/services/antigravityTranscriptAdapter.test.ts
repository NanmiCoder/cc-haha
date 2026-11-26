import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  antigravityTranscriptPath,
  decodeAntigravityToolArgs,
  isSafeAntigravityId,
  parseAntigravityTranscriptContent,
  readAntigravityParentSubagentSpawns,
  readAntigravitySubagentRegistry,
  readAntigravityTranscript,
  resolveAntigravityAppDataDir,
} from './antigravityTranscriptAdapter.js'

const tempDirs: string[] = []
const originalEnvAppDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR

async function makeTempAppDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-transcript-adapter-test-'))
  tempDirs.push(dir)
  return dir
}

async function writeBrainFile(
  appDataDir: string,
  conversationId: string,
  relPath: string,
  content: string,
): Promise<string> {
  const fullPath = path.join(appDataDir, 'brain', conversationId, relPath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content, 'utf8')
  return fullPath
}

afterEach(async () => {
  if (originalEnvAppDataDir === undefined) {
    delete process.env.ANTIGRAVITY_APP_DATA_DIR
  } else {
    process.env.ANTIGRAVITY_APP_DATA_DIR = originalEnvAppDataDir
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** Golden lines captured from agy 1.5.17 Phase 0 probe (`research_child`). */
const RESEARCH_CHILD_LINES = [
  {
    step_index: 0,
    source: 'SYSTEM',
    type: 'SYSTEM_MESSAGE',
    status: 'DONE',
    created_at: '2026-11-26T09:33:33Z',
    content:
      'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T09:33:33Z sender=a8380e90-ddba-43f5-8e65-a0e2d0c0bc73 priority=MESSAGE_PRIORITY_HIGH content=Please list all files in /tmp/agy-p2-VDLzFK and report the filename(s) found.\n</SYSTEM_MESSAGE>',
  },
  {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-26T09:33:33Z',
    model: 'gemini-3.8-flash-low',
    input_tokens: 14134,
    cache_read_tokens: 0,
    output_tokens: 81,
    tool_calls: [
      {
        name: 'run_command',
        args: {
          CommandLine: '"ls -la /tmp/agy-p2-VDLzFK"',
          WaitMsBeforeAsync: '5000',
          toolSummary: '"List files in directory"',
        },
      },
    ],
  },
  {
    step_index: 2,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-11-26T09:33:37Z',
    content:
      'Created At: 2026-11-26T01:33:37-08:00\nCompleted At: 2026-11-26T01:33:38-08:00\nCommand exited with code 0.\n\nCommand output:\nhello.txt\n',
  },
  {
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-26T09:33:38Z',
    model: 'gemini-3.8-flash-low',
    input_tokens: 2310,
    cache_read_tokens: 12080,
    output_tokens: 112,
    tool_calls: [
      {
        name: 'send_message',
        args: {
          Message: '"In directory `/tmp/agy-p2-VDLzFK`, there is 1 file:\\n\\n- `hello.txt`"',
          Recipient: '"a8380e90-ddba-43f5-8e65-a0e2d0c0bc73"',
        },
      },
    ],
  },
  {
    step_index: 4,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-11-26T09:33:41Z',
    content: 'Message sent to "a8380e90-ddba-43f5-8e65-a0e2d0c0bc73".',
  },
]

describe('antigravityTranscriptAdapter', () => {
  it('resolves app data dir from override or env without mutating disk', async () => {
    const dir = await makeTempAppDataDir()
    expect(resolveAntigravityAppDataDir(dir)).toBe(path.resolve(dir))
    process.env.ANTIGRAVITY_APP_DATA_DIR = dir
    expect(resolveAntigravityAppDataDir()).toBe(path.resolve(dir))
    expect(isSafeAntigravityId('cbce3c87-0047-4ac1-83a6-683ca132ffcc')).toBe(true)
    expect(isSafeAntigravityId('../etc/passwd')).toBe(false)
    expect(antigravityTranscriptPath('../escape', dir)).toBeNull()
  })

  it('decodes JSON-encoded string values in tool_calls args', () => {
    expect(decodeAntigravityToolArgs({
      CommandLine: '"ls -la /tmp/demo"',
      WaitMsBeforeAsync: '5000',
      mentions_only: 'true',
      rawText: 'not-json',
    })).toEqual({
      CommandLine: 'ls -la /tmp/demo',
      WaitMsBeforeAsync: 5000,
      mentions_only: true,
      rawText: 'not-json',
    })
  })

  it('parses real Phase 0 subagent transcript into MessageEntry[] with usage, tool pairs, and finalResult', async () => {
    const appDataDir = await makeTempAppDataDir()
    const childId = 'cbce3c87-0047-4ac1-83a6-683ca132ffcc'
    await writeBrainFile(
      appDataDir,
      childId,
      '.system_generated/logs/transcript.jsonl',
      `${RESEARCH_CHILD_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )

    const result = await readAntigravityTranscript(childId, { appDataDir })
    expect(result).not.toBeNull()
    expect(result!.exists).toBe(true)
    expect(result!.status).toBe('completed')
    expect(result!.model).toBe('gemini-3.8-flash-low')
    expect(result!.effort).toBe('low')
    expect(result!.usage).toEqual({
      inputTokens: 16444,
      outputTokens: 193,
      cacheReadTokens: 12080,
      totalTokens: 16637,
    })
    expect(result!.finalResult).toBe('In directory `/tmp/agy-p2-VDLzFK`, there is 1 file:\n\n- `hello.txt`')
    expect(result!.skippedLines).toBe(0)
    expect(result!.historyComplete).toBe(true)
    expect(result!.messages).toHaveLength(5)

    // Step 0: SYSTEM_MESSAGE assignment becomes readable user prompt
    expect(result!.messages[0]!.type).toBe('user')
    expect(result!.messages[0]!.content).toBe(
      'Please list all files in /tmp/agy-p2-VDLzFK and report the filename(s) found.',
    )

    // Step 1 -> Step 2 tool_use / tool_result pairing
    const assistantStep = result!.messages[1]!
    expect(assistantStep.type).toBe('assistant')
    expect(assistantStep.model).toBe('gemini-3.8-flash-low')
    expect(assistantStep.usage).toEqual({
      input_tokens: 14134,
      output_tokens: 81,
      cache_read_input_tokens: 0,
    })
    const toolUseBlock = (assistantStep.content as Array<Record<string, unknown>>)[0]!
    expect(toolUseBlock.type).toBe('tool_use')
    expect(toolUseBlock.name).toBe('run_command')
    expect(toolUseBlock.input).toEqual({
      CommandLine: 'ls -la /tmp/agy-p2-VDLzFK',
      WaitMsBeforeAsync: 5000,
      toolSummary: 'List files in directory',
    })

    const toolResultStep = result!.messages[2]!
    expect(toolResultStep.type).toBe('tool_result')
    const toolResultBlock = (toolResultStep.content as Array<Record<string, unknown>>)[0]!
    expect(toolResultBlock.tool_use_id).toBe(toolUseBlock.id)
    expect(toolResultBlock.is_error).toBeUndefined()
  })

  it('handles thinking blocks, multi-tool calls, error results, and partial/corrupt JSONL lines gracefully', () => {
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T09:33:47Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T09:33:47Z sender=system priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1\n</SYSTEM_MESSAGE>',
      }),
      '{corrupt partial json without closing brace',
      '   ',
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T09:33:48Z',
        model: 'gemini-4-neon-high',
        thinking: 'Let me inspect and post.',
        content: 'Checking now.',
        input_tokens: 100,
        output_tokens: 20,
        tool_calls: [
          { name: 'read_file', args: { Path: '"/tmp/a.txt"' } },
          { name: 'run_command', args: { CommandLine: '"false"' } },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T09:33:49Z',
        content: 'file contents',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        created_at: '2026-11-26T09:33:50Z',
        content: 'Command exited with code 1.',
      }),
    ].join('\n')

    const parsed = parseAntigravityTranscriptContent('conv-multi', lines)
    expect(parsed.skippedLines).toBe(1)
    expect(parsed.status).toBe('failed')
    expect(parsed.effort).toBe('high')
    expect(parsed.messages[0]!.type).toBe('system')
    expect(parsed.messages[0]!.content).toBe('[swarm] new board message #1')

    const assistantBlocks = parsed.messages[1]!.content as Array<Record<string, unknown>>
    expect(assistantBlocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use'])
    const firstToolId = assistantBlocks[2]!.id
    const secondToolId = assistantBlocks[3]!.id

    const firstRes = (parsed.messages[2]!.content as Array<Record<string, unknown>>)[0]!
    expect(firstRes.tool_use_id).toBe(firstToolId)
    expect(firstRes.is_error).toBeUndefined()

    const secondRes = (parsed.messages[3]!.content as Array<Record<string, unknown>>)[0]!
    expect(secondRes.tool_use_id).toBe(secondToolId)
    expect(secondRes.is_error).toBe(true)
  })

  it('bounds large transcript files and marks historyComplete=false without failing', async () => {
    const appDataDir = await makeTempAppDataDir()
    const convId = 'large-conv-001'
    const entries = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({
        step_index: i,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: `2026-11-26T09:33:${String(i).padStart(2, '0')}Z`,
        model: 'gemini-3.8-flash-low',
        content: `Step ${i} ${'x'.repeat(200)}`,
        input_tokens: 10,
        output_tokens: 5,
      }),
    ).join('\n')
    await writeBrainFile(appDataDir, convId, '.system_generated/logs/transcript.jsonl', `${entries}\n`)

    const bounded = await readAntigravityTranscript(convId, { appDataDir, maxBytes: 1500 })
    expect(bounded).not.toBeNull()
    expect(bounded!.exists).toBe(true)
    expect(bounded!.truncated).toBe(true)
    expect(bounded!.historyComplete).toBe(false)
    expect(bounded!.messages.length).toBeGreaterThan(0)
    expect(bounded!.messages.length).toBeLessThan(40)
    // Latest step is preserved in tail slice
    expect(bounded!.messages.at(-1)!.id).toContain('step-39')
  })

  it('returns exists=false cleanly for missing transcripts', async () => {
    const appDataDir = await makeTempAppDataDir()
    const result = await readAntigravityTranscript('nonexistent-id', { appDataDir })
    expect(result).not.toBeNull()
    expect(result!.exists).toBe(false)
    expect(result!.messages).toEqual([])
    expect(result!.status).toBe('unknown')
  })

  it('reads parent subagent registry sorted by spawnStepIndex and parent transcript spawns', async () => {
    const appDataDir = await makeTempAppDataDir()
    const parentId = 'a8380e90-ddba-43f5-8e65-a0e2d0c0bc73'
    const child1 = 'cbce3c87-0047-4ac1-83a6-683ca132ffcc'
    const child2 = '358b978d-07df-4e32-9089-41f656e9afa6'

    await writeBrainFile(
      appDataDir,
      parentId,
      `.system_generated/subagents/${child2}.json`,
      JSON.stringify({
        conversationId: child2,
        subagentDescriptor: { typeName: 'shell_probe', role: 'Shell Executor' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 9,
        workspaceUris: ['file:///tmp/agy-p2-VDLzFK'],
      }),
    )
    await writeBrainFile(
      appDataDir,
      parentId,
      `.system_generated/subagents/${child1}.json`,
      JSON.stringify({
        conversationId: child1,
        subagentDescriptor: { typeName: 'research', role: 'list_file' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 2,
        workspaceUris: ['file:///tmp/agy-p2-VDLzFK'],
      }),
    )

    const registry = await readAntigravitySubagentRegistry(parentId, { appDataDir })
    expect(registry.map((r) => r.conversationId)).toEqual([child1, child2])
    expect(registry[0]!.typeName).toBe('research')
    expect(registry[0]!.role).toBe('list_file')
    expect(registry[1]!.typeName).toBe('shell_probe')

    // Also test parent transcript fallback spawn discovery
    const parentTranscript = [
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T09:33:33Z',
        tool_calls: [{
          name: 'invoke_subagent',
          args: {
            Prompt: '"List files"',
            Role: '"list_file"',
            TypeName: '"research"',
          },
        }],
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T09:33:34Z',
        content: JSON.stringify({
          conversationId: child1,
          logAbsoluteUri: `file:///tmp/brain/${child1}/.system_generated/logs/transcript.jsonl`,
        }),
      },
    ].map((e) => JSON.stringify(e)).join('\n')
    await writeBrainFile(appDataDir, parentId, '.system_generated/logs/transcript.jsonl', `${parentTranscript}\n`)

    const spawns = await readAntigravityParentSubagentSpawns(parentId, { appDataDir })
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({
      conversationId: child1,
      role: 'list_file',
      typeName: 'research',
      prompt: 'List files',
    })
  })
})
