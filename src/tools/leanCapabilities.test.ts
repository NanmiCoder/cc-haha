import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { ToolUseContext } from '../Tool.js'

const originalEnv = { ...process.env }
const sandbox = mkdtempSync(join(tmpdir(), 'lean-capabilities-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
  ANTHROPIC_API_KEY: 'offline-fixture-key',
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  CLAUDE_CODE_ENABLE_TASKS: '1',
}, originalEnv))
const { setAgentProfile } = await import('../utils/agentProfile.js')
const { getIsInteractive, getMainLoopModelOverride, setIsInteractive, setMainLoopModelOverride } = await import('../bootstrap/state.js')
const { getTools } = await import('../tools.js')
const { getEmptyToolPermissionContext } = await import('../Tool.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { TaskCreateTool } = await import('./TaskCreateTool/TaskCreateTool.js')
const { TaskGetTool } = await import('./TaskGetTool/TaskGetTool.js')
const { TaskUpdateTool } = await import('./TaskUpdateTool/TaskUpdateTool.js')
const { TaskListTool } = await import('./TaskListTool/TaskListTool.js')
const { TodoWriteTool } = await import('./TodoWriteTool/TodoWriteTool.js')
const { WebSearchTool } = await import('./WebSearchTool/WebSearchTool.js')
const { WebFetchTool } = await import('./WebFetchTool/WebFetchTool.js')
const { TaskOutputTool } = await import('./TaskOutputTool/TaskOutputTool.js')

const originalInteractive = getIsInteractive()
const originalModel = getMainLoopModelOverride()
setMainLoopModelOverride('deepseek-flash')
setIsInteractive(false)
afterEach(() => {
  setAgentProfile('standard')
  process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
})
afterAll(() => {
  setIsInteractive(originalInteractive)
  setMainLoopModelOverride(originalModel)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(sandbox, { recursive: true, force: true })
})

test('lean offers web and the desktop task lifecycle while respecting tool denies', () => {
  setAgentProfile('lean')
  const permissions = getEmptyToolPermissionContext()
  const offered = getTools(permissions).map(tool => tool.name)
  expect(offered).toEqual(expect.arrayContaining([
    'WebSearch', 'WebFetch', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
    'Agent', 'SendMessage', 'TaskOutput', 'TaskStop',
  ]))
  expect(offered).not.toContain('TodoWrite')
  expect(offered).not.toContain('TeamCreate')
  expect(offered).not.toContain('EnterPlanMode')
  permissions.alwaysDenyRules = { cliArg: ['WebSearch', 'WebFetch', 'TaskCreate', 'Agent'] }
  const denied = getTools(permissions).map(tool => tool.name)
  for (const name of permissions.alwaysDenyRules.cliArg) expect(denied).not.toContain(name)
  expect(denied).toContain('TaskList')
})

test('lean retains the legacy checklist only when the task v2 gate is off', () => {
  setAgentProfile('lean')
  delete process.env.CLAUDE_CODE_ENABLE_TASKS
  const names = getTools(getEmptyToolPermissionContext()).map(tool => tool.name)
  expect(names).toContain('TodoWrite')
  for (const name of ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) expect(names).not.toContain(name)
})

test('lean uses the real persisted task lifecycle and isolates subagent task lists', async () => {
  setAgentProfile('lean')
  let state = getDefaultAppState()
  const context = {
    options: { mainLoopModel: 'deepseek-flash' },
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (previous: typeof state) => typeof state) => { state = update(state) },
  } as unknown as ToolUseContext
  const created = await TaskCreateTool.call({ subject: 'Verify the change', description: 'Run the fixture checks' }, context)
  const taskId = created.data.task.id
  expect((await TaskGetTool.call({ taskId }, context)).data.task).toMatchObject({ status: 'pending', subject: 'Verify the change' })
  await TaskUpdateTool.call({ taskId, status: 'in_progress' }, context)
  expect((await TaskListTool.call({}, context)).data.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: taskId, status: 'in_progress' })]))
  const childContext = { ...context, agentId: 'lean-child-fixture' } as ToolUseContext
  await TaskCreateTool.call({ subject: 'Child investigation', description: 'Inspect a separate module' }, childContext)
  expect((await TaskListTool.call({}, context)).data.tasks.map(task => task.subject)).not.toContain('Child investigation')
  expect((await TaskListTool.call({}, childContext)).data.tasks.map(task => task.subject)).toEqual(['Child investigation'])
  await TaskUpdateTool.call({ taskId, status: 'completed' }, context)
  expect((await TaskGetTool.call({ taskId }, context)).data.task?.status).toBe('completed')
})

test('lean capability descriptions stay compact and preserve standard descriptions', async () => {
  const tools = [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool, TodoWriteTool, WebSearchTool, WebFetchTool, TaskOutputTool]
  const permissions = getEmptyToolPermissionContext()
  const options = { tools, agents: [], getToolPermissionContext: async () => permissions }
  setAgentProfile('standard')
  const standard = await Promise.all(tools.map(tool => tool.prompt(options)))
  setAgentProfile('lean')
  const lean = await Promise.all(tools.map(tool => tool.prompt(options)))
  for (const [index, text] of lean.entries()) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(550)
    expect(text.length).toBeLessThan(standard[index]!.length)
    expect(text).not.toMatch(/MCP|plan mode|teammates|\/tasks/)
  }
  expect(lean[0]).toContain('skip trivial tasks')
  expect(lean[2]).toContain('fully done and verified')
  expect(lean[5]).toContain('Cite relevant result URLs')
  expect(lean[6]).toContain('authenticated or private URLs')
  expect(lean[6]).toContain('redirect')
  expect(lean[7]).toContain('avoid repeated polling')
  setAgentProfile('standard')
  expect(await Promise.all(tools.map(tool => tool.prompt(options)))).toEqual(standard)
})

test('completed task results do not recommend an unavailable verification agent in lean', () => {
  const results = () => [
    TaskUpdateTool.mapToolResultToToolResultBlockParam({
      success: true, taskId: '1', updatedFields: ['status'], verificationNudgeNeeded: true,
    }, 'task-update'),
    TodoWriteTool.mapToolResultToToolResultBlockParam({
      oldTodos: [], newTodos: [], verificationNudgeNeeded: true,
    }, 'todo-update'),
  ]
  setAgentProfile('standard')
  for (const result of results()) expect(JSON.stringify(result)).toContain('spawn the verification agent')
  setAgentProfile('lean')
  for (const result of results()) expect(JSON.stringify(result)).not.toContain('spawn the verification agent')
})
