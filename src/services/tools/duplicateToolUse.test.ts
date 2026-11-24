import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'

const originalCwd = process.cwd()
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
}
let root = ''

afterAll(async () => {
  process.chdir(originalCwd)
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (root) await rm(root, { recursive: true, force: true })
})

/**
 * A degenerating model can repeat one tool call verbatim inside a single
 * assistant message (a 100k-token context produced three identical TeamPlan
 * submits). Only the first may run; every skipped call still needs its own
 * tool_result, otherwise the next API request fails the tool_use pairing.
 */
test('suppresses verbatim duplicate tool calls in one assistant message', async () => {
  root = await mkdtemp(join(tmpdir(), 'duplicate-tool-use-'))
  // Point every user-state path at the temp root before importing modules that
  // read config or transcript locations.
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
  process.chdir(root)
  ;(globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }).MACRO = { BUILD_TIME: '' }

  const { z } = await import('zod/v4')
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  const { buildTool } = await import('../../Tool.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createAssistantMessage } = await import('../../utils/messages.js')
  const { duplicateToolUseIds } = await import('./duplicateToolUse.js')
  const { runTools } = await import('./toolOrchestration.js')
  const { StreamingToolExecutor } = await import('./StreamingToolExecutor.js')

  const inputSchema = z.object({
    value: z.string(),
    extra: z.string().optional(),
  })

  function createEchoTool() {
    const state = { calls: 0 }
    const tool = buildTool({
      name: 'EchoTool',
      searchHint: 'echo test input',
      get inputSchema() { return inputSchema },
      async description() { return 'Echo test input' },
      async prompt() { return 'Pass a value to echo.' },
      isConcurrencySafe() { return true },
      async call(input) {
        state.calls += 1
        return { data: `echo:${input.value}` }
      },
      mapToolResultToToolResultBlockParam(data, toolUseID) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: [{ type: 'text' as const, text: String(data) }],
        }
      },
    })
    return { tool, state }
  }

  const blocks = [
    // Same input, different key order — still the same invocation.
    { type: 'tool_use' as const, id: 'call-a', name: 'EchoTool', input: { value: 'same', extra: 'x' } },
    { type: 'tool_use' as const, id: 'call-b', name: 'EchoTool', input: { extra: 'x', value: 'same' } },
    { type: 'tool_use' as const, id: 'call-c', name: 'EchoTool', input: { value: 'different' } },
  ]
  const assistant = createAssistantMessage({ content: blocks })

  expect([...duplicateToolUseIds(blocks)]).toEqual(['call-b'])
  // Nested values keep the canonical form stable too (array order matters).
  expect([...duplicateToolUseIds([
    { type: 'tool_use' as const, id: 'nested-a', name: 'EchoTool', input: { value: 'v', extra: ['a', 'b'] } },
    { type: 'tool_use' as const, id: 'nested-b', name: 'EchoTool', input: { extra: ['a', 'b'], value: 'v' } },
  ])]).toEqual(['nested-b'])

  const canUseTool = mock(async (_tool: unknown, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }))
  const createContext = (tool: unknown) => {
    let appState = getDefaultAppState()
    return {
      options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
      abortController: new AbortController(),
      messages: [],
      getAppState: () => appState,
      setAppState: (update: (prev: typeof appState) => typeof appState) => { appState = update(appState) },
      setInProgressToolUseIDs: () => {},
    } as unknown as ToolUseContext
  }
  type Update = { message?: { type: string; message?: { content?: unknown } } }
  const collect = (results: Map<string, string>, update: Update) => {
    const content = update.message?.type === 'user' ? update.message.message?.content : undefined
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const text = Array.isArray(block.content)
        ? block.content.map((part: { text?: string }) => part.text ?? '').join('')
        : String(block.content)
      results.set(block.tool_use_id, text)
    }
  }
  const expectResults = (results: Map<string, string>, calls: number) => {
    expect(calls).toBe(2)
    expect(results.get('call-a')).toContain('echo:same')
    expect(results.get('call-b')).toContain('Duplicate call skipped')
    expect(results.get('call-c')).toContain('echo:different')
  }

  // Non-streaming executor: dedupe runs before the batch is partitioned.
  {
    const { tool, state } = createEchoTool()
    const results = new Map<string, string>()
    for await (const update of runTools(blocks, [assistant], canUseTool, createContext(tool))) {
      collect(results, update)
    }
    expectResults(results, state.calls)
  }

  // Streaming executor: the repeat arrives while the first call is queued and
  // must complete immediately with a skip result instead of executing.
  {
    const { tool, state } = createEchoTool()
    const executor = new StreamingToolExecutor([tool], canUseTool, createContext(tool))
    for (const block of blocks) executor.addTool(block, assistant)
    const results = new Map<string, string>()
    for await (const update of executor.getRemainingResults()) {
      collect(results, update)
    }
    expectResults(results, state.calls)
  }
}, 20_000)
