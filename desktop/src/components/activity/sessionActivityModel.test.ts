import { describe, expect, it } from 'vitest'
import {
  buildMainSessionActivityModel,
  buildSessionActivityModel,
  getMainSessionActivityModel,
  getVisibleActivitySections,
  hasVisibleSessionActivity,
} from './sessionActivityModel'
import { createBackgroundTaskDismissKey } from '../../lib/backgroundTasks'
import type { BackgroundAgentTask, AgentTaskNotification, UIMessage } from '../../types/chat'
import type { CLITask } from '../../types/cliTask'
import type { WorkflowRun } from '../../types/workflow'

const task = (overrides: Partial<CLITask>): CLITask => ({
  id: 'task-1',
  subject: 'Write tests',
  description: '',
  status: 'pending',
  blocks: [],
  blockedBy: [],
  taskListId: 'session-1',
  ...overrides,
})

const background = (overrides: Partial<BackgroundAgentTask>): BackgroundAgentTask => ({
  taskId: 'bg-1',
  toolUseId: 'tool-1',
  status: 'running',
  description: 'Explore code',
  taskType: 'local_agent',
  startedAt: 1000,
  updatedAt: 2000,
  ...overrides,
})

const notification = (overrides: Partial<AgentTaskNotification>): AgentTaskNotification => ({
  taskId: 'agent-task-1',
  toolUseId: 'tool-1',
  status: 'completed',
  summary: 'Done',
  timestamp: '2026-07-03T00:00:00.000Z',
  ...overrides,
})

const successfulTaskUpdateResult = (
  toolUseId: string,
  taskId: string,
  timestamp: number,
  updatedFields = 'status',
): Extract<UIMessage, { type: 'tool_result' }> => ({
  id: `${toolUseId}-result`,
  type: 'tool_result',
  toolUseId,
  content: `Updated task #${taskId} ${updatedFields}`,
  isError: false,
  timestamp,
})

const agentMessages: UIMessage[] = [
  {
    id: 'agent-tool-1',
    type: 'tool_use',
    toolName: 'Agent',
    toolUseId: 'agent-tool-1',
    input: { description: '审查代码结构' },
    timestamp: 1000,
  },
  {
    id: 'agent-result-1',
    type: 'tool_result',
    toolUseId: 'agent-tool-1',
    content: {
      status: 'completed',
      content: [
        { type: 'text', text: '# 审查报告\n\n没有阻塞问题。' },
        { type: 'text', text: 'agentId: child-1\n<usage>total_tokens: 42</usage>' },
      ],
    },
    isError: false,
    timestamp: 2000,
  },
  {
    id: 'agent-tool-2',
    type: 'tool_use',
    toolName: 'Agent',
    toolUseId: 'agent-tool-2',
    input: { description: '运行边界条件方案' },
    timestamp: 3000,
  },
  {
    id: 'agent-result-2',
    type: 'tool_result',
    toolUseId: 'agent-tool-2',
    content: "Agent type 'general' not found",
    isError: true,
    timestamp: 4000,
  },
]

