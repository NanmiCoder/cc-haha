import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendReplayedUserMessage, createDefaultSessionState, mapHistoryMessagesToUiMessages, useChatStore } from './chatStore'
import { useTaskStore } from './taskStore'
import type { ScheduledTaskTrigger, TaskNotificationPolicy } from '@/types/task'
import type { UIMessage } from '@/types/chat'
import { wsManager } from '@/api/websocket'
import { sessionsApi } from '@/api/sessions'
import { useWorkflowStore } from './workflowStore'

const { notify } = vi.hoisted(() => ({ notify: vi.fn(async () => true) }))
vi.mock('@/lib/desktopNotifications', () => ({ notifyDesktop: notify }))

const scheduledTask = { taskId: 'task', runId: 'run', taskName: 'Check build', scheduledFor: '2030-01-01T01:00:00Z' }

describe('trusted scheduled trigger metadata', () => {
  it('deduplicates by run ID without collapsing distinct scheduled runs with the same prompt', () => {
    const first = appendReplayedUserMessage([], 'Check build', 1, undefined, undefined, scheduledTask)
    expect(first[0]).toMatchObject({ type: 'user_text', scheduledTask })
    expect(appendReplayedUserMessage(first, 'Check build', 2, undefined, undefined, scheduledTask)).toBe(first)
    expect(appendReplayedUserMessage(first, 'Check build', 3, undefined, undefined, { ...scheduledTask, runId: 'run-2' })).toHaveLength(2)
  })

  it('keeps the same metadata after history loads for string and text-block inputs', () => {
    for (const content of ['Check build', [{ type: 'text', text: 'Check build' }]]) {
      const history = mapHistoryMessagesToUiMessages([{ id: 'message', type: 'user', content, scheduledTask, timestamp: '2030-01-01T01:00:00Z' }])
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ type: 'user_text', scheduledTask })
    }
  })

  it('never upgrades user-authored text into a trusted scheduled event', () => {
    const content = JSON.stringify({ scheduledTask })
    const replay = appendReplayedUserMessage([], content, 1)
    expect(replay[0]).not.toHaveProperty('scheduledTask')
    const history = mapHistoryMessagesToUiMessages([{ id: 'message', type: 'user', content, timestamp: '2030-01-01T01:00:00Z' }])
    expect(history[0]).not.toHaveProperty('scheduledTask')
  })
})

