import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { resetGitFileWatcher } from '../../utils/git/gitFilesystem.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  getTeamFilePath,
  mutateTeamFileAsync,
  readTeamFile,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import * as agentToolUtils from './agentToolUtils.js'
import { AgentTool, assertAgentTeamExists, inputSchema } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import * as runAgentModule from './runAgent.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir = ''

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-agent-team-preflight-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  mock.restore()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  await rm(configDir, { recursive: true, force: true })
})

describe('AgentTool model schema', () => {
  test('accepts the official fable model alias', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review model routing',
        prompt: 'Inspect the agent model selection path.',
        model: 'fable',
      }).success,
    ).toBe(true)
  })

  test('continues to reject unsupported per-call model values', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review model routing',
        prompt: 'Inspect the agent model selection path.',
        model: 'mythos',
      }).success,
    ).toBe(false)
  })

  test('rejects a missing team before spawning any teammate', () => {
    expect(() => assertAgentTeamExists('missing-team', null)).toThrow(
      'omit team_name to launch an ordinary subagent',
    )
  })

  test('accepts an empty team name for optional-field compatibility', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review retry behavior',
        prompt: 'Inspect the retry boundary.',
        team_name: '',
      }).success,
    ).toBe(true)
  })

  test('accepts an initialized team file', () => {
    expect(() => assertAgentTeamExists('existing-team', {
      name: 'existing-team',
      createdAt: 1,
      leadAgentId: 'team-lead@existing-team',
      members: [],
    })).not.toThrow()
  })
})

describe('AgentTool team spawn preflight', () => {
  test('rejects a missing team without leaving a phantom config', async () => {
    await expect(mutateTeamFileAsync('missing-team', () => {})).rejects.toThrow(
      'Team "missing-team" does not exist',
    )

    expect(existsSync(getTeamFilePath('missing-team'))).toBe(false)
  })

  test('treats malformed team state as missing', async () => {
    const teamFilePath = getTeamFilePath('malformed-team')
    await mkdir(dirname(teamFilePath), { recursive: true })
    await writeFile(teamFilePath, '{}')

    expect(readTeamFile('malformed-team')).toBeNull()
    await expect(mutateTeamFileAsync('malformed-team', () => {})).rejects.toThrow(
      'Team "malformed-team" does not exist',
    )
  })

  test('updates an initialized team under the file lock', async () => {
    const teamFilePath = getTeamFilePath('ready-team')
    const teamFile: TeamFile = {
      name: 'ready-team',
      createdAt: Date.now(),
      leadAgentId: 'lead@ready-team',
      members: [],
    }
    await mkdir(dirname(teamFilePath), { recursive: true })
    await writeFile(teamFilePath, JSON.stringify(teamFile))

    const updated = await mutateTeamFileAsync('ready-team', current => {
      current.description = 'updated'
    })

    expect(updated.description).toBe('updated')
    expect(JSON.parse(await readFile(teamFilePath, 'utf-8')).description).toBe(
      'updated',
    )
  })
})

describe('AgentTool nested lifecycle ownership', () => {
  test('threads the immediate parent through registration, execution, and persistence', async () => {
    const appState = {
      ...getDefaultAppState(),
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT],
        allAgents: [GENERAL_PURPOSE_AGENT],
      },
    }
    const toolUseContext = {
      options: {
        mainLoopModel: 'sonnet',
        tools: [],
        mcpClients: [],
        agentDefinitions: appState.agentDefinitions,
      },
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
      agentId: 'parent-agent-run',
      toolUseId: 'toolu_parent_agent',
    } as unknown as ToolUseContext
    const taskAbortController = new AbortController()
    const registerSpy = spyOn(localAgentTask, 'registerAsyncAgent').mockReturnValue({
      agentId: 'nested-agent-run',
      abortController: taskAbortController,
    } as never)
    let lifecycleParams: Parameters<typeof agentToolUtils.runAsyncAgentLifecycle>[0] | undefined
    const lifecycleSpy = spyOn(agentToolUtils, 'runAsyncAgentLifecycle').mockImplementation(
      async params => {
        lifecycleParams = params
      },
    )
    const runAgentSpy = spyOn(runAgentModule, 'runAgent').mockImplementation(
      (async function* () {}) as typeof runAgentModule.runAgent,
    )

    const result = await AgentTool.call(
      {
        description: 'Verify owner propagation',
        prompt: 'Check every nested lifecycle boundary.',
        subagent_type: GENERAL_PURPOSE_AGENT.agentType,
        run_in_background: true,
      },
      toolUseContext,
      (async () => ({ behavior: 'allow' })) as never,
      createAssistantMessage({ content: 'Launch the nested agent.' }),
    )

    expect(result.data).toMatchObject({
      isAsync: true,
      agentId: 'nested-agent-run',
    })
    expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: 'toolu_parent_agent',
      ownerAgentId: 'parent-agent-run',
    }))
    expect(lifecycleSpy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'nested-agent-run',
      parentToolUseId: 'toolu_parent_agent',
      ownerAgentId: 'parent-agent-run',
    }))

    lifecycleParams?.makeStream(() => {})
    expect(runAgentSpy).toHaveBeenCalledWith(expect.objectContaining({
      spawningToolUseId: 'toolu_parent_agent',
      ownerAgentId: 'parent-agent-run',
    }))
  })
})

