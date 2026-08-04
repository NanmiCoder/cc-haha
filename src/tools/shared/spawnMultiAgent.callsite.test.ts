import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  CustomAgentDefinition,
  PluginAgentDefinition,
} from '../AgentTool/loadAgentsDir.js'

type SpawnMode = 'split-pane' | 'separate-window' | 'in-process'

let spawnMode: SpawnMode = 'split-pane'
const paneCommands: string[] = []
const tmuxCalls: string[][] = []
const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

const sendCommandToPaneMock = mock(
  async (_paneId: string, command: string) => {
    paneCommands.push(command)
  },
)
const execFileNoThrowMock = mock(
  async (_command: string, args: string[]) => {
    tmuxCalls.push(args)
    if (args[0] === 'new-window') {
      return { code: 0, stdout: '%window\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  },
)
const spawnInProcessTeammateMock = mock(async (_config: unknown) => ({
  success: true,
  agentId: 'worker@review-team',
  taskId: 'task-1',
  abortController: new AbortController(),
  teammateContext: { parentSessionId: 'parent-session' },
}))
const startInProcessTeammateMock = mock((_config: unknown) => {})
const execFileNoThrowModule = await import('../../utils/execFileNoThrow.js')
const taskFrameworkModule = await import('../../utils/task/framework.js')
const teamHelpersModule = await import('../../utils/swarm/teamHelpers.js')
const backendRegistryModule = await import('../../utils/swarm/backends/registry.js')
const backendDetectionModule = await import('../../utils/swarm/backends/detection.js')
const teammateLayoutModule = await import('../../utils/swarm/teammateLayoutManager.js')
const inProcessRunnerModule = await import('../../utils/swarm/inProcessRunner.js')
const spawnInProcessModule = await import('../../utils/swarm/spawnInProcess.js')
const teammateMailboxModule = await import('../../utils/teammateMailbox.js')
const mutateTeamFileAsyncActual = teamHelpersModule.mutateTeamFileAsync
const readTeamFileAsyncActual = teamHelpersModule.readTeamFileAsync

function installTestDoubles(): void {
  spyOn(backendRegistryModule, 'detectAndGetBackend').mockImplementation(async () => ({
    backend: { type: 'tmux' },
    needsIt2Setup: false,
  }) as any)
  spyOn(backendRegistryModule, 'getBackendByType').mockImplementation(() => ({ killPane: async () => {} }) as any)
  spyOn(backendRegistryModule, 'isInProcessEnabled').mockImplementation(() => spawnMode === 'in-process')
  spyOn(backendRegistryModule, 'markInProcessFallback').mockImplementation(() => {})
  spyOn(backendRegistryModule, 'resetBackendDetection').mockImplementation(() => {})

  spyOn(backendDetectionModule, 'isTmuxAvailable').mockImplementation(async () => true)

  spyOn(teammateLayoutModule, 'assignTeammateColor').mockImplementation(() => 'blue')
  spyOn(teammateLayoutModule, 'createTeammatePaneInSwarmView').mockImplementation(async () => ({
    paneId: '%split',
    isFirstTeammate: false,
  }) as any)
  spyOn(teammateLayoutModule, 'enablePaneBorderStatus').mockImplementation(async () => {})
  spyOn(teammateLayoutModule, 'isInsideTmux').mockImplementation(() => true)
  spyOn(teammateLayoutModule, 'sendCommandToPane').mockImplementation(sendCommandToPaneMock)

  spyOn(inProcessRunnerModule, 'startInProcessTeammate').mockImplementation(startInProcessTeammateMock as any)
  spyOn(spawnInProcessModule, 'spawnInProcessTeammate').mockImplementation(spawnInProcessTeammateMock as any)

  spyOn(teamHelpersModule, 'mutateTeamFileAsync').mockImplementation(async (
    teamName: string,
    mutate: (teamFile: { members: unknown[] }) => void,
  ) => {
    if (teamName !== 'review-team') {
      return mutateTeamFileAsyncActual(teamName, mutate)
    }
    mutate({ members: [] })
  })
  spyOn(teamHelpersModule, 'readTeamFileAsync').mockImplementation(async (teamName: string) =>
    teamName === 'review-team'
      ? null
      : readTeamFileAsyncActual(teamName))
  spyOn(teamHelpersModule, 'sanitizeAgentName').mockImplementation((name: string) => name.replaceAll('@', '-'))
  spyOn(teamHelpersModule, 'sanitizeName').mockImplementation((name: string) =>
  name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase())

  spyOn(taskFrameworkModule, 'registerTask').mockImplementation(() => {})
  spyOn(teammateMailboxModule, 'writeToMailbox').mockImplementation(async () => {})
  spyOn(execFileNoThrowModule, 'execFileNoThrow').mockImplementation(execFileNoThrowMock as any)
}

const { spawnTeammate } = await import('./spawnMultiAgent.js')

beforeEach(() => {
  installTestDoubles()
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  spawnMode = 'split-pane'
  paneCommands.length = 0
  tmuxCalls.length = 0
  sendCommandToPaneMock.mockClear()
  execFileNoThrowMock.mockClear()
  spawnInProcessTeammateMock.mockClear()
  startInProcessTeammateMock.mockClear()
})

afterEach(() => {
  mock.restore()
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
  }
})

describe('Agent Teams custom Agent runtime call sites', () => {
  test('split-pane command receives definition model, effort, and inherited thinking', async () => {
    const result = await spawnTeammate(
      makeConfig(true),
      makeContext(),
    )

    expect(result.data.model).toBe('gpt-5.6-luna')
    expect(sendCommandToPaneMock).toHaveBeenCalledTimes(1)
    expect(paneCommands[0]).toContain('--model gpt-5.6-luna')
    expect(paneCommands[0]).toContain('--effort xhigh')
    expect(paneCommands[0]).toContain('--thinking disabled')
  })

  test('separate-window command receives definition model, effort, and inherited thinking', async () => {
    spawnMode = 'separate-window'

    const result = await spawnTeammate(
      makeConfig(false),
      makeContext(),
    )

    const sendKeys = tmuxCalls.find(args => args[0] === 'send-keys')
    const command = sendKeys?.find(arg => arg.includes('CLAUDECODE=1'))
    expect(result.data.model).toBe('gpt-5.6-luna')
    expect(command).toContain('--model gpt-5.6-luna')
    expect(command).toContain('--effort xhigh')
    expect(command).toContain('--thinking disabled')
  })

  test('in-process runner receives the selected definition and inherited thinking', async () => {
    spawnMode = 'in-process'

    const result = await spawnTeammate(
      makeConfig(),
      makeContext(),
    )

    expect(result.data.model).toBe('gpt-5.6-luna')
    expect(spawnInProcessTeammateMock).toHaveBeenCalledTimes(1)
    expect(spawnInProcessTeammateMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.6-luna',
    })
    expect(startInProcessTeammateMock).toHaveBeenCalledTimes(1)
    const runnerConfig = startInProcessTeammateMock.mock.calls[0]?.[0] as {
      model?: string
      agentDefinition?: CustomAgentDefinition
      toolUseContext: ToolUseContext
    }
    expect(runnerConfig.model).toBe('gpt-5.6-luna')
    expect(runnerConfig.agentDefinition).toMatchObject({
      agentType: 'deep-reviewer',
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
    })
    expect(runnerConfig.toolUseContext.options.thinkingConfig).toEqual({
      type: 'disabled',
    })
  })

  test('in-process runner preserves a selected plugin Agent definition', async () => {
    spawnMode = 'in-process'
    const pluginAgent: PluginAgentDefinition = {
      agentType: 'plugin-reviewer',
      whenToUse: 'Review with the plugin',
      getSystemPrompt: () => 'Apply the plugin review policy.',
      source: 'plugin',
      plugin: 'review-suite',
      tools: ['Read'],
      model: 'opus',
      effort: 'max',
    }

    const result = await spawnTeammate(
      {
        name: 'plugin-worker',
        prompt: 'Review the change.',
        team_name: 'review-team',
        agent_type: 'plugin-reviewer',
      },
      makeContext(pluginAgent),
    )

    expect(result.data.model).toBe('opus')
    const runnerConfig = startInProcessTeammateMock.mock.calls[0]?.[0] as {
      agentDefinition?: PluginAgentDefinition
    }
    expect(runnerConfig.agentDefinition).toBe(pluginAgent)
    expect(runnerConfig.agentDefinition).toMatchObject({
      agentType: 'plugin-reviewer',
      source: 'plugin',
      plugin: 'review-suite',
      effort: 'max',
    })
  })
})

function makeConfig(useSplitPane?: boolean) {
  return {
    name: 'worker',
    prompt: 'Review the change.',
    team_name: 'review-team',
    agent_type: 'deep-reviewer',
    use_splitpane: useSplitPane,
  }
}

function makeContext(
  selectedAgentDefinition?: CustomAgentDefinition | PluginAgentDefinition,
): ToolUseContext {
  const agentDefinition =
    selectedAgentDefinition ??
    ({
      agentType: 'deep-reviewer',
      whenToUse: 'Review deeply',
      rawSystemPrompt: 'Review carefully.',
      getSystemPrompt: () => 'Review carefully.',
      source: 'projectSettings',
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
    } satisfies CustomAgentDefinition)
  let state = {
    mainLoopModel: 'claude-sonnet-4-6',
    effortValue: 'medium',
    toolPermissionContext: { mode: 'default' },
    teamContext: {
      teamName: 'review-team',
      teamFilePath: '',
      leadAgentId: 'team-lead@review-team',
      teammates: {},
    },
  } as unknown as AppState

  return {
    getAppState: () => state,
    setAppState: (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    },
    options: {
      agentDefinitions: {
        activeAgents: [agentDefinition],
        allAgents: [agentDefinition],
      },
      thinkingConfig: { type: 'disabled' },
    },
    messages: [],
  } as unknown as ToolUseContext
}