describe('scheduled turn completion notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    notify.mockClear()
    useChatStore.setState({ sessions: { target: {
      ...createDefaultSessionState(), connectionState: 'connected',
      historyBootstrapDisabled: true, chatState: 'thinking',
    } } })
  })
  afterEach(() => {
    useChatStore.setState({ sessions: {} })
    useTaskStore.setState({ tasks: [] })
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const replayScheduled = () => useChatStore.getState().handleServerMessage('target', {
    type: 'user_message_replay', content: 'Check build', scheduledTask,
  })
  const complete = (text = 'No change', completedScheduledTask?: ScheduledTaskTrigger) => {
    useChatStore.setState(state => ({ sessions: { ...state.sessions, target: {
      ...state.sessions.target!, chatState: 'streaming', streamingText: text,
    } } }))
    useChatStore.getState().handleServerMessage('target', { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 },
      ...(completedScheduledTask ? { scheduledTask: completedScheduledTask } : {}),
    })
  }

  // Scheduled notifications already have their own policy-aware polling path.
  // The ordinary reply path used to notify too, bypassing even `none`/`silent`.
  it.each<TaskNotificationPolicy>(['none', 'failed', 'important', 'all'])('leaves %s scheduled notifications to the task notifier', policy => {
    useTaskStore.setState({ tasks: [{ id: 'task', name: 'Check build', prompt: 'Check', cron: '* * * * *', createdAt: 1, enabled: true,
      notificationPolicy: policy, notification: { enabled: policy !== 'none', channels: ['desktop'] } }] })
    replayScheduled()
    complete()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not let a queued user guide enable generic notifications for the running scheduled turn', () => {
    replayScheduled()
    useChatStore.getState().handleServerMessage('target', { type: 'user_message_replay', content: 'Also check the tests' })
    complete()
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies normally for the next ordinary turn after a scheduled turn', () => {
    replayScheduled()
    complete()
    notify.mockClear()
    useChatStore.getState().handleServerMessage('target', { type: 'user_message_replay', content: 'Explain the result' })
    complete('Here is the explanation')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ cooldownScope: 'agent-completion', body: 'Here is the explanation' }))
  })

  it.each([true, false])('uses the current history turn, not any old scheduled message (current scheduled: %s)', currentScheduled => {
    const messages = mapHistoryMessagesToUiMessages([{ id: 'trigger', type: 'user', content: 'Check', scheduledTask, timestamp: '2030-01-01T01:00:00Z' }])
    if (!currentScheduled) messages.push({ id: 'human', type: 'user_text', content: 'Explain', timestamp: 2 })
    messages.push({ id: 'queued', type: 'user_text', content: 'Not yet consumed', timestamp: 3, optimisticQueued: true } as UIMessage)
    // A previous completed turn can leave the in-memory marker false while
    // newly loaded history belongs to a scheduled turn started while offline.
    useChatStore.setState(state => ({ sessions: { target: { ...state.sessions.target!, messages, scheduledTaskTurn: false } } }))
    complete()
    expect(notify).toHaveBeenCalledTimes(currentScheduled ? 0 : 1)
  })

  it.each([
    { currentScheduled: true, failed: false },
    { currentScheduled: true, failed: true },
    { currentScheduled: false, failed: false },
  ])('reconciles completion provenance after a consumed guide and reconnect ($currentScheduled / failed: $failed)', async ({ currentScheduled, failed }) => {
    let onConnectionState!: Parameters<typeof wsManager.onConnectionState>[1]
    vi.spyOn(wsManager, 'connect').mockImplementation(() => {})
    vi.spyOn(wsManager, 'clearHandlers').mockImplementation(() => {})
    vi.spyOn(wsManager, 'onMessage').mockImplementation(() => () => {})
    vi.spyOn(wsManager, 'onConnectionState').mockImplementation((_id, callback) => {
      onConnectionState = callback
      return () => {}
    })
    vi.spyOn(useWorkflowStore.getState(), 'hydrateSession').mockResolvedValue()
    vi.spyOn(sessionsApi, 'getFullHistory').mockResolvedValue({ messages: [{
      id: 'history-input', type: 'user', content: 'Current input', timestamp: '2030-01-01T01:00:00Z',
      ...(currentScheduled ? { scheduledTask } : {}),
    }, ...(currentScheduled ? [{ id: 'consumed-guide', type: 'user' as const, content: 'Also check tests', timestamp: '2030-01-01T01:01:00Z' }] : [])] })
    useChatStore.setState(state => ({ sessions: { target: {
      ...state.sessions.target!, connectionState: 'disconnected', scheduledTaskTurn: true,
    } } }))
    useChatStore.getState().connectToSession('target', { minimalBootstrap: true, prewarm: false, applyRuntimeSelection: false })
    expect(useChatStore.getState().sessions.target!.scheduledTaskTurn).toBeUndefined()
    onConnectionState('connected')
    useChatStore.setState(state => ({ sessions: { target: {
      ...state.sessions.target!, historyHydrated: true, scheduledTaskTurn: !currentScheduled,
    } } }))
    onConnectionState('reconnecting')
    expect(useChatStore.getState().sessions.target!.scheduledTaskTurn).toBeUndefined()
    await useChatStore.getState().loadHistory('target')
    expect(useChatStore.getState().sessions.target!.messages.some(message => message.type === 'user_text' && message.content === 'Current input')).toBe(true)
    if (failed) useChatStore.getState().handleServerMessage('target', { type: 'error', message: 'Scheduled check failed', code: 'SDK_ERROR' })
    // The latest durable user input is a human guide; only the host knows that
    // this result still terminates the scheduled run after renderer reconnect.
    complete(failed ? 'Check failed' : 'No change', currentScheduled ? scheduledTask : undefined)
    expect(notify).toHaveBeenCalledTimes(currentScheduled ? 0 : 1)
  })
})