describe('AgentTool worktree isolation', () => {
  let workspaceRoot = ''
  let savedCwdState = ''
  let savedOriginalCwd = ''

  beforeEach(async () => {
    savedCwdState = getCwdState()
    savedOriginalCwd = getOriginalCwd()
    workspaceRoot = await mkdtemp(join(tmpdir(), 'cc-haha-agent-isolation-'))
    resetSettingsCache()
    resetGitFileWatcher()
  })

  afterEach(async () => {
    process.chdir(savedOriginalCwd)
    setCwdState(savedCwdState)
    setOriginalCwd(savedOriginalCwd)
    resetGitFileWatcher()
    resetSettingsCache()
    await rm(workspaceRoot, { recursive: true, force: true })
  })

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

  function enterWorkspace(dir: string): void {
    setCwdState(dir)
    setOriginalCwd(dir)
    process.chdir(dir)
  }

  /** Spawn a background agent that asks for worktree isolation. */
  async function spawnIsolatedAgent(): Promise<{
    data: Record<string, unknown>
    runAgentSpy: ReturnType<typeof spyOn<typeof runAgentModule, 'runAgent'>>
    makeStream: () => void
  }> {
    const appState = {
      ...getDefaultAppState(),
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT],
        allAgents: [GENERAL_PURPOSE_AGENT],
      },
    }
    const toolUseContext = {
      options: {
        mainLoopModel: 'sonnet',
        tools: [],
        mcpClients: [],
        agentDefinitions: appState.agentDefinitions,
      },
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
      toolUseId: 'toolu_isolated_agent',
    } as unknown as ToolUseContext
    spyOn(localAgentTask, 'registerAsyncAgent').mockReturnValue({
      agentId: 'isolated-agent-run',
      abortController: new AbortController(),
    } as never)
    let lifecycleParams:
      | Parameters<typeof agentToolUtils.runAsyncAgentLifecycle>[0]
      | undefined
    spyOn(agentToolUtils, 'runAsyncAgentLifecycle').mockImplementation(
      async params => {
        lifecycleParams = params
      },
    )
    const runAgentSpy = spyOn(runAgentModule, 'runAgent').mockImplementation(
      (async function* () {}) as typeof runAgentModule.runAgent,
    )

    const result = await AgentTool.call(
      {
        description: 'Isolated worker',
        prompt: 'Mutate files without touching the parent workspace.',
        subagent_type: GENERAL_PURPOSE_AGENT.agentType,
        run_in_background: true,
        isolation: 'worktree',
      },
      toolUseContext,
      (async () => ({ behavior: 'allow' })) as never,
      createAssistantMessage({ content: 'Launch the isolated agent.' }),
    )

    return {
      data: result.data as Record<string, unknown>,
      runAgentSpy,
      makeStream: () => lifecycleParams?.makeStream(() => {}),
    }
  }

  test('launches the agent in a plain directory and reports the skipped isolation', async () => {
    enterWorkspace(workspaceRoot)

    const { data, runAgentSpy, makeStream } = await spawnIsolatedAgent()

    expect(data.status).toBe('async_launched')
    expect(String(data.worktreeIsolationSkipped)).toContain(
      'not a git repository',
    )
    makeStream()
    expect(runAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: undefined }),
    )

    const rendered = AgentTool.mapToolResultToToolResultBlockParam(
      data as never,
      'toolu_isolated_agent',
    )
    expect(JSON.stringify(rendered)).toContain('worktree isolation was skipped')
  })

  test('still isolates the agent when the workspace is a repository', async () => {
    const repoDir = join(workspaceRoot, 'repo')
    await mkdir(repoDir, { recursive: true })
    runGit(repoDir, ['init', '-b', 'main'])
    runGit(repoDir, ['config', 'user.email', 'agent-test@example.com'])
    runGit(repoDir, ['config', 'user.name', 'Agent Test'])
    await writeFile(join(repoDir, 'README.md'), '# agent isolation test\n')
    runGit(repoDir, ['add', '.'])
    runGit(repoDir, ['commit', '-m', 'initial'])
    enterWorkspace(repoDir)

    const { data, runAgentSpy, makeStream } = await spawnIsolatedAgent()

    expect(data.worktreeIsolationSkipped).toBeUndefined()
    makeStream()
    expect(runAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: expect.stringContaining(
          join('.claude', 'worktrees', 'agent-'),
        ),
      }),
    )
  })
})
