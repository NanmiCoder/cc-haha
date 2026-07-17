import { describe, expect, it } from 'vitest'
import {
  buildSessionActivityModel,
  getVisibleActivitySections,
  hasVisibleSessionActivity,
} from './sessionActivityModel'
import { createBackgroundTaskDismissKey } from '../../lib/backgroundTasks'
import type { BackgroundAgentTask, AgentTaskNotification, UIMessage } from '../../types/chat'
import type { CLITask } from '../../types/cliTask'

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
    expect(getVisibleActivitySections(model).map((section) => section.id)).toEqual([
      'tasks',
      'backgroundTasks',
      'subagents',
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
        {
          id: 'task-update-2',
          type: 'tool_use',
          toolName: 'TaskUpdate',
          toolUseId: 'task-update-call-2',
          input: { taskId: '2', status: 'in_progress', activeForm: '正在补充边界测试' },
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
        status: 'completed',
        taskHistory: { completed: 1, total: 2, turnCount: 1 },
      }),
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
