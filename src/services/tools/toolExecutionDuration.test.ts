import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { Tool, ToolUseContext } from '../../Tool.js'

const childScenario = process.env.CC_HAHA_TOOL_EXEC_DURATION_SCENARIO
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function runScenario(root: string) {
  ;(globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }).MACRO = { BUILD_TIME: '' }
  const { z } = await import('zod/v4')
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)

  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createAssistantMessage, createProgressMessage, normalizeMessages } = await import('../../utils/messages.js')
  const { normalizeMessage } = await import('../../utils/queryHelpers.js')
  const { toSDKMessages } = await import('../../utils/messages/mappers.js')
  const { extractAgentToolActivities } = await import('../../tools/AgentTool/agentToolUtils.js')
  const { StreamingToolExecutor } = await import('./StreamingToolExecutor.js')
  const { runToolUse } = await import('./toolExecution.js')

  const serialEditSchema = z.object({
    step: z.number(),
    shouldThrow: z.boolean().optional(),
    failValidation: z.boolean().optional(),
  })

  const SerialEditTool = {
    name: 'SerialEditFixture',
    inputSchema: serialEditSchema,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    isReadOnly: () => false,
    userFacingName: () => 'SerialEditFixture',
    async validateInput(input: z.infer<typeof serialEditSchema>) {
      if (input.failValidation) {
        await sleep(15)
        return { result: false as const, message: 'String to replace not found in file.' }
      }
      return { result: true as const }
    },
    async call(input: z.infer<typeof serialEditSchema>) {
      await sleep(45)
      if (input.shouldThrow) {
        throw new Error(`boom-${input.step}`)
      }
      return { data: `edited-${input.step}` }
    },
    mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: data,
      }
    },
  } as unknown as Tool

  const createContext = (tools: Tool[] = [SerialEditTool]) => {
    let appState = getDefaultAppState()
    return {
      options: { tools, mcpClients: [], isNonInteractiveSession: true },
      abortController: new AbortController(),
      messages: [],
      getAppState: () => appState,
      setAppState: (update: (prev: typeof appState) => typeof appState) => {
        appState = update(appState)
      },
      setInProgressToolUseIDs: () => {},
    } as unknown as ToolUseContext
  }

  // 1. Batch of 3 serial non-concurrency-safe tools queued together:
  //    each tool's durationMs reflects its own ~45ms execution, NOT cumulative queue wait (~90ms / ~135ms+).
  {
    const toolUses = [0, 1, 2].map(step => ({
      type: 'tool_use' as const,
      id: `serial-edit-${step}`,
      name: SerialEditTool.name,
      input: { step },
    }))
    const assistant = createAssistantMessage({ content: toolUses })
    const allowAll = mock(async (_tool: unknown, input: Record<string, unknown>) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    }))
    const executor = new StreamingToolExecutor([SerialEditTool], allowAll, createContext())
    const batchStart = Date.now()
    for (const toolUse of toolUses) {
      executor.addTool(toolUse, assistant)
    }
    const durations = new Map<string, number | undefined>()
    const userMessages = []
    for await (const update of executor.getRemainingResults()) {
      if (update.message?.type === 'user' && Array.isArray(update.message.message.content)) {
        userMessages.push(update.message)
        const block = update.message.message.content[0]
        if (block && 'type' in block && block.type === 'tool_result') {
          durations.set(block.tool_use_id, (update.message as { durationMs?: number }).durationMs)
        }
      }
    }
    const totalBatchMs = Date.now() - batchStart
    expect(totalBatchMs).toBeGreaterThanOrEqual(115)

    for (const step of [0, 1, 2]) {
      const id = `serial-edit-${step}`
      const durationMs = durations.get(id)
      expect(typeof durationMs, id).toBe('number')
      expect(durationMs!, id).toBeGreaterThanOrEqual(30)
      // Tool 2 waited behind tools 0 and 1 (>90ms queue wait), so its own durationMs
      // must be well below the cumulative batch wall clock.
      expect(durationMs!, id).toBeLessThan(totalBatchMs - 35)
    }

    // SDK normalization (top-level user, subagent progress user, mappers, background activity) forwards durationMs.
    const lastUserMsg = userMessages[2]!
    const [sdkTopLevel] = [...normalizeMessage(lastUserMsg)]
    expect(sdkTopLevel).toMatchObject({
      type: 'user',
      durationMs: durations.get('serial-edit-2'),
    })

    const subagentProgress = createProgressMessage({
      toolUseID: 'serial-edit-2',
      parentToolUseID: 'agent-parent-1',
      data: {
        type: 'agent_progress',
        prompt: 'edit files',
        agentId: 'agent-1' as never,
        message: lastUserMsg,
      } as never,
    })
    const [sdkSubagent] = [...normalizeMessage(subagentProgress)]
    expect(sdkSubagent).toMatchObject({
      type: 'user',
      parent_tool_use_id: 'agent-parent-1',
      durationMs: durations.get('serial-edit-2'),
    })

    const [mappedSdk] = toSDKMessages([lastUserMsg])
    expect(mappedSdk).toMatchObject({
      type: 'user',
      durationMs: durations.get('serial-edit-2'),
    })

    const [bgActivity] = extractAgentToolActivities(lastUserMsg)
    expect(bgActivity).toMatchObject({
      kind: 'tool_result',
      tool_use_id: 'serial-edit-2',
      duration_ms: durations.get('serial-edit-2'),
    })

    // Multi-block user message (tool_result + acceptFeedback text) keeps durationMs only on tool_result when split.
    const normalizedWithFeedback = normalizeMessages([
      {
        ...lastUserMsg,
        message: {
          role: 'user',
          content: [
            ...(lastUserMsg.message.content as never[]),
            { type: 'text', text: 'looks good' },
          ],
        },
      },
    ])
    expect(normalizedWithFeedback).toHaveLength(2)
    expect((normalizedWithFeedback[0] as { durationMs?: number }).durationMs).toBe(durations.get('serial-edit-2'))
    expect('durationMs' in normalizedWithFeedback[1]!).toBe(false)
  }

  // 2. Interactive permission wait + error path + validation failure + permission denial:
  {
    const slowApprove = mock(async (_tool: unknown, input: Record<string, unknown>) => {
      await sleep(70)
      return { behavior: 'allow' as const, updatedInput: input }
    })

    // Error thrown inside tool.call excludes the 70ms permission prompt wait.
    const errCall = {
      type: 'tool_use' as const,
      id: 'serial-err',
      name: SerialEditTool.name,
      input: { step: 9, shouldThrow: true },
    }
    const errAssistant = createAssistantMessage({ content: [errCall] })
    const errUpdates = []
    for await (const update of runToolUse(errCall, errAssistant, slowApprove, createContext())) {
      errUpdates.push(update)
    }
    const errMsg = errUpdates[0]!.message as { durationMs?: number }
    expect(typeof errMsg.durationMs).toBe('number')
    expect(errMsg.durationMs!).toBeGreaterThanOrEqual(30)
    expect(errMsg.durationMs!).toBeLessThan(95)

    // validateInput failure records actual validation time (~15ms), not undefined.
    const invalidCall = {
      type: 'tool_use' as const,
      id: 'serial-invalid',
      name: SerialEditTool.name,
      input: { step: 10, failValidation: true },
    }
    const invalidAssistant = createAssistantMessage({ content: [invalidCall] })
    const invalidUpdates = []
    for await (const update of runToolUse(invalidCall, invalidAssistant, slowApprove, createContext())) {
      invalidUpdates.push(update)
    }
    const invalidMsg = invalidUpdates[0]!.message as { durationMs?: number }
    expect(typeof invalidMsg.durationMs).toBe('number')
    expect(invalidMsg.durationMs!).toBeGreaterThanOrEqual(10)
    expect(invalidMsg.durationMs!).toBeLessThan(60)

    // Permission rejection after user dialog wait records 0ms execution time instead of dialog wait.
    const slowDeny = mock(async () => {
      await sleep(60)
      return { behavior: 'deny' as const, message: 'User rejected edit' }
    })
    const deniedCall = {
      type: 'tool_use' as const,
      id: 'serial-denied',
      name: SerialEditTool.name,
      input: { step: 11 },
    }
    const deniedAssistant = createAssistantMessage({ content: [deniedCall] })
    const deniedUpdates = []
    for await (const update of runToolUse(deniedCall, deniedAssistant, slowDeny, createContext())) {
      deniedUpdates.push(update)
    }
    const deniedMsg = deniedUpdates[0]!.message as { durationMs?: number }
    expect(deniedMsg.durationMs).toBe(0)

    // Unexpected pre-execution throw (e.g. permission callback throwing after wait) records 0ms instead of wait time.
    const slowThrow = mock(async () => {
      await sleep(60)
      throw new Error('permission check exploded')
    })
    const preExecErrCall = {
      type: 'tool_use' as const,
      id: 'serial-preexec-throw',
      name: SerialEditTool.name,
      input: { step: 12 },
    }
    const preExecErrAssistant = createAssistantMessage({ content: [preExecErrCall] })
    const preExecErrUpdates = []
    for await (const update of runToolUse(preExecErrCall, preExecErrAssistant, slowThrow, createContext())) {
      preExecErrUpdates.push(update)
    }
    const preExecErrMsg = preExecErrUpdates[0]!.message as { durationMs?: number }
    expect(preExecErrMsg.durationMs).toBe(0)
  }
}

test('records per-tool execution durationMs excluding serial queue and permission waits', async () => {
  if (childScenario) {
    await runScenario(process.env.HOME!)
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'tool-exec-duration-'))
  const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
    cwd: root,
    env: createSandboxedTestEnvironment(root, {
      CC_HAHA_TOOL_EXEC_DURATION_SCENARIO: '1',
      NODE_ENV: 'production',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_API_KEY: 'offline-fixture-key',
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, stdout + stderr).toBe(0)
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 25_000)
