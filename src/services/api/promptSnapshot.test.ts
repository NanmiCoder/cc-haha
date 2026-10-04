import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PROMPT_SNAPSHOT_MAX_BLOB_CHARS,
  flushPromptSnapshotWritesForTests,
  recordPromptSnapshot,
  recordUserContextSnapshot,
  resetPromptSnapshotStateForTests,
} from './promptSnapshot.js'

type SnapshotRecord = Record<string, unknown> & { t: string }

const ENV_KEYS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CC_HAHA_PROMPT_SNAPSHOT',
  'CLAUDE_CONFIG_DIR',
] as const

let tempDir: string
let snapshotPath: string
let savedEnv: Record<string, string | undefined>

function readRecords(path = snapshotPath): SnapshotRecord[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SnapshotRecord)
}

const readTool = {
  name: 'Read',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
}
const bashTool = {
  name: 'Bash',
  description: 'Run a command',
  input_schema: { type: 'object', properties: { command: { type: 'string' } } },
}

function baseArgs(overrides: Partial<Parameters<typeof recordPromptSnapshot>[0]> = {}) {
  return {
    systemPrompt: ['You are a helpful agent.', 'Be concise.'],
    // Fresh wrapper objects per call, like toolToAPISchema returns, sharing
    // the cached input_schema objects.
    tools: [{ ...readTool, defer_loading: false }, { ...bashTool }],
    model: 'test-model',
    querySource: 'repl_main_thread',
    ...overrides,
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  tempDir = mkdtempSync(join(tmpdir(), 'prompt-snapshot-test-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
  delete process.env.CC_HAHA_PROMPT_SNAPSHOT
  snapshotPath = join(tempDir, 'project', 'session-1', 'prompt-snapshots.jsonl')
  resetPromptSnapshotStateForTests({ resolvePath: () => snapshotPath })
})

afterEach(async () => {
  await flushPromptSnapshotWritesForTests()
  resetPromptSnapshotStateForTests()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('promptSnapshot gating', () => {
  test('writes nothing outside the desktop entrypoint', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    recordPromptSnapshot(baseArgs())
    recordUserContextSnapshot({ userContext: { currentDate: 'today' } })
    await flushPromptSnapshotWritesForTests()
    expect(existsSync(snapshotPath)).toBe(false)
  })

  test.each(['0', 'false', 'OFF'])(
    'escape hatch CC_HAHA_PROMPT_SNAPSHOT=%s writes nothing',
    async value => {
      process.env.CC_HAHA_PROMPT_SNAPSHOT = value
      recordPromptSnapshot(baseArgs())
      recordUserContextSnapshot({ userContext: { currentDate: 'today' } })
      await flushPromptSnapshotWritesForTests()
      expect(existsSync(snapshotPath)).toBe(false)
    },
  )

  test('the default path helper lives in the session directory', async () => {
    const { getPromptSnapshotPath } = await import('../../utils/sessionStorage.js')
    const { getSessionId } = await import('../../bootstrap/state.js')
    const path = getPromptSnapshotPath()
    expect(path.endsWith(join(getSessionId(), 'prompt-snapshots.jsonl'))).toBe(true)
  })
})

describe('recordPromptSnapshot', () => {
  test('first call writes sys and tools blobs before the req marker', async () => {
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()

    const records = readRecords()
    expect(records.map(r => [r.t, r.k ?? null])).toEqual([
      ['blob', 'sys'],
      ['blob', 'tools'],
      ['req', null],
    ])
    const [sys, tools, req] = records as [SnapshotRecord, SnapshotRecord, SnapshotRecord]
    expect(sys.text).toBe('You are a helpful agent.\n\nBe concise.')
    expect(sys.h).toMatch(/^[0-9a-f]{16}$/)
    expect(sys.truncated).toBeUndefined()
    expect(tools.json).toEqual([readTool, bashTool])
    expect(req).toMatchObject({
      scope: 'main',
      sys: sys.h,
      tools: tools.h,
      qs: 'repl_main_thread',
      model: 'test-model',
      toolCount: 2,
      sysChars: 'You are a helpful agent.\n\nBe concise.'.length,
    })
    expect(typeof req.ts).toBe('string')
  })

  test('an identical second call writes nothing', async () => {
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()
    const before = readFileSync(snapshotPath, 'utf8')

    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()
    expect(readFileSync(snapshotPath, 'utf8')).toBe(before)
  })

  test('a changed system prompt writes one new sys blob and a marker, not the tools blob', async () => {
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()
    const firstCount = readRecords().length

    recordPromptSnapshot(baseArgs({ systemPrompt: ['Different prompt.'] }))
    await flushPromptSnapshotWritesForTests()

    const added = readRecords().slice(firstCount)
    expect(added.map(r => [r.t, r.k ?? null])).toEqual([
      ['blob', 'sys'],
      ['req', null],
    ])
    const toolsBlob = readRecords().find(r => r.k === 'tools')!
    expect(added[1]!.tools).toBe(toolsBlob.h)
    expect(added[1]!.sys).toBe(added[0]!.h)
  })

  test('a changed tool description changes the tools hash', async () => {
    recordPromptSnapshot(baseArgs())
    recordPromptSnapshot(
      baseArgs({ tools: [{ ...readTool, description: 'Read a file (v2)' }, { ...bashTool }] }),
    )
    await flushPromptSnapshotWritesForTests()
    const toolBlobs = readRecords().filter(r => r.k === 'tools')
    expect(toolBlobs).toHaveLength(2)
    expect(toolBlobs[0]!.h).not.toBe(toolBlobs[1]!.h)
  })

  test('a changed querySource or model writes only a new marker', async () => {
    recordPromptSnapshot(baseArgs())
    recordPromptSnapshot(baseArgs({ querySource: 'compact' }))
    recordPromptSnapshot(baseArgs({ querySource: 'compact', model: 'other-model' }))
    await flushPromptSnapshotWritesForTests()
    const records = readRecords()
    expect(records.filter(r => r.t === 'blob')).toHaveLength(2)
    expect(records.filter(r => r.t === 'req').map(r => [r.qs, r.model])).toEqual([
      ['repl_main_thread', 'test-model'],
      ['compact', 'test-model'],
      ['compact', 'other-model'],
    ])
  })

  test('an agent scope gets its own marker but reuses existing blobs', async () => {
    recordPromptSnapshot(baseArgs())
    recordPromptSnapshot(baseArgs({ agentId: 'a1b2c3', querySource: 'repl_main_thread' }))
    recordPromptSnapshot(baseArgs({ agentId: 'a1b2c3', querySource: 'repl_main_thread' }))
    await flushPromptSnapshotWritesForTests()

    const records = readRecords()
    expect(records.filter(r => r.t === 'blob')).toHaveLength(2)
    const markers = records.filter(r => r.t === 'req')
    expect(markers.map(r => r.scope)).toEqual(['main', 'a1b2c3'])
    expect(markers[1]!.sys).toBe(markers[0]!.sys)
    expect(markers[1]!.tools).toBe(markers[0]!.tools)
  })

  test('a new session file gets its own blobs and marker', async () => {
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()

    const secondPath = join(tempDir, 'project', 'session-2', 'prompt-snapshots.jsonl')
    snapshotPath = secondPath
    // The resolver closes over the variable, so it now points at session-2.
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()
    expect(readRecords(secondPath).map(r => r.t)).toEqual(['blob', 'blob', 'req'])
  })

  test('oversized system prompt is truncated and flagged', async () => {
    const huge = 'x'.repeat(PROMPT_SNAPSHOT_MAX_BLOB_CHARS + 500)
    recordPromptSnapshot(baseArgs({ systemPrompt: [huge] }))
    await flushPromptSnapshotWritesForTests()
    const sys = readRecords().find(r => r.k === 'sys')!
    expect(sys.truncated).toBe(true)
    expect((sys.text as string).length).toBe(PROMPT_SNAPSHOT_MAX_BLOB_CHARS)
    const req = readRecords().find(r => r.t === 'req')!
    expect(req.sysChars).toBe(huge.length)
  })

  test('oversized tool catalog drops the largest input_schema first and stays valid JSON', async () => {
    const bigSchema = {
      type: 'object',
      description: 'y'.repeat(PROMPT_SNAPSHOT_MAX_BLOB_CHARS),
    }
    const bigTool = { name: 'Big', description: 'big tool', input_schema: bigSchema }
    recordPromptSnapshot(baseArgs({ tools: [{ ...readTool }, bigTool] }))
    await flushPromptSnapshotWritesForTests()
    const tools = readRecords().find(r => r.k === 'tools')!
    expect(tools.truncated).toBe(true)
    expect(tools.json).toEqual([readTool, { name: 'Big', description: 'big tool' }])
    const req = readRecords().find(r => r.t === 'req')!
    expect(req.toolCount).toBe(2)
  })

  test('small payloads are not flagged as truncated', async () => {
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()
    expect(readRecords().filter(r => r.truncated !== undefined)).toEqual([])
  })
})

describe('recordUserContextSnapshot', () => {
  test('writes a ctx blob and marker, deduped per scope', async () => {
    const userContext = { currentDate: '2026-10-04', claudeMd: '# Rules' }
    recordUserContextSnapshot({ userContext })
    recordUserContextSnapshot({ userContext: { claudeMd: '# Rules', currentDate: '2026-10-04' } })
    recordUserContextSnapshot({ userContext, agentId: 'agent-x' })
    recordUserContextSnapshot({ userContext: { ...userContext, currentDate: '2026-10-05' } })
    await flushPromptSnapshotWritesForTests()

    const records = readRecords()
    const blobs = records.filter(r => r.t === 'blob')
    expect(blobs).toHaveLength(2)
    expect(blobs[0]!.k).toBe('ctx')
    expect(blobs[0]!.json).toEqual({ claudeMd: '# Rules', currentDate: '2026-10-04' })
    const markers = records.filter(r => r.t === 'ctx')
    expect(markers.map(r => [r.scope, r.ctx])).toEqual([
      ['main', blobs[0]!.h],
      ['agent-x', blobs[0]!.h],
      ['main', blobs[1]!.h],
    ])
    // Every marker comes after the blob it references.
    for (const marker of markers) {
      const blobIndex = records.findIndex(r => r.t === 'blob' && r.h === marker.ctx)
      expect(blobIndex).toBeLessThan(records.indexOf(marker))
    }
  })

  test('oversized context values are truncated and flagged', async () => {
    const big = 'z'.repeat(PROMPT_SNAPSHOT_MAX_BLOB_CHARS + 100)
    recordUserContextSnapshot({ userContext: { claudeMd: big, currentDate: 'today' } })
    await flushPromptSnapshotWritesForTests()
    const blob = readRecords().find(r => r.k === 'ctx')!
    expect(blob.truncated).toBe(true)
    const json = blob.json as Record<string, string>
    expect(json.currentDate).toBe('today')
    expect(json.claudeMd!.length).toBeLessThan(big.length)
  })
})

describe('write failures', () => {
  test('an unwritable directory never throws and disables after 3 failures', async () => {
    const blocker = join(tempDir, 'not-a-dir')
    writeFileSync(blocker, 'file')
    const badPath = join(blocker, 'session', 'prompt-snapshots.jsonl')
    resetPromptSnapshotStateForTests({ resolvePath: () => snapshotPath })
    snapshotPath = badPath

    for (let i = 0; i < 3; i++) {
      expect(() =>
        recordPromptSnapshot(baseArgs({ systemPrompt: [`prompt ${i}`] })),
      ).not.toThrow()
    }
    await flushPromptSnapshotWritesForTests()

    // Disabled now: even a writable path receives nothing.
    const goodPath = join(tempDir, 'project', 'session-ok', 'prompt-snapshots.jsonl')
    snapshotPath = goodPath
    recordPromptSnapshot(baseArgs({ systemPrompt: ['after disable'] }))
    recordUserContextSnapshot({ userContext: { currentDate: 'today' } })
    await flushPromptSnapshotWritesForTests()
    expect(existsSync(goodPath)).toBe(false)
  })

  test('a single failure rolls back dedup so the next call rewrites blobs and marker', async () => {
    const blocker = join(tempDir, 'blocker')
    writeFileSync(blocker, 'file')
    snapshotPath = join(blocker, 'prompt-snapshots.jsonl')
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()

    rmSync(blocker)
    recordPromptSnapshot(baseArgs())
    await flushPromptSnapshotWritesForTests()
    expect(readRecords().map(r => r.t)).toEqual(['blob', 'blob', 'req'])
  })
})

describe('claude.ts call site', () => {
  const CALL_SITE_ENV_KEYS = [
    'NODE_ENV',
    'HOME',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
  ] as const

  function sse(name: string, data: unknown): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  }

  function okStream(model: string): string {
    return [
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_prompt_snapshot',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
  }

  test('records the system prompt and tools actually sent to the API', async () => {
    const { queryModelWithStreaming } = await import('./claude.js')
    const { createUserMessage } = await import('../../utils/messages.js')
    const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
    const { getEmptyToolPermissionContext } = await import('../../Tool.js')
    const { enableConfigs } = await import('../../utils/config.js')
    const { getIsInteractive, setIsInteractive } = await import('../../bootstrap/state.js')

    const model = 'snapshot-fixture-model'
    const requests: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>)
        return new Response(okStream(model), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const originalEnv = Object.fromEntries(
      CALL_SITE_ENV_KEYS.map(key => [key, process.env[key]]),
    )
    const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
    const originalMacro = globals.MACRO
    const originalIsInteractive = getIsInteractive()
    const fixtureTool = {
      name: 'FixtureTool',
      description: 'A fixture tool',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }

    try {
      globals.MACRO = { BUILD_TIME: '' }
      setIsInteractive(false)
      process.env.NODE_ENV = 'production'
      process.env.HOME = join(tempDir, 'home')
      delete process.env.CLAUDE_CODE_USE_BEDROCK
      delete process.env.CLAUDE_CODE_USE_VERTEX
      delete process.env.CLAUDE_CODE_USE_FOUNDRY
      delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
      delete process.env.ANTHROPIC_AUTH_TOKEN
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
      process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
      process.env.ANTHROPIC_MODEL = model
      enableConfigs()

      for await (const _ of queryModelWithStreaming({
        messages: [createUserMessage({ content: 'Reply exactly OK' })],
        systemPrompt: asSystemPrompt(['Fixture system prompt.']),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          model,
          querySource: 'insights',
          agents: [],
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          mcpTools: [],
          enablePromptCaching: false,
          extraToolSchemas: [fixtureTool as never],
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        },
      })) {
        // drain the stream
      }
      await flushPromptSnapshotWritesForTests()
    } finally {
      for (const key of CALL_SITE_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key]
        else process.env[key] = originalEnv[key]
      }
      if (originalMacro === undefined) delete globals.MACRO
      else globals.MACRO = originalMacro
      setIsInteractive(originalIsInteractive)
      server.stop(true)
    }

    expect(requests).toHaveLength(1)
    const records = readRecords()
    const sys = records.find(r => r.k === 'sys')!
    const tools = records.find(r => r.k === 'tools')!
    const req = records.find(r => r.t === 'req')!
    expect(req).toMatchObject({ scope: 'main', qs: 'insights', model, toolCount: 1 })

    const sentSystem = requests[0]!.system as Array<{ text: string }>
    expect(sys.text).toContain('Fixture system prompt.')
    // The attribution header's cch= checksum is filled in at send time; the
    // snapshot keeps the stable placeholder.
    for (const block of sentSystem) {
      expect(sys.text as string).toContain(block.text.replace(/cch=[0-9a-f]+;/, 'cch=00000;'))
    }

    const sentTools = requests[0]!.tools as Array<Record<string, unknown>>
    expect(tools.json).toEqual(
      sentTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    )
  }, 15_000)
})