describe('buildSessionActivityModel', () => {
  it('reports no visible activity for an empty model', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(hasVisibleSessionActivity(model)).toBe(false)
    expect(getVisibleActivitySections(model)).toEqual([])
    expect(model.badgeCount).toBe(0)
  })

  it('keeps completed TodoWrite historical tasks visible without badge attention', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [{
        id: 'todo-1',
        type: 'tool_use',
        toolName: 'TodoWrite',
        toolUseId: 'todo-1',
        input: {
          todos: [
            { content: '审查现有实现', status: 'completed' },
          ],
        },
        timestamp: 1000,
      }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(hasVisibleSessionActivity(model)).toBe(true)
    expect(getVisibleActivitySections(model).map((section) => section.id)).toEqual(['tasks'])
    expect(model.badgeCount).toBe(0)
  })

  it('keeps completed Agent tool_use/tool_result rows visible without badge attention', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [agentMessages[0]!, agentMessages[1]!],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(hasVisibleSessionActivity(model)).toBe(true)
    expect(getVisibleActivitySections(model).map((section) => section.id)).toEqual(['subagents'])
    expect(model.badgeCount).toBe(0)
  })

  it('counts running and failed rows as visible while preserving badge attention semantics', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [
        task({ id: '1', subject: 'Implement', status: 'in_progress' }),
      ],
      completedAndDismissed: false,
      backgroundTasks: [
        background({ taskId: 'agent-1', toolUseId: 'tool-1', status: 'failed', taskType: 'local_agent' }),
        background({ taskId: 'bg-2', toolUseId: 'tool-2', status: 'running', taskType: 'local_bash' }),
      ],
      agentNotifications: [],
    })

    expect(hasVisibleSessionActivity(model)).toBe(true)
    // Plan, then the agents working it, then the processes it left running.
    expect(getVisibleActivitySections(model).map((section) => section.id)).toEqual([
      'tasks',
      'subagents',
      'backgroundTasks',
    ])
    expect(model.badgeCount).toBe(3)
  })

  it('counts running team members as badge attention', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
      teamMembers: [
        { agentId: 'security', role: 'Security reviewer', status: 'running' },
        { agentId: 'performance', role: 'Performance reviewer', status: 'completed' },
      ],
    })

    expect(hasVisibleSessionActivity(model)).toBe(true)
    expect(getVisibleActivitySections(model).map((section) => section.id)).toEqual(['team'])
    expect(model.badgeCount).toBe(1)
  })

  it('counts error team members as badge attention', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
      teamMembers: [
        { agentId: 'security', role: 'Security reviewer', status: 'error' },
      ],
    })

    expect(hasVisibleSessionActivity(model)).toBe(true)
    expect(getVisibleActivitySections(model).map((section) => section.id)).toEqual(['team'])
    expect(model.badgeCount).toBe(1)
  })

  it('does not count output-only rows as visible activity', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [
        notification({
          taskId: 'bg-bash-1',
          toolUseId: 'bash-tool-1',
          status: 'completed',
          summary: 'Task completed',
          outputFile: '/tmp/bg-test.log',
        }),
      ],
    })

    expect(model.sections.output.rows).toHaveLength(1)
    expect(hasVisibleSessionActivity(model)).toBe(false)
    expect(getVisibleActivitySections(model)).toEqual([])
    expect(model.badgeCount).toBe(0)
  })

  it('does not keep Activity visible for dismissed finished background tasks', () => {
    const dismissedTask = background({
      taskId: 'bg-1',
      toolUseId: 'tool-1',
      status: 'completed',
      taskType: 'local_bash',
      startedAt: 1000,
      description: 'Dismissed run',
    })

    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [dismissedTask],
      dismissedBackgroundTaskKeys: new Set([createBackgroundTaskDismissKey(dismissedTask)]),
      agentNotifications: [],
    })

    expect(model.sections.backgroundTasks.rows).toHaveLength(0)
    expect(hasVisibleSessionActivity(model)).toBe(false)
    expect(getVisibleActivitySections(model)).toEqual([])
    expect(model.badgeCount).toBe(0)
  })

  it('counts incomplete tasks and running agent rows for the badge', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [
        task({ id: '1', subject: 'Plan', status: 'completed' }),
        task({ id: '2', subject: 'Implement', status: 'in_progress' }),
      ],
      completedAndDismissed: false,
      backgroundTasks: [
        background({ taskId: 'agent-1', toolUseId: 'tool-1', status: 'running', taskType: 'local_agent' }),
        background({ taskId: 'bg-2', toolUseId: 'tool-2', status: 'completed', taskType: 'local_bash' }),
      ],
      agentNotifications: [],
    })

    expect(model.badgeCount).toBe(2)
    expect(model.sections.tasks.rows).toHaveLength(2)
    expect(model.sections.subagents.rows).toHaveLength(1)
    expect(model.sections.backgroundTasks.rows).toHaveLength(1)
  })

  it('deduplicates SubAgent rows by toolUseId and keeps notification metadata', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [
        background({ taskId: 'agent-1', toolUseId: 'tool-1', status: 'running', summary: 'Still working' }),
      ],
      agentNotifications: [
        notification({ taskId: 'agent-1', toolUseId: 'tool-1', status: 'completed', outputFile: '/tmp/out.md' }),
      ],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        toolUseId: 'tool-1',
        status: 'completed',
        summary: 'Done',
        outputFile: '/tmp/out.md',
        openable: true,
      }),
    ])
    expect(model.sections.output.rows).toEqual([
      expect.objectContaining({ id: 'output-tool-1', label: '/tmp/out.md' }),
    ])
  })

  it('keeps rows without toolUseId readable but not openable', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [
        background({ taskId: 'agent-no-tool', toolUseId: undefined, status: 'failed', taskType: 'local_agent' }),
      ],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'agent-no-tool',
        toolUseId: undefined,
        openable: false,
        status: 'failed',
      }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('upgrades a taskId-keyed SubAgent row when a notification provides toolUseId', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [
        background({
          taskId: 'agent-1',
          toolUseId: undefined,
          status: 'running',
          summary: 'Exploring',
          outputFile: '/tmp/background.md',
          usage: { totalTokens: 12 },
        }),
      ],
      agentNotifications: [
        notification({ taskId: 'agent-1', toolUseId: 'tool-1', status: 'completed', result: 'Finished' }),
      ],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        toolUseId: 'tool-1',
        taskId: 'agent-1',
        status: 'completed',
        summary: 'Done',
        outputFile: '/tmp/background.md',
        usage: { totalTokens: 12 },
        openable: true,
      }),
    ])
  })

  it('adds Agent tool calls from session messages to the SubAgents section', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: agentMessages,
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'agent-tool-1',
        label: '审查代码结构',
        status: 'completed',
        summary: '# 审查报告 没有阻塞问题。',
        openable: true,
      }),
      expect.objectContaining({
        id: 'agent-tool-2',
        label: '运行边界条件方案',
        status: 'failed',
        summary: "Agent type 'general' not found",
        openable: true,
      }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('puts Team member spawns in Team while preserving direct Agent calls in SubAgents', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'team-agent-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'team-agent-tool',
          input: {
            description: '分析桌面端 UI 变更',
            name: 'desktop-analyzer',
            team_name: 'v053-release-audit',
          },
          timestamp: 1000,
        },
        {
          id: 'team-agent-result',
          type: 'tool_result',
          toolUseId: 'team-agent-tool',
          content: 'Spawned successfully.',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'direct-agent-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'direct-agent-tool',
          input: { description: '检查普通 SubAgent 路径' },
          timestamp: 1002,
        },
        {
          id: 'blank-team-agent-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'blank-team-agent-tool',
          input: { description: '检查空 Team 名路径', team_name: '   ' },
          timestamp: 1003,
        },
        {
          id: 'unnamed-team-agent-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'unnamed-team-agent-tool',
          input: { description: '检查未命名普通 SubAgent 路径', team_name: 'v053-release-audit' },
          timestamp: 1004,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({ id: 'direct-agent-tool', label: '检查普通 SubAgent 路径' }),
      expect.objectContaining({ id: 'blank-team-agent-tool', label: '检查空 Team 名路径' }),
      expect.objectContaining({ id: 'unnamed-team-agent-tool', label: '检查未命名普通 SubAgent 路径' }),
    ])
    expect(model.sections.team.rows).toEqual([
      expect.objectContaining({
        id: 'team-agent-tool',
        label: 'desktop-analyzer',
        section: 'team',
        status: 'running',
        teamName: 'v053-release-audit',
        teamMemberName: 'desktop-analyzer',
      }),
    ])
    expect(model.badgeCount).toBe(4)
  })

  it('keeps Team launch rows out of main Activity without hiding direct SubAgents', () => {
    const teamLaunch: UIMessage = {
      id: 'team-agent-tool',
      type: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'team-agent-tool',
      input: {
        description: '分析桌面端 UI 变更',
        name: 'desktop-analyzer',
        team_name: 'v053-release-audit',
      },
      timestamp: 1000,
    }
    const directLaunch: UIMessage = {
      id: 'direct-agent-tool',
      type: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'direct-agent-tool',
      input: { description: '检查普通 SubAgent 路径' },
      timestamp: 1001,
    }
    const buildMainModel = (messages: UIMessage[]) => buildMainSessionActivityModel({
      sessionId: 'session-1',
      messages,
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    const teamOnly = buildMainModel([teamLaunch])
    expect(hasVisibleSessionActivity(teamOnly)).toBe(false)
    expect(teamOnly.sections.team.rows).toEqual([])

    const guardedTeamInputs = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [teamLaunch],
      tasks: [],
      teamTasks: [task({ id: 'team-task', subject: 'Shared Team DAG' })],
      teamMembers: [{ agentId: 'desktop-analyzer@v053-release-audit', role: 'reviewer', status: 'running' }],
      includeTeamActivity: false,
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })
    expect(hasVisibleSessionActivity(guardedTeamInputs)).toBe(false)
    expect(guardedTeamInputs.sections.tasks.rows).toEqual([])
    expect(guardedTeamInputs.sections.team.rows).toEqual([])

    const withDirectSubagent = buildMainModel([teamLaunch, directLaunch])
    expect(getVisibleActivitySections(withDirectSubagent).map(section => section.id)).toEqual(['subagents'])
    expect(withDirectSubagent.sections.subagents.rows).toEqual([
      expect.objectContaining({ id: 'direct-agent-tool', label: '检查普通 SubAgent 路径' }),
    ])
  })

  it('waits for a pending Agent input to finish before projecting an unknown owner', () => {
    const buildMainModel = (message: UIMessage) => buildMainSessionActivityModel({
      sessionId: 'session-1',
      messages: [message],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })
    const partialAgent: UIMessage = {
      id: 'streaming-agent-tool',
      type: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'streaming-agent-tool',
      input: { description: '正在流式解析任务' },
      timestamp: 1000,
      isPending: true,
      partialInput: '{"description":"正在流式解析任务","name":',
    }

    expect(hasVisibleSessionActivity(buildMainModel(partialAgent))).toBe(false)

    const completedDirectAgent = buildMainModel({
      ...partialAgent,
      input: { description: '正在流式解析任务' },
      isPending: false,
      partialInput: undefined,
    })
    expect(completedDirectAgent.sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'streaming-agent-tool',
        label: '正在流式解析任务',
        status: 'running',
      }),
    ])
  })

  it('uses the durable Team window to classify name-only Agent launches in both directions', () => {
    const messages: UIMessage[] = [
      {
        id: 'create-tool',
        type: 'tool_use',
        toolName: 'TeamCreate',
        toolUseId: 'create-tool',
        input: { team_name: 'durable-team' },
        timestamp: 100,
      },
      {
        id: 'create-result',
        type: 'tool_result',
        toolUseId: 'create-tool',
        content: { success: true, team_name: 'durable-team' },
        isError: false,
        timestamp: 101,
      },
      {
        id: 'window-member',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'window-member',
        input: { name: 'reviewer', description: 'Team member from durable scope' },
        timestamp: 150,
        isPending: false,
      },
      {
        id: 'window-direct',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'window-direct',
        input: { description: 'Unnamed direct Agent inside Team scope' },
        timestamp: 160,
        isPending: false,
      },
      {
        id: 'post-window-direct',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'post-window-direct',
        input: { name: 'standalone-reviewer', description: 'Named direct Agent after Team scope' },
        timestamp: 250,
        isPending: false,
      },
      {
        id: 'explicit-team-member',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'explicit-team-member',
        input: {
          name: 'explicit-reviewer',
          team_name: 'archived-team',
          description: 'Explicit Team member outside durable scope',
        },
        timestamp: 260,
        isPending: false,
      },
    ]

    const model = buildMainSessionActivityModel({
      sessionId: 'session-1',
      messages,
      teamTaskWindows: [{ startedAt: 100, endedAt: 200 }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'window-direct',
        label: 'Unnamed direct Agent inside Team scope',
      }),
      expect.objectContaining({
        id: 'post-window-direct',
        label: 'Named direct Agent after Team scope',
      }),
    ])
    expect(model.sections.team.rows).toEqual([])
  })

  it('does not classify a named direct Agent as a teammate after TeamCreate fails', () => {
    const createTool: UIMessage = {
      id: 'create-tool',
      type: 'tool_use',
      toolName: 'TeamCreate',
      toolUseId: 'create-tool',
      input: { team_name: 'review-team' },
      timestamp: 100,
    }
    const namedAgent: UIMessage = {
      id: 'named-agent-tool',
      type: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'named-agent-tool',
      input: { name: 'reviewer', description: 'Review independently' },
      timestamp: 200,
    }
    const buildMainModel = (success: boolean, agentResult?: UIMessage) => buildMainSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        createTool,
        {
          id: 'create-result',
          type: 'tool_result',
          toolUseId: 'create-tool',
          content: { success, team_name: 'review-team' },
          isError: false,
          timestamp: 101,
        },
        namedAgent,
        ...(agentResult ? [agentResult] : []),
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(buildMainModel(false).sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'named-agent-tool',
        label: 'Review independently',
      }),
    ])
    expect(hasVisibleSessionActivity(buildMainModel(true))).toBe(false)

    const completedTeammate = buildMainModel(true, {
      id: 'named-agent-result',
      type: 'tool_result',
      toolUseId: 'named-agent-tool',
      content: { status: 'teammate_spawned', name: 'reviewer', team_name: 'review-team' },
      isError: false,
      timestamp: 201,
    })
    expect(hasVisibleSessionActivity(completedTeammate)).toBe(false)
  })

  it('lets a durable Team end close task scope when TeamDelete is absent from history', () => {
    const messages: UIMessage[] = [
      {
        id: 'create-tool', type: 'tool_use', toolName: 'TeamCreate', toolUseId: 'create',
        input: { team_name: 'audit-team' }, timestamp: 100,
      },
      {
        id: 'create-result', type: 'tool_result', toolUseId: 'create',
        content: { success: true }, isError: false, timestamp: 101,
      },
      {
        id: 'team-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'team-task',
        input: { subject: 'Shared Team task' }, timestamp: 150,
      },
      {
        id: 'main-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'main-task',
        input: { subject: 'Lead follow-up task' }, timestamp: 250,
      },
    ]

    const model = buildMainSessionActivityModel({
      sessionId: 'session-1',
      messages,
      teamTaskWindows: [{ startedAt: 100, endedAt: 200 }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows.map(row => row.label)).toEqual(['Lead follow-up task'])
  })

  it('uses a newer durable Team window after an older explicit TeamDelete', () => {
    const messages: UIMessage[] = [
      {
        id: 'old-delete', type: 'tool_use', toolName: 'TeamDelete', toolUseId: 'old-delete',
        input: { team_name: 'old-team' }, timestamp: 90,
      },
      {
        id: 'old-delete-result', type: 'tool_result', toolUseId: 'old-delete',
        content: { success: true }, isError: false, timestamp: 91,
      },
      {
        id: 'team-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'team-task',
        input: { subject: 'Compacted Team task' }, timestamp: 150,
      },
      {
        id: 'main-task', type: 'tool_use', toolName: 'TaskCreate', toolUseId: 'main-task',
        input: { subject: 'After compacted Team' }, timestamp: 250,
      },
    ]

    const model = buildMainSessionActivityModel({
      sessionId: 'session-1',
      messages,
      teamTaskWindows: [{ startedAt: 100, endedAt: 200 }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows.map(row => row.label)).toEqual(['After compacted Team'])
  })

  it('uses successful Team lifecycle results to hide implicit member spawns without hiding ordinary Agents', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'team-create-tool',
          type: 'tool_use',
          toolName: 'TeamCreate',
          toolUseId: 'team-create-tool',
          input: { team_name: 'v053-release-audit', description: '并行审计' },
          timestamp: 1000,
        },
        {
          id: 'team-create-result',
          type: 'tool_result',
          toolUseId: 'team-create-tool',
          content: [{ type: 'text', text: '{"team_name":"v053-release-audit","lead_agent_id":"team-lead@v053-release-audit"}' }],
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'implicit-member-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'implicit-member-tool',
          input: { description: '隐式团队成员', name: 'desktop-analyzer' },
          timestamp: 1002,
        },
        {
          id: 'ordinary-in-team-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'ordinary-in-team-tool',
          input: { description: '团队中的普通 SubAgent' },
          timestamp: 1003,
        },
        {
          id: 'failed-team-delete-tool',
          type: 'tool_use',
          toolName: 'TeamDelete',
          toolUseId: 'failed-team-delete-tool',
          input: {},
          timestamp: 1004,
        },
        {
          id: 'failed-team-delete-result',
          type: 'tool_result',
          toolUseId: 'failed-team-delete-tool',
          content: [{ type: 'text', text: '{"success":false,"message":"members still active","team_name":"v053-release-audit"}' }],
          isError: false,
          timestamp: 1005,
        },
        {
          id: 'implicit-member-after-failed-delete-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'implicit-member-after-failed-delete-tool',
          input: { description: '删除失败后的团队成员', name: 'provider-analyzer' },
          timestamp: 1006,
        },
        {
          id: 'team-delete-tool',
          type: 'tool_use',
          toolName: 'TeamDelete',
          toolUseId: 'team-delete-tool',
          input: {},
          timestamp: 1007,
        },
        {
          id: 'team-delete-result',
          type: 'tool_result',
          toolUseId: 'team-delete-tool',
          content: [{ type: 'text', text: '{"success":true,"message":"cleaned","team_name":"v053-release-audit"}' }],
          isError: false,
          timestamp: 1008,
        },
        {
          id: 'ordinary-named-agent-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'ordinary-named-agent-tool',
          input: { description: '团队结束后的普通 Agent', name: 'standalone-reviewer' },
          timestamp: 1009,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({ id: 'ordinary-in-team-tool', label: '团队中的普通 SubAgent' }),
      expect.objectContaining({ id: 'ordinary-named-agent-tool', label: '团队结束后的普通 Agent' }),
    ])
    expect(model.sections.team.rows).toEqual([
      expect.objectContaining({
        id: 'implicit-member-tool',
        label: 'desktop-analyzer',
        teamName: 'v053-release-audit',
      }),
      expect.objectContaining({
        id: 'implicit-member-after-failed-delete-tool',
        label: 'provider-analyzer',
        teamName: 'v053-release-audit',
      }),
    ])
    expect(model.badgeCount).toBe(4)
  })

  it('recognizes an implicit member from its own structured spawn metadata after earlier Team history is compacted', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'implicit-member-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'implicit-member-tool',
          input: { description: '隐式团队成员', name: 'desktop-analyzer' },
          timestamp: 1000,
        },
        {
          id: 'implicit-member-result',
          type: 'tool_result',
          toolUseId: 'implicit-member-tool',
          content: 'Spawned successfully.\nagent_id: desktop-analyzer@audit\nname: desktop-analyzer\nteam_name: audit',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'ordinary-named-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'ordinary-named-tool',
          input: { description: '普通命名 Agent', name: 'standalone-reviewer' },
          timestamp: 1002,
        },
        {
          id: 'ordinary-named-result',
          type: 'tool_result',
          toolUseId: 'ordinary-named-tool',
          content: 'Review complete.',
          isError: false,
          timestamp: 1003,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({ id: 'ordinary-named-tool', label: '普通命名 Agent' }),
    ])
    expect(model.sections.team.rows).toEqual([
      expect.objectContaining({
        id: 'implicit-member-tool',
        label: 'desktop-analyzer',
        teamName: 'audit',
        teamMemberName: 'desktop-analyzer',
      }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('prefers the authoritative Team member over its transcript launch row', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [{
        id: 'team-agent-tool',
        type: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'team-agent-tool',
        input: {
          team_name: 'audit',
          name: 'desktop-analyzer',
          description: '分析桌面端变更',
        },
        timestamp: 1000,
      }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
      teamMembers: [{
        agentId: 'desktop-analyzer@audit',
        name: 'desktop-analyzer',
        role: 'reviewer',
        status: 'completed',
      }],
    })

    expect(model.sections.team.rows).toEqual([
      expect.objectContaining({
        id: 'desktop-analyzer@audit',
        label: 'reviewer',
        status: 'completed',
      }),
    ])
    expect(model.sections.subagents.rows).toEqual([])
  })

  it('hides teammate runtime containers without changing other activity classes', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [
        background({
          taskId: 'in_process_teammate-1',
          toolUseId: 'team-agent-tool',
          taskType: 'in_process_teammate',
          description: 'desktop-analyzer',
        }),
        background({
          taskId: 'local-agent-1',
          toolUseId: 'local-agent-tool',
          taskType: 'local_agent',
          description: 'Direct SubAgent',
        }),
        background({
          taskId: 'local-bash-1',
          toolUseId: 'local-bash-tool',
          taskType: 'local_bash',
          description: 'bun test',
        }),
        background({
          taskId: 'local-workflow-1',
          toolUseId: 'local-workflow-tool',
          taskType: 'local_workflow',
          description: 'Release audit workflow',
        }),
      ],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({ id: 'local-agent-tool', taskType: 'local_agent' }),
    ])
    expect(model.sections.backgroundTasks.rows).toEqual([
      expect.objectContaining({ id: 'local-bash-tool', taskType: 'local_bash' }),
      expect.objectContaining({ id: 'local-workflow-tool', taskType: 'local_workflow' }),
    ])
    expect(model.badgeCount).toBe(3)
  })

  it('restores task rows from the latest TodoWrite message', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [{
        id: 'todo-1',
        type: 'tool_use',
        toolName: 'TodoWrite',
        toolUseId: 'todo-1',
        input: {
          todos: [
            { content: '审查现有实现', status: 'completed' },
            { content: '补充边界测试', activeForm: '正在补充边界测试', status: 'in_progress' },
          ],
        },
        timestamp: 1000,
      }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: '审查现有实现', status: 'completed' }),
      expect.objectContaining({ label: '补充边界测试', description: '正在补充边界测试', status: 'in_progress' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('deduplicates repeated TodoWrite task rows from noisy session history', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [{
        id: 'todo-1',
        type: 'tool_use',
        toolName: 'TodoWrite',
        toolUseId: 'todo-1',
        input: {
          todos: [
            { content: 'Security review', status: 'pending' },
            { content: 'Security review', activeForm: 'Security teammate', status: 'pending' },
            { content: 'Security review', activeForm: 'Security teammate', status: 'pending' },
            { content: 'Performance review', activeForm: 'Performance teammate', status: 'in_progress' },
            { content: 'Performance review', activeForm: 'Performance teammate', status: 'completed' },
          ],
        },
        timestamp: 1000,
      }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: 'Security review', description: 'Security teammate', status: 'pending' }),
      expect.objectContaining({ label: 'Performance review', description: 'Performance teammate', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('deduplicates repeated live task rows by title for compact activity display', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [
        task({ id: 'security-1', subject: 'Security review', description: 'Short', status: 'pending' }),
        task({ id: 'security-2', subject: 'Security review', description: 'Longer security review details', status: 'in_progress' }),
        task({ id: 'performance-1', subject: 'Performance review', status: 'completed' }),
      ],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({
        id: 'security-1',
        label: 'Security review',
        description: 'Longer security review details',
        status: 'in_progress',
      }),
      expect.objectContaining({ id: 'performance-1', label: 'Performance review', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('restores task rows from TaskCreate results and TaskUpdate messages', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: {
            subject: '审查现有订单汇总代码与测试',
            description: '审查 src/orders.mjs 和 tests/check.mjs',
          },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 审查现有订单汇总代码与测试',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-create-2',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-2',
          input: { subject: '补充边界测试' },
          timestamp: 1002,
        },
        {
          id: 'task-create-result-2',
          type: 'tool_result',
          toolUseId: 'task-create-call-2',
          content: 'Task #2 created successfully: 补充边界测试',
          isError: false,
          timestamp: 1003,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1004,
        },
        successfulTaskUpdateResult('task-update-call-1', '1', 1005),
        {
          id: 'task-update-2',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-2',
          input: { taskId: '2', status: 'in_progress', activeForm: '正在补充边界测试' },
          timestamp: 1006,
        },
        successfulTaskUpdateResult('task-update-call-2', '2', 1007),
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({
        id: '1',
        label: '审查现有订单汇总代码与测试',
        description: '审查 src/orders.mjs 和 tests/check.mjs',
        status: 'completed',
      }),
      expect.objectContaining({
        id: '2',
        label: '补充边界测试',
        description: '正在补充边界测试',
        status: 'in_progress',
      }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('does not let a stale live task list regress a successful TaskUpdate', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '完成当前任务' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 完成当前任务',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1002,
        },
        successfulTaskUpdateResult('task-update-call-1', '1', 1003),
      ],
      tasks: [task({ id: '1', subject: '完成当前任务', status: 'in_progress' })],
      completedAndDismissed: false,
      isForegroundTurnActive: true,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('lets confirmed updates reopen tasks while live state advances untouched tasks', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '重新执行验收' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 重新执行验收',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-create-2',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-2',
          input: { subject: '等待后台完成' },
          timestamp: 1002,
        },
        {
          id: 'task-create-result-2',
          type: 'tool_result',
          toolUseId: 'task-create-call-2',
          content: 'Task #2 created successfully: 等待后台完成',
          isError: false,
          timestamp: 1003,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', status: 'in_progress' },
          timestamp: 1004,
        },
        successfulTaskUpdateResult('task-update-call-1', '1', 1005),
      ],
      tasks: [
        task({ id: '1', subject: '重新执行验收', status: 'completed' }),
        task({ id: '2', subject: '等待后台完成', status: 'completed' }),
      ],
      completedAndDismissed: false,
      isForegroundTurnActive: true,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', status: 'in_progress' }),
      expect.objectContaining({ id: '2', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('does not confuse a main task with a child task that has the same list-local id', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'root-task-create',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'root-task-create-call',
          input: { subject: '审查最近七天全部 Git 提交' },
          timestamp: 1000,
        },
        {
          id: 'root-task-create-result',
          type: 'tool_result',
          toolUseId: 'root-task-create-call',
          content: 'Task #1 created successfully: 审查最近七天全部 Git 提交',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'agent-tool',
          type: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'agent-tool-call',
          input: { description: '审查提交潜在回归' },
          timestamp: 1002,
        },
        {
          id: 'child-task-create',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'agent-tool-call/child-task-create-call',
          originalToolUseId: 'child-task-create-call',
          input: { subject: '子代理内部检查' },
          parentToolUseId: 'agent-tool-call',
          timestamp: 1003,
        },
        {
          id: 'child-task-create-result',
          type: 'tool_result',
          toolUseId: 'agent-tool-call/child-task-create-call',
          originalToolUseId: 'child-task-create-call',
          content: 'Task #1 created successfully: 子代理内部检查',
          isError: false,
          parentToolUseId: 'agent-tool-call',
          timestamp: 1004,
        },
      ],
      tasks: [
        task({ id: '1', subject: '审查最近七天全部 Git 提交' }),
      ],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({
        id: '1',
        label: '审查最近七天全部 Git 提交',
      }),
    ])
    expect(model.badgeCount).toBe(2)
  })

  it('does not let a child deletion remove a main task with the same list-local id', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'child-task-delete',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'agent-tool-call/child-task-delete-call',
          originalToolUseId: 'child-task-delete-call',
          input: { taskId: '1', status: 'deleted' },
          parentToolUseId: 'agent-tool-call',
          timestamp: 1000,
        },
        {
          ...successfulTaskUpdateResult('agent-tool-call/child-task-delete-call', '1', 1001, 'deleted'),
          parentToolUseId: 'agent-tool-call',
        },
      ],
      tasks: [task({ id: '1', subject: '主会话验收' })],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', label: '主会话验收' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('does not restore parent-linked SubAgent TodoWrite rows as session tasks', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [{
        id: 'child-todo',
        type: 'tool_use',
        toolName: 'TodoWrite',
        toolUseId: 'agent-tool-call/child-todo-call',
        originalToolUseId: 'child-todo-call',
        input: {
          todos: [{ content: '子代理内部检查项', status: 'in_progress' }],
        },
        parentToolUseId: 'agent-tool-call',
        timestamp: 1000,
      }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([])
    expect(model.badgeCount).toBe(0)
  })

  it('keeps parent-linked TodoWrite rows in an agent run', () => {
    const model = buildSessionActivityModel({
      sessionId: 'agent-1',
      runScope: 'agent',
      messages: [{
        id: 'child-todo',
        type: 'tool_use',
        toolName: 'TodoWrite',
        toolUseId: 'agent-tool-call/child-todo-call',
        originalToolUseId: 'child-todo-call',
        input: {
          todos: [{ content: '子代理内部检查项', status: 'in_progress' }],
        },
        parentToolUseId: 'agent-tool-call',
        timestamp: 1000,
      }],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: '子代理内部检查项', status: 'in_progress' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('uses explicit member tasks and TodoWrite without rebuilding shared team Task events', () => {
    const model = buildSessionActivityModel({
      sessionId: 'team-member:agent-1',
      runScope: 'agent',
      taskScope: 'team',
      messages: [
        {
          id: 'shared-task-create',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'team-agent/shared-task-create-call',
          input: { subject: '其他成员的共享任务' },
          parentToolUseId: 'team-agent',
          timestamp: 1000,
        },
        {
          id: 'shared-task-create-result',
          type: 'tool_result',
          toolUseId: 'team-agent/shared-task-create-call',
          content: 'Task #9 created successfully: 其他成员的共享任务',
          isError: false,
          parentToolUseId: 'team-agent',
          timestamp: 1001,
        },
        {
          id: 'shared-task-delete',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'team-agent/shared-task-delete-call',
          input: { taskId: '1', status: 'deleted' },
          parentToolUseId: 'team-agent',
          timestamp: 1002,
        },
        {
          ...successfulTaskUpdateResult('team-agent/shared-task-delete-call', '1', 1003, 'deleted'),
          parentToolUseId: 'team-agent',
        },
        {
          id: 'member-todo',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'team-agent/member-todo-call',
          input: {
            todos: [{ content: '成员自己的检查项', status: 'in_progress' }],
          },
          parentToolUseId: 'team-agent',
          timestamp: 1004,
        },
      ],
      tasks: [task({ id: '1', subject: '分配给当前成员的任务' })],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: '成员自己的检查项', status: 'in_progress' }),
      expect.objectContaining({ id: '1', label: '分配给当前成员的任务', status: 'pending' }),
    ])
    expect(model.sections.tasks.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '其他成员的共享任务' }),
    ]))
    expect(model.badgeCount).toBe(2)
  })

  it('maps authoritative team task failure and completion by structured task id', () => {
    const messages: UIMessage[] = [
      {
        id: 'failed-update-a',
        type: 'tool_use',
        toolName: 'TaskUpdate',
        toolUseId: 'failed-update-a-call',
        input: { taskId: 'A', status: 'completed' },
        timestamp: 1004,
      },
      {
        id: 'failed-update-a-result',
        type: 'tool_result',
        toolUseId: 'failed-update-a-call',
        content: 'same result text',
        isError: true,
        timestamp: 1005,
      },
      {
        id: 'stale-update-b',
        type: 'tool_use',
        toolName: 'TaskUpdate',
        toolUseId: 'stale-update-b-call',
        input: { taskId: 'B', status: 'in_progress' },
        timestamp: 1006,
      },
      {
        id: 'stale-update-b-result',
        type: 'tool_result',
        toolUseId: 'stale-update-b-call',
        content: 'same result text',
        isError: false,
        timestamp: 1007,
      },
    ]
    const teamTasks = [
      task({ id: 'A', subject: 'Review shared surface', taskListId: 'team-list' }),
      task({ id: 'B', subject: 'Review shared surface', taskListId: 'team-list', status: 'completed' }),
    ]

    const failedState = buildSessionActivityModel({
      sessionId: 'session-1',
      messages,
      tasks: [],
      teamTasks,
      taskScope: 'team-session',
      teamTaskWindows: [{ startedAt: 1000 }],
      isForegroundTurnActive: false,
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(failedState.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: 'team-task:team-list:A', taskId: 'A', status: 'pending' }),
      expect.objectContaining({ id: 'team-task:team-list:B', taskId: 'B', status: 'completed' }),
    ])

    const completedState = buildSessionActivityModel({
      sessionId: 'session-1',
      messages,
      tasks: [],
      teamTasks: teamTasks.map(current => ({ ...current, status: 'completed' })),
      taskScope: 'team-session',
      teamTaskWindows: [{ startedAt: 1000 }],
      isForegroundTurnActive: false,
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(completedState.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: 'team-task:team-list:A', taskId: 'A', status: 'completed' }),
      expect.objectContaining({ id: 'team-task:team-list:B', taskId: 'B', status: 'completed' }),
    ])
  })

  it('filters shared tasks only inside a successful TeamCreate to TeamDelete lifecycle', () => {
    const taskCall = (id: string, subject: string, timestamp: number): UIMessage[] => [{
      id: `${id}-use`,
      type: 'tool_use',
      toolName: 'TaskCreate',
      toolUseId: id,
      input: { subject },
      timestamp,
    }, {
      id: `${id}-result`,
      type: 'tool_result',
      toolUseId: id,
      content: `Task #${id} created successfully: ${subject}`,
      isError: false,
      timestamp: timestamp + 1,
    }]
    const model = buildSessionActivityModel({
      sessionId: 'team-lifecycle-session',
      taskScope: 'team-session',
      // The workbench can close a little after TeamDelete succeeds. Once the
      // transcript has an authoritative lifecycle marker, it must win over
      // this still-open discovery window.
      teamTaskWindows: [{ startedAt: 1500 }],
      messages: [
        ...taskCall('1', 'Keep the pre-team task', 1000),
        {
          id: 'team-create',
          type: 'tool_use',
          toolName: 'TeamCreate',
          toolUseId: 'team-create-call',
          input: { team_name: 'review-team' },
          timestamp: 2000,
        },
        {
          id: 'team-create-result',
          type: 'tool_result',
          toolUseId: 'team-create-call',
          content: { team_name: 'review-team' },
          isError: false,
          timestamp: 2001,
        },
        ...taskCall('2', 'Hide the shared team task', 3000),
        {
          id: 'team-delete',
          type: 'tool_use',
          toolName: 'TeamDelete',
          toolUseId: 'team-delete-call',
          input: { team_name: 'review-team' },
          timestamp: 4000,
        },
        {
          id: 'team-delete-result',
          type: 'tool_result',
          toolUseId: 'team-delete-call',
          content: { team_name: 'review-team' },
          isError: false,
          timestamp: 4001,
        },
        ...taskCall('3', 'Keep the post-team task', 5000),
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Keep the pre-team task' }),
      expect.objectContaining({ label: 'Keep the post-team task' }),
    ]))
    expect(model.sections.tasks.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Hide the shared team task' }),
    ]))
  })

  it('does not enter team task scope after a failed TeamCreate', () => {
    const model = buildSessionActivityModel({
      sessionId: 'failed-team-create-session',
      taskScope: 'team-session',
      messages: [
        {
          id: 'failed-team-create',
          type: 'tool_use',
          toolName: 'TeamCreate',
          toolUseId: 'failed-team-create-call',
          input: { team_name: 'review-team' },
          timestamp: 1000,
        },
        {
          id: 'failed-team-create-result',
          type: 'tool_result',
          toolUseId: 'failed-team-create-call',
          content: 'Team creation failed',
          isError: true,
          timestamp: 1001,
        },
        {
          id: 'session-task',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'session-task-call',
          input: { subject: 'Keep the session task' },
          timestamp: 2000,
        },
        {
          id: 'session-task-result',
          type: 'tool_result',
          toolUseId: 'session-task-call',
          content: 'Task #1 created successfully: Keep the session task',
          isError: false,
          timestamp: 2001,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: 'Keep the session task' }),
    ])
  })

  it('keeps team scope active when TeamDelete returns success false', () => {
    const model = buildSessionActivityModel({
      sessionId: 'failed-team-delete-session',
      taskScope: 'team-session',
      messages: [
        {
          id: 'team-create',
          type: 'tool_use',
          toolName: 'TeamCreate',
          toolUseId: 'team-create-call',
          input: { team_name: 'review-team' },
          timestamp: 1000,
        },
        {
          id: 'team-create-result',
          type: 'tool_result',
          toolUseId: 'team-create-call',
          content: { success: true, team_name: 'review-team' },
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'failed-team-delete',
          type: 'tool_use',
          toolName: 'TeamDelete',
          toolUseId: 'team-delete-call',
          input: { team_name: 'review-team' },
          timestamp: 2000,
        },
        {
          id: 'failed-team-delete-result',
          type: 'tool_result',
          toolUseId: 'team-delete-call',
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, message: 'Active members remain' }),
          }],
          isError: false,
          timestamp: 2001,
        },
        {
          id: 'shared-task',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'shared-task-call',
          input: { subject: 'Keep this in the team task list' },
          timestamp: 3000,
        },
        {
          id: 'shared-task-result',
          type: 'tool_result',
          toolUseId: 'shared-task-call',
          content: 'Task #1 created successfully: Keep this in the team task list',
          isError: false,
          timestamp: 3001,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([])
  })

  it('keeps the last successful status when a later TaskUpdate fails', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '补充活动面板回归测试' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #2 created successfully: 补充活动面板回归测试',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-update-completed',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-completed-call',
          input: { taskId: '2', status: 'completed' },
          timestamp: 1002,
        },
        {
          id: 'task-update-completed-result',
          type: 'tool_result',
          toolUseId: 'task-update-completed-call',
          content: 'Updated task #2 status\n\nTask completed. Call TaskList now to find your next available task.',
          isError: false,
          timestamp: 1003,
        },
        {
          id: 'task-update-reopen',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-reopen-call',
          input: { taskId: '2', status: 'in_progress', activeForm: '正在重新检查活动面板' },
          timestamp: 1004,
        },
        {
          id: 'task-update-reopen-result',
          type: 'tool_result',
          toolUseId: 'task-update-reopen-call',
          content: 'Task not found',
          // TaskUpdate deliberately reports this as a non-error so sibling
          // tool calls are not cancelled.
          isError: false,
          timestamp: 1005,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({
        id: '2',
        label: '补充活动面板回归测试',
        status: 'completed',
      }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('does not apply a stopped, unconfirmed TaskUpdate optimistically', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '核对最终状态' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 核对最终状态',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-update-completed',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-completed-call',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1002,
        },
        successfulTaskUpdateResult('task-update-completed-call', '1', 1003),
        {
          id: 'task-update-reopen',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-reopen-call',
          input: { taskId: '1', status: 'in_progress' },
          timestamp: 1004,
          status: 'stopped',
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('matches a TaskUpdate result that arrives after an optimistic queued message', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '完成当前任务' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 完成当前任务',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-update-completed',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-completed-call',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1002,
        },
        {
          id: 'queued-user-message',
          type: 'user_text',
          content: '完成后继续检查下一项',
          timestamp: 1003,
          optimisticQueued: true,
        },
        successfulTaskUpdateResult('task-update-completed-call', '1', 1004),
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', label: '完成当前任务', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('preserves status when a successful TaskUpdate changes another field', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '保留完成状态' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 保留完成状态',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-update-completed',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-completed-call',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1002,
        },
        successfulTaskUpdateResult('task-update-completed-call', '1', 1003),
        {
          id: 'task-update-owner',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-owner-call',
          input: { taskId: '1', owner: 'reviewer' },
          timestamp: 1004,
        },
        successfulTaskUpdateResult('task-update-owner-call', '1', 1005, 'owner'),
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('drops tasks deleted by TaskUpdate instead of showing them as pending', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '写 README' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 写 README',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-create-2',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-2',
          input: { subject: '给 summarize 加空数组保护' },
          timestamp: 1002,
        },
        {
          id: 'task-create-result-2',
          type: 'tool_result',
          toolUseId: 'task-create-call-2',
          content: 'Task #2 created successfully: 给 summarize 加空数组保护',
          isError: false,
          timestamp: 1003,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '2', status: 'completed' },
          timestamp: 1004,
        },
        successfulTaskUpdateResult('task-update-call-1', '2', 1005),
        {
          id: 'task-update-2',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-2',
          input: { taskId: '1', status: 'deleted' },
          timestamp: 1006,
        },
        successfulTaskUpdateResult('task-update-call-2', '1', 1007, 'deleted'),
      ],
      tasks: [task({ id: '2', subject: '给 summarize 加空数组保护', status: 'completed' })],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '2', label: '给 summarize 加空数组保护', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('keeps a task when its TaskUpdate deletion fails', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '保留仍然存在的任务' },
          timestamp: 1000,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 保留仍然存在的任务',
          isError: false,
          timestamp: 1001,
        },
        {
          id: 'task-update-delete',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-delete-call',
          input: { taskId: '1', status: 'deleted' },
          timestamp: 1002,
        },
        {
          id: 'task-update-delete-result',
          type: 'tool_result',
          toolUseId: 'task-update-delete-call',
          content: 'Failed to delete task',
          isError: false,
          timestamp: 1003,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', label: '保留仍然存在的任务', status: 'pending' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('does not invent a row for a TaskUpdate deletion without a matching TaskCreate', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          type: 'user_text',
          content: '那条任务不用做了，删掉吧',
          timestamp: 1000,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '7', status: 'deleted' },
          timestamp: 1001,
        },
        successfulTaskUpdateResult('task-update-call-1', '7', 1002, 'deleted'),
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([])
    expect(model.badgeCount).toBe(0)
  })

  it('removes tasks deleted in a later turn from earlier task history', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        { id: 'user-1', type: 'user_text', content: '先做订单功能', timestamp: 1000 },
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '实现订单汇总' },
          timestamp: 1001,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 实现订单汇总',
          isError: false,
          timestamp: 1002,
        },
        {
          id: 'task-create-2',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-2',
          input: { subject: '写 README' },
          timestamp: 1003,
        },
        {
          id: 'task-create-result-2',
          type: 'tool_result',
          toolUseId: 'task-create-call-2',
          content: 'Task #2 created successfully: 写 README',
          isError: false,
          timestamp: 1004,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1005,
        },
        successfulTaskUpdateResult('task-update-call-1', '1', 1006),
        { id: 'user-2', type: 'user_text', content: 'README 不写了，继续做活动面板', timestamp: 2000 },
        {
          id: 'task-update-2',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-2',
          input: { taskId: '2', status: 'deleted' },
          timestamp: 2001,
        },
        successfulTaskUpdateResult('task-update-call-2', '2', 2002, 'deleted'),
        {
          id: 'task-create-3',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-3',
          input: { subject: '实现活动面板' },
          timestamp: 2003,
        },
        {
          id: 'task-create-result-3',
          type: 'tool_result',
          toolUseId: 'task-create-call-3',
          content: 'Task #3 created successfully: 实现活动面板',
          isError: false,
          timestamp: 2004,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '3', label: '实现活动面板', status: 'pending' }),
      expect.objectContaining({
        label: 'Earlier tasks',
        status: 'completed',
        taskHistory: { completed: 1, total: 1, turnCount: 1 },
      }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('hides deleted tasks that a stale live task list still reports', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', status: 'deleted' },
          timestamp: 1000,
        },
        successfulTaskUpdateResult('task-update-call-1', '1', 1001, 'deleted'),
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '补充边界测试' },
          timestamp: 1002,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #2 created successfully: 补充边界测试',
          isError: false,
          timestamp: 1003,
        },
      ],
      // tool_result 后才异步 refreshTasks，这一刻的列表还没剔掉已删任务
      tasks: [
        task({ id: '1', subject: '写 README', status: 'pending' }),
        task({ id: '2', subject: '补充边界测试', status: 'pending' }),
      ],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '2', label: '补充边界测试', status: 'pending' }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('keeps TodoWrite rows authoritative over a later failed TaskUpdate', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'todo-1',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'todo-call-1',
          input: {
            todos: [{ content: '继续验证桌面活动面板', status: 'in_progress' }],
          },
          timestamp: 1000,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1001,
        },
        {
          id: 'task-update-result-1',
          type: 'tool_result',
          toolUseId: 'task-update-call-1',
          content: 'Task not found',
          isError: false,
          timestamp: 1002,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({
        label: '继续验证桌面活动面板',
        status: 'in_progress',
      }),
    ])
    expect(model.badgeCount).toBe(1)
  })

  it('uses message order when TodoWrite and a successful TaskUpdate share a timestamp', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'todo-1',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'todo-call-1',
          input: {
            todos: [{ content: '完成历史兼容验证', status: 'in_progress' }],
          },
          timestamp: 1000,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', subject: '完成历史兼容验证', status: 'completed' },
          timestamp: 1000,
        },
        successfulTaskUpdateResult('task-update-call-1', '1', 1000),
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', label: '完成历史兼容验证', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('prefers task summary rows over earlier TodoWrite rows', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'todo-1',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'todo-1',
          input: { todos: [{ content: '旧任务', status: 'in_progress' }] },
          timestamp: 1000,
        },
        {
          id: 'summary-1',
          type: 'task_summary',
          tasks: [{ id: '1', subject: '最终验收', status: 'completed' }],
          timestamp: 2000,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: '最终验收', status: 'completed' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('keeps current-turn checklist rows separate from earlier completed turns', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          type: 'user_text',
          content: '先做订单功能',
          timestamp: 1000,
        },
        {
          id: 'todo-1',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'todo-1',
          input: {
            todos: [
              { content: '实现', status: 'completed' },
              { content: '验证', status: 'completed' },
            ],
          },
          timestamp: 1100,
        },
        {
          id: 'summary-1',
          type: 'task_summary',
          tasks: [
            { id: '1', subject: '实现', status: 'completed' },
            { id: '2', subject: '验证', status: 'completed' },
          ],
          timestamp: 1200,
        },
        {
          id: 'user-2',
          type: 'user_text',
          content: '继续做活动面板',
          timestamp: 2000,
        },
        {
          id: 'todo-2',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'todo-2',
          input: {
            todos: [
              { content: '实现', activeForm: '实现活动面板', status: 'in_progress' },
              { content: '截图验证', status: 'pending' },
            ],
          },
          timestamp: 2100,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: '实现', description: '实现活动面板', status: 'in_progress' }),
      expect.objectContaining({ label: '截图验证', status: 'pending' }),
      expect.objectContaining({
        id: expect.stringContaining('task-history-'),
        label: 'Earlier tasks',
        status: 'completed',
        taskHistory: { completed: 2, total: 2, turnCount: 1 },
      }),
    ])
    expect(model.badgeCount).toBe(2)
  })

  it('seals interrupted earlier tasks without badge attention', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          type: 'user_text',
          content: '执行第一轮任务',
          timestamp: 1000,
        },
        {
          id: 'todo-1',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'todo-1',
          input: {
            todos: [
              { content: '已完成项', status: 'completed' },
              { content: '被中断项', status: 'in_progress' },
            ],
          },
          timestamp: 1100,
        },
        {
          id: 'user-2',
          type: 'user_text',
          content: '中断后继续新任务',
          timestamp: 2000,
        },
        {
          id: 'todo-2',
          type: 'tool_use',
          toolName: 'TodoWrite',
          toolUseId: 'todo-2',
          input: {
            todos: [{ content: '新轮次任务', status: 'completed' }],
          },
          timestamp: 2100,
        },
      ],
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ label: '新轮次任务', status: 'completed' }),
      expect.objectContaining({
        label: 'Earlier tasks',
        status: 'stopped',
        taskHistory: { completed: 1, total: 2, turnCount: 1 },
      }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('seals unfinished current tasks when the foreground turn becomes idle', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      messages: [
        { id: 'user-1', type: 'user_text', content: '执行任务后暂停', timestamp: 1000 },
        {
          id: 'task-create-1',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-1',
          input: { subject: '只读确认 README.md 存在' },
          timestamp: 1001,
        },
        {
          id: 'task-create-result-1',
          type: 'tool_result',
          toolUseId: 'task-create-call-1',
          content: 'Task #1 created successfully: 只读确认 README.md 存在',
          isError: false,
          timestamp: 1002,
        },
        {
          id: 'task-create-2',
          type: 'tool_use',
          toolName: 'TaskCreate',
          toolUseId: 'task-create-call-2',
          input: { subject: '等待后续指令' },
          timestamp: 1003,
        },
        {
          id: 'task-create-result-2',
          type: 'tool_result',
          toolUseId: 'task-create-call-2',
          content: 'Task #2 created successfully: 等待后续指令',
          isError: false,
          timestamp: 1004,
        },
        {
          id: 'task-update-1',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-1',
          input: { taskId: '1', status: 'completed' },
          timestamp: 1005,
        },
        successfulTaskUpdateResult('task-update-call-1', '1', 1006),
        {
          id: 'task-update-2',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-2',
          input: { taskId: '2', status: 'in_progress' },
          timestamp: 1007,
        },
        successfulTaskUpdateResult('task-update-call-2', '2', 1008),
        { id: 'assistant-1', type: 'assistant_text', content: '已暂停，等待后续指令', timestamp: 1009 },
      ],
      tasks: [
        task({ id: '1', subject: '只读确认 README.md 存在', status: 'completed' }),
        task({ id: '2', subject: '等待后续指令', status: 'in_progress' }),
      ],
      completedAndDismissed: false,
      isForegroundTurnActive: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.sections.tasks.rows).toEqual([
      expect.objectContaining({ id: '1', status: 'completed' }),
      expect.objectContaining({ id: '2', status: 'stopped' }),
    ])
    expect(model.badgeCount).toBe(0)
  })

  it('does not show orphan non-agent notifications in the SubAgents section', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [
        notification({
          taskId: 'bg-bash-1',
          toolUseId: 'bash-tool-1',
          status: 'completed',
          summary: 'Task completed',
          outputFile: '/tmp/bg-test.log',
        }),
      ],
    })

    expect(model.sections.subagents.rows).toHaveLength(0)
    expect(model.sections.output.rows).toEqual([
      expect.objectContaining({ id: 'output-bash-tool-1', label: '/tmp/bg-test.log' }),
    ])
  })

  it('keeps untyped background command tasks out of the SubAgents section', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [
        background({
          taskId: 'bg-command-1',
          toolUseId: 'bg-command-tool-1',
          taskType: undefined,
          status: 'completed',
          description: 'Background command "npm test" completed',
          summary: 'Task completed',
          result: 'check passed',
          outputFile: '/tmp/bg-test.log',
        }),
      ],
      agentNotifications: [],
    })

    expect(model.sections.subagents.rows).toHaveLength(0)
    expect(model.sections.backgroundTasks.rows).toEqual([
      expect.objectContaining({
        id: 'bg-command-tool-1',
        label: 'Background command "npm test" completed',
      }),
    ])
  })

  it('does not erase background metadata when matching notification omits optional fields', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [
        background({
          taskId: 'agent-1',
          toolUseId: 'tool-1',
          status: 'running',
          summary: 'Still working',
          outputFile: '/tmp/background.md',
          usage: { totalTokens: 42, toolUses: 3 },
        }),
      ],
      agentNotifications: [
        {
          taskId: 'agent-1',
          toolUseId: 'tool-1',
          status: 'completed',
        },
      ],
    })

    expect(model.sections.subagents.rows).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        status: 'completed',
        summary: 'Still working',
        outputFile: '/tmp/background.md',
        usage: { totalTokens: 42, toolUses: 3 },
      }),
    ])
    expect(model.sections.output.rows).toEqual([
      expect.objectContaining({ id: 'output-tool-1', label: '/tmp/background.md' }),
    ])
  })

  it('suppresses dismissed completed task rows from the badge', () => {
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [task({ id: '1', status: 'completed' })],
      completedAndDismissed: true,
      backgroundTasks: [],
      agentNotifications: [],
    })

    expect(model.badgeCount).toBe(0)
    expect(model.sections.tasks.rows).toHaveLength(1)
  })

  it('filters dismissed finished background tasks but keeps later runs visible', () => {
    const dismissedTask = background({
      taskId: 'bg-1',
      toolUseId: 'tool-1',
      status: 'completed',
      taskType: 'local_bash',
      startedAt: 1000,
      description: 'Dismissed run',
    })
    const resumedTask = background({
      taskId: 'bg-1',
      toolUseId: 'tool-2',
      status: 'completed',
      taskType: 'local_bash',
      startedAt: 2000,
      description: 'Later run',
    })
    const runningTask = background({
      taskId: 'bg-2',
      toolUseId: 'tool-3',
      status: 'running',
      taskType: 'local_bash',
      startedAt: 1000,
      description: 'Still running',
    })

    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [dismissedTask, resumedTask, runningTask],
      dismissedBackgroundTaskKeys: new Set([createBackgroundTaskDismissKey(dismissedTask)]),
      agentNotifications: [],
    })

    expect(model.sections.backgroundTasks.rows).toEqual([
      expect.objectContaining({ label: 'Later run', dismissKey: createBackgroundTaskDismissKey(resumedTask) }),
      expect.objectContaining({ label: 'Still running', dismissKey: createBackgroundTaskDismissKey(runningTask) }),
    ])
    expect(model.badgeCount).toBe(1)
  })
})

