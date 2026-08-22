import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../../Tool.js'
import { resetGitFileWatcher } from '../git/gitFilesystem.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { createWorkflowSharedCounters } from './harness.js'
import type {
  WorkflowAgentRunParams,
  WorkflowAgentRunResult,
} from './runWorkflowAgent.js'
import type { WorkflowAgentEvent, WorkflowProgressEvent } from './types.js'

const spawnedWorktreePaths: Array<string | undefined> = []
const runAgentMock = mock((params: { worktreePath?: string }) => {
  spawnedWorktreePaths.push(params.worktreePath)
  return (async function* () {})()
})
const runAgentModule = await import('../../tools/AgentTool/runAgent.js')
mock.module('../../tools/AgentTool/runAgent.js', () => ({
  // Preserve every sibling export: the worker tool pool pulls other symbols
  // out of this module while the agent definition is assembled.
  ...runAgentModule,
  runAgent: runAgentMock,
}))

const { runWorkflowAgent } = await import('./runWorkflowAgent.js')
const { executeWorkflowScript, prepareWorkflowScript } = await import(
  './runtime.js'
)

const SCRIPT = [
  "export const meta = { name: 'iso', description: 'isolation probe' }",
  "await agent('first', { isolation: 'worktree' })",
  "await agent('second', { isolation: 'worktree' })",
  "return 'done'",
].join('\n')

let tempDir: string
let savedCwdState: string
let savedOriginalCwd: string
let savedConfigDir: string | undefined

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
}

/** A repo with a local bare origin, so worktree creation never hits a network. */
function createRepo(): string {
  const repoDir = join(tempDir, 'repo')
  const originDir = join(tempDir, 'origin.git')
  mkdirSync(repoDir, { recursive: true })
  runGit(repoDir, ['init', '-b', 'main'])
  runGit(repoDir, ['config', 'user.email', 'workflow-test@example.com'])
  runGit(repoDir, ['config', 'user.name', 'Workflow Test'])
  writeFileSync(join(repoDir, 'README.md'), '# workflow isolation test\n')
  runGit(repoDir, ['add', '.'])
  runGit(repoDir, ['commit', '-m', 'initial'])
  runGit(tempDir, ['init', '--bare', originDir])
  runGit(originDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  runGit(repoDir, ['remote', 'add', 'origin', originDir])
  runGit(repoDir, ['push', '-u', 'origin', 'main'])
  return repoDir
}

function createPlainDir(): string {
  const plainDir = join(tempDir, 'stock')
  mkdirSync(plainDir, { recursive: true })
  return plainDir
}

function enterWorkspace(dir: string): void {
  setCwdState(dir)
  setOriginalCwd(dir)
  process.chdir(dir)
}

function context(): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: {
      tools: [],
      mainLoopModel: 'test-model',
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { tools: [] },
    }),
  } as unknown as ToolUseContext
}

const canUseTool = (() => {}) as unknown as CanUseToolFn

async function runScript(): Promise<{
  outcome: Awaited<ReturnType<typeof executeWorkflowScript>>
  events: WorkflowProgressEvent[]
}> {
  const prepared = prepareWorkflowScript(SCRIPT)
  if (!prepared.ok) throw new Error(prepared.error)
  const events: WorkflowProgressEvent[] = []
  let seq = 0
  const outcome = await executeWorkflowScript({
    vmScript: prepared.vmScript,
    toolUseContext: context(),
    canUseTool,
    runId: 'wf_isolatio-abc',
    shared: createWorkflowSharedCounters(),
    onProgress: event => events.push(event),
    onAgentController: () => {},
    runAgentImpl: async (
      params: WorkflowAgentRunParams,
    ): Promise<WorkflowAgentRunResult> => ({
      agentId: `a${++seq}`,
      value: `ran:${params.prompt}`,
      tokens: 1,
      toolCalls: 0,
    }),
    runNestedWorkflow: undefined,
  })
  return { outcome, events }
}

function agentEvents(events: WorkflowProgressEvent[]): WorkflowAgentEvent[] {
  return events.filter(
    (event): event is WorkflowAgentEvent => event.type === 'workflow_agent',
  )
}

function degradeLogs(events: WorkflowProgressEvent[]): string[] {
  return events
    .filter(event => event.type === 'workflow_log')
    .map(event => (event as { message: string }).message)
    .filter(message => message.includes('worktree isolation unavailable'))
}

async function runOneAgent(): Promise<WorkflowAgentRunResult> {
  return runWorkflowAgent({
    prompt: 'inspect the workspace',
    opts: { isolation: 'worktree' },
    toolUseContext: context(),
    canUseTool,
    runId: 'wf_isolatio-abc',
    abortController: new AbortController(),
    onAgentId: () => {},
    onProgress: () => {},
  })
}

describe('workflow agent worktree isolation', () => {
  beforeEach(() => {
    savedCwdState = getCwdState()
    savedOriginalCwd = getOriginalCwd()
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    spawnedWorktreePaths.length = 0

    tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-wf-isolation-'))
    // A real ~/.claude carrying a WorktreeCreate hook would make isolation
    // "available" everywhere and quietly invert the non-git expectations.
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-config')
    resetSettingsCache()
    resetGitFileWatcher()
  })

  afterEach(() => {
    process.chdir(savedOriginalCwd)
    setCwdState(savedCwdState)
    setOriginalCwd(savedOriginalCwd)
    resetGitFileWatcher()
    resetSettingsCache()
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('runs the agent in the workspace directory when there is no repository', async () => {
    enterWorkspace(createPlainDir())

    const result = await runOneAgent()

    expect(result.worktreePath).toBeUndefined()
    expect(spawnedWorktreePaths).toEqual([undefined])
  })

  test('still provisions a worktree when the workspace is a repository', async () => {
    const repoDir = createRepo()
    enterWorkspace(repoDir)

    const result = await runOneAgent()

    expect(result.worktreePath).toContain(
      join('.claude', 'worktrees', 'agent-'),
    )
    expect(spawnedWorktreePaths).toEqual([result.worktreePath])
  })

  test('a script asking for isolation completes and reports the degrade once', async () => {
    enterWorkspace(createPlainDir())

    const { outcome, events } = await runScript()

    expect(outcome.error).toBeUndefined()
    expect(outcome.result).toBe('done')
    expect(agentEvents(events).map(event => event.state)).toContain('done')
    // No isolation badge: the agents never got one.
    expect(agentEvents(events).some(event => event.isolation)).toBe(false)
    // Two agents asked, one explanation — not one line per agent.
    expect(degradeLogs(events)).toHaveLength(1)
    expect(degradeLogs(events)[0]).toContain('git init')
  })

  test('keeps the isolation badge and stays quiet inside a repository', async () => {
    enterWorkspace(createRepo())

    const { outcome, events } = await runScript()

    expect(outcome.error).toBeUndefined()
    expect(
      agentEvents(events).every(event => event.isolation === 'worktree'),
    ).toBe(true)
    expect(degradeLogs(events)).toHaveLength(0)
  })
})
