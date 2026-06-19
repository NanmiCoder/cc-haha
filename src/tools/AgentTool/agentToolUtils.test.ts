import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { setIsInteractive } from '../../bootstrap/state.js'
import * as sdkEventQueue from '../../utils/sdkEventQueue.js'
import type { AppState } from '../../state/AppState.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import { createTaskStateBase } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../types/message.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  drainSdkEvents,
} from '../../utils/sdkEventQueue.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { extractAgentToolActivities, runAsyncAgentLifecycle } from './agentToolUtils.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/SyntheticOutputTool.js'

describe('runAsyncAgentLifecycle', () => {
  afterEach(() => {
    resetCommandQueue()
    drainSdkEvents()
    setIsInteractive(true)
  })

  test('emits progress for assistant text even when no tool is used', async () => {
    setIsInteractive(false)
    const taskId = 'agent-text-progress'
    const abortController = new AbortController()
    const task: LocalAgentTaskState = {
      ...createTaskStateBase(taskId, 'local_agent', 'Implement layout export', 'toolu_agent'),
      status: 'running',
      agentId: taskId,
      prompt: 'Implement layout export',
      agentType: 'general-purpose',
      abortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: { [taskId]: task },
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'I am planning the layout export.' }],
    }) as Message

    async function* makeStream(): AsyncGenerator<Message, void> {
      yield message
    }

    await runAsyncAgentLifecycle({
      taskId,
      abortController,
      makeStream,
      metadata: {
        prompt: 'Implement layout export',
        resolvedAgentModel: 'test-model',
        isBuiltInAgent: true,
        startTime: Date.now(),
        agentType: 'general-purpose',
        isAsync: true,
      },
      description: 'Implement layout export',
      toolUseContext: {
        options: { tools: [] },
        toolUseId: 'toolu_agent',
        getAppState: () => appState,
      } as unknown as ToolUseContext,
      rootSetAppState: setAppState,
      agentIdForCleanup: taskId,
      enableSummarization: false,
      getWorktreeResult: async () => ({}),
    })

    const progressEvent = drainSdkEvents().find(
      event => event.subtype === 'task_progress' && event.task_id === taskId,
    )
    expect(progressEvent).toBeDefined()
    expect(progressEvent).toMatchObject({
      subtype: 'task_progress',
      task_id: taskId,
      tool_use_id: 'toolu_agent',
      summary: 'Implement layout export',
    })
  })

  test('notifies the parent before post-completion cleanup finishes', async () => {
    const taskId = 'agent-notify-first'
    const abortController = new AbortController()
    const task: LocalAgentTaskState = {
      ...createTaskStateBase(taskId, 'local_agent', 'Review code', 'toolu_agent'),
      status: 'running',
      agentId: taskId,
      prompt: 'Review code',
      agentType: 'general-purpose',
      abortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: { [taskId]: task },
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'Review complete.' }],
    }) as Message
    let cleanupStarted = false

    async function* makeStream(): AsyncGenerator<Message, void> {
      yield message
    }

    const result = await Promise.race([
      runAsyncAgentLifecycle({
        taskId,
        abortController,
        makeStream,
        metadata: {
          prompt: 'Review code',
          resolvedAgentModel: 'test-model',
          isBuiltInAgent: true,
          startTime: Date.now(),
          agentType: 'general-purpose',
          isAsync: true,
        },
        description: 'Review code',
        toolUseContext: {
          options: { tools: [] },
          toolUseId: 'toolu_agent',
          getAppState: () => appState,
        } as unknown as ToolUseContext,
        rootSetAppState: setAppState,
        agentIdForCleanup: taskId,
        enableSummarization: false,
        getWorktreeResult: () => {
          cleanupStarted = true
          return new Promise(() => {})
        },
      }).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ])

    expect(result).toBe('completed')
    expect(cleanupStarted).toBe(true)
    expect(appState.tasks[taskId]?.status).toBe('completed')
    expect(getCommandQueue()).toHaveLength(1)
    expect(String(getCommandQueue()[0]?.value)).toContain(
      '<status>completed</status>',
    )
    expect(String(getCommandQueue()[0]?.value)).toContain('Review complete.')
  })

  test('streams a background agent\'s tool activity tagged with the parent tool_use id', async () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const taskId = 'agent-activity'
      const abortController = new AbortController()
      const task: LocalAgentTaskState = {
        ...createTaskStateBase(taskId, 'local_agent', 'Probe', 'toolu_parent'),
        status: 'running',
        agentId: taskId,
        prompt: 'Probe',
        agentType: 'general-purpose',
        abortController,
        retrieved: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        isBackgrounded: true,
        pendingMessages: [],
        retain: false,
        diskLoaded: false,
      }
      let appState = {
        tasks: { [taskId]: task },
        toolPermissionContext: getEmptyToolPermissionContext(),
        speculation: IDLE_SPECULATION_STATE,
      } as unknown as AppState
      const setAppState = (updater: (prev: AppState) => AppState): void => {
        appState = updater(appState)
      }
      const toolUseMsg = createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'ls' } },
        ],
      }) as Message
      const toolResultMsg = createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_child', content: 'files', is_error: false },
        ],
      }) as Message
      async function* makeStream(): AsyncGenerator<Message, void> {
        yield toolUseMsg
        yield toolResultMsg
      }

      await Promise.race([
        runAsyncAgentLifecycle({
          taskId,
          abortController,
          makeStream,
          metadata: {
            prompt: 'Probe',
            resolvedAgentModel: 'test-model',
            isBuiltInAgent: true,
            startTime: Date.now(),
            agentType: 'general-purpose',
            isAsync: true,
          },
          description: 'Probe',
          toolUseContext: {
            options: { tools: [] },
            toolUseId: 'toolu_parent',
            getAppState: () => appState,
          } as unknown as ToolUseContext,
          rootSetAppState: setAppState,
          agentIdForCleanup: taskId,
          enableSummarization: false,
          getWorktreeResult: () => new Promise(() => {}),
        }).then(() => 'completed'),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
      ])

      expect(emitSpy.mock.calls).toContainEqual([
        taskId,
        'toolu_parent',
        { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_child', input: { command: 'ls' } },
      ])
      expect(emitSpy.mock.calls).toContainEqual([
        taskId,
        'toolu_parent',
        { kind: 'tool_result', tool_use_id: 'toolu_child', content: 'files', is_error: false },
      ])
    } finally {
      emitSpy.mockRestore()
    }
  })
})

describe('extractAgentToolActivities', () => {
  test('extracts tool_use blocks from an assistant message', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'text', text: 'Running a command' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'ls' } },
    ])
  })

  test('skips the internal StructuredOutput tool', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: SYNTHETIC_OUTPUT_TOOL_NAME, input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/a' } },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'toolu_2', input: { file_path: '/a' } },
    ])
  })

  test('extracts tool_result blocks from a user message', () => {
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'output', is_error: false },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_result', tool_use_id: 'toolu_1', content: 'output', is_error: false },
    ])
  })

  test('marks errored tool_result blocks', () => {
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
    ])
  })

  test('returns empty for string-only user content', () => {
    const message = createUserMessage({ content: 'just text' }) as Message
    expect(extractAgentToolActivities(message)).toEqual([])
  })

  test('returns empty for an assistant message with no tool_use', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'no tools here' }],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([])
  })
})