describe('workflow section', () => {
  const AGENTS = [
    { type: 'workflow_agent', index: 1, label: 'survey response.js', state: 'done', phaseIndex: 1, phaseTitle: 'Survey', agentId: 'a11', tokens: 24_100 },
    { type: 'workflow_agent', index: 2, label: 'survey request.js', state: 'done', phaseIndex: 1, phaseTitle: 'Survey', agentId: 'a12' },
    { type: 'workflow_agent', index: 3, label: 'check response #1', state: 'progress', phaseIndex: 2, phaseTitle: 'Cross-check', agentId: 'a13' },
    // Queued: accepted by the runtime but never given a slot, so no transcript.
    { type: 'workflow_agent', index: 4, label: 'check response #2', state: 'start', phaseIndex: 2, phaseTitle: 'Cross-check' },
  ]

  function run(overrides: Record<string, unknown> = {}) {
    return {
      taskId: 'w1',
      sessionId: 'session-1',
      workflowName: 'route-survey',
      status: 'running',
      startedAt: 0,
      updatedAt: 0,
      agentCount: 4,
      totalTokens: 0,
      toolCalls: 0,
      progress: [
        { type: 'workflow_phase', index: 1, title: 'Survey' },
        { type: 'workflow_phase', index: 2, title: 'Cross-check' },
        ...AGENTS,
      ],
      ...overrides,
    } as never
  }

  function build() {
    return buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
      workflowRuns: [run()],
    })
  }

  it('lays each phase out as a header followed by its agents', () => {
    const rows = build().sections.workflow.rows
    expect(rows.map((row) => [row.label, row.groupProgress ? 'phase' : row.group])).toEqual([
      ['Survey', 'phase'],
      ['survey response.js', 'Survey'],
      ['survey request.js', 'Survey'],
      ['Cross-check', 'phase'],
      ['check response #1', 'Cross-check'],
      ['check response #2', 'Cross-check'],
    ])
  })

  it('counts settled agents on the phase header', () => {
    const headers = build().sections.workflow.rows.filter((row) => row.groupProgress)
    expect(headers[0]!.groupProgress).toEqual({ done: 2, total: 2 })
    expect(headers[0]!.status).toBe('completed')
    expect(headers[1]!.groupProgress).toEqual({ done: 0, total: 2 })
    expect(headers[1]!.status).toBe('running')
  })

  it('opens each agent through the ordinary subagent route', () => {
    // A workflow agent is a subagent run by the same runner, so the row carries
    // the reference the existing page opens with rather than anything bespoke.
    const rows = build().sections.workflow.rows
    const running = rows.find((row) => row.label === 'check response #1')!
    expect(running.openable).toBe(true)
    expect(running.toolUseId).toBe('agent:a13')

    // Queued agents have no transcript yet — offering to open one would 404.
    const queued = rows.find((row) => row.label === 'check response #2')!
    expect(queued.openable).toBe(false)
    expect(queued.toolUseId).toBeUndefined()
  })

  it('labels an unphased group with the run name instead of "Phase 0"', () => {
    // Runs recorded before phases were persisted come back ungrouped. The
    // workflow name identifies them; a bare index does not.
    const model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
      workflowRuns: [run({
        workflowName: 'review-last-month',
        progress: [
          { type: 'workflow_agent', index: 1, label: 'review:security', state: 'done', phaseIndex: 0, agentId: 'a1' },
        ],
      })],
    })
    const header = model.sections.workflow.rows.find((row) => row.groupProgress)!
    expect(header.label).toBe('review-last-month')
  })

  it('badges only the agents, never the phase headers', () => {
    // One running plus one queued agent. The Cross-check header is also
    // "running", but counting it would double-count the very agents beneath
    // it — the badge is a count of work, not of headings.
    expect(build().badgeCount).toBe(2)
  })

  it('shows the workflow above the individual subagents it spawned', () => {
    const order = getVisibleActivitySections(build()).map((section) => section.id)
    expect(order).toEqual(['workflow'])
  })
})

