import { expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { ToolUseContext } from '../../Tool.js'

const SUBJECTS = ['scaffold', 'data layer', '3d scene', 'glass ui', 'verify', 'polish']
const childScenario = process.env.CC_HAHA_TASK_CREATE_ORDER_SCENARIO

// Models assign follow-up TaskUpdate calls by the order they issued TaskCreate,
// so IDs from one parallel batch must follow tool_use order, not lock-race order.
async function runScenario(root: string) {
  ;(globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }).MACRO = { BUILD_TIME: '' }
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createAssistantMessage } = await import('../../utils/messages.js')
  const { getTaskPath } = await import('../../utils/tasks.js')
  const { runTools } = await import('../../services/tools/toolOrchestration.js')
  const { StreamingToolExecutor } = await import('../../services/tools/StreamingToolExecutor.js')
  const { TaskCreateTool } = await import('./TaskCreateTool.js')

  const toolUses = SUBJECTS.map((subject, index) => ({
    type: 'tool_use' as const,
    id: `create-${index}`,
    name: TaskCreateTool.name,
    input: { subject, description: `do ${subject}` },
  }))
  const assistant = createAssistantMessage({ content: toolUses })
  const canUseTool = mock(async (_tool: unknown, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }))
  const createContext = () => {
    let appState = getDefaultAppState()
    return {
      options: { tools: [TaskCreateTool], mcpClients: [], isNonInteractiveSession: true },
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
      if (block.type === 'tool_result') results.set(block.tool_use_id, String(block.content))
    }
  }

  // Both executors decide parallelism from isConcurrencySafe: runTools after
  // the response, StreamingToolExecutor as each tool_use block arrives.
  const executors = {
    runTools: async (results: Map<string, string>) => {
      for await (const update of runTools(toolUses, [assistant], canUseTool, createContext())) {
        collect(results, update)
      }
    },
    streaming: async (results: Map<string, string>) => {
      const executor = new StreamingToolExecutor([TaskCreateTool], canUseTool, createContext())
      for (const toolUse of toolUses) executor.addTool(toolUse, assistant)
      for await (const update of executor.getRemainingResults()) collect(results, update)
    },
  }

  for (const [executor, run] of Object.entries(executors)) {
    const taskListId = `task-create-order-${executor}`
    process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId
    const results = new Map<string, string>()
    await run(results)
    for (const [index, subject] of SUBJECTS.entries()) {
      const id = String(index + 1)
      expect(results.get(`create-${index}`), executor).toBe(`Task #${id} created successfully: ${subject}`)
      const stored = JSON.parse(await readFile(getTaskPath(taskListId, id), 'utf8'))
      expect(stored, executor).toMatchObject({ id, subject, status: 'pending' })
    }
  }
}

test('assigns parallel TaskCreate IDs in tool_use order', async () => {
  if (childScenario) {
    await runScenario(process.env.HOME!)
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'task-create-order-'))
  const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
    cwd: root,
    env: createSandboxedTestEnvironment(root, {
      CC_HAHA_TASK_CREATE_ORDER_SCENARIO: '1',
      NODE_ENV: 'production',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_API_KEY: 'offline-fixture-key',
    }),
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(exitCode, stdout + stderr).toBe(0)
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