describe('getMainSessionActivityModel', () => {
  // The tab bar and the session page both derive the on-screen session's model
  // from the same store state, each rebuilding its own arrays and sets. The
  // model walks the whole transcript, so the second caller reuses the first.
  const todoMessages: UIMessage[] = [{
    id: 'todo-1',
    type: 'tool_use',
    toolName: 'TodoWrite',
    toolUseId: 'todo-1',
    input: { todos: [{ content: 'Add vehicle 401', status: 'in_progress' }] },
    timestamp: 1,
  }]
  const runningTask = background({ taskId: 'bg-1' })
  const input = (overrides: Partial<Parameters<typeof getMainSessionActivityModel>[0]> = {}) => ({
    sessionId: 'session-1',
    messages: todoMessages,
    tasks: [],
    teamTaskWindows: [{ startedAt: 10, endedAt: 20 }],
    completedAndDismissed: false,
    isForegroundTurnActive: true,
    backgroundTasks: [runningTask],
    dismissedBackgroundTaskKeys: new Set<string>(),
    agentNotifications: [],
    workflowRuns: [],
    ...overrides,
  })

  it('reuses the model for the same state passed through freshly built arrays and sets', () => {
    const first = getMainSessionActivityModel(input())
    const second = getMainSessionActivityModel(input())
    expect(second).toBe(first)
    expect(second).toEqual(buildMainSessionActivityModel(input()))
  })

  it.each([
    ['the transcript', { messages: [...todoMessages] }],
    ['the session', { sessionId: 'session-2' }],
    ['a background task', { backgroundTasks: [background({ taskId: 'bg-1', status: 'completed' })] }],
    ['a dismissed task', { dismissedBackgroundTaskKeys: new Set([createBackgroundTaskDismissKey(runningTask)]) }],
    ['the turn state', { isForegroundTurnActive: false }],
    ['when a team window ends', { teamTaskWindows: [{ startedAt: 10 }] }],
    ['when a team window starts', { teamTaskWindows: [{ startedAt: 11, endedAt: 20 }] }],
    ['an agent notification', { agentNotifications: [notification({})] }],
    ['the workflow runs', {
      workflowRuns: [{
        taskId: 'w1',
        sessionId: 'session-1',
        workflowName: 'vehicle-sweep',
        status: 'running',
        startedAt: 0,
        updatedAt: 0,
        agentCount: 1,
        totalTokens: 0,
        toolCalls: 0,
        progress: [{ type: 'workflow_agent', index: 1, label: 'check vehicle 401', state: 'progress', phaseIndex: 0, agentId: 'a1' }],
      } as unknown as WorkflowRun],
    }],
    ['the CLI tasks', { tasks: [task({ status: 'in_progress' })] }],
    ['the dismissal of finished tasks', { completedAndDismissed: true }],
  ])('rebuilds when %s changes', (_label, change) => {
    const first = getMainSessionActivityModel(input())
    const next = getMainSessionActivityModel(input(change))
    expect(next).not.toBe(first)
    expect(next).toEqual(buildMainSessionActivityModel(input(change)))
  })
})
