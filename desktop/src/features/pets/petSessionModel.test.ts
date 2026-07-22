import { describe, expect, it } from 'vitest'
import type { PerSessionState } from '../../stores/chatStore'
import type { SessionListItem } from '../../types/session'
import {
  buildPetSessionActivities,
  currentPetPreview,
  latestAssistantPreview,
  resolvePetSessionStatus,
} from './petSessionModel'

function session(id: string, modifiedAt: string): SessionListItem {
  return {
    id,
    title: id,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 1,
    projectPath: '/project',
    workDir: '/project',
    workDirExists: true,
  }
}

function chat(overrides: Partial<PerSessionState>): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingPermissions: {},
    pendingComputerUsePermission: null,
    pendingComputerUsePermissions: {},
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    elapsedTimer: null,
    ...overrides,
  }
}

describe('pet session activity model', () => {
  it('maps actionable states in priority order and treats completed review markers as idle', () => {
    const sessions = [
      session('idle', '2026-07-19T12:04:00Z'),
      session('running', '2026-07-19T12:03:00Z'),
      session('review', '2026-07-19T12:02:00Z'),
      session('failed', '2026-07-19T12:01:00Z'),
      session('waiting', '2026-07-19T12:00:00Z'),
    ]
    const activities = buildPetSessionActivities({
      sessions,
      chats: {
        waiting: chat({ chatState: 'permission_pending' }),
        failed: chat({ historyStatus: 'error' }),
        running: chat({ chatState: 'thinking' }),
        idle: chat({}),
        review: chat({}),
      },
      reviewSessionIds: new Set(['review']),
    })

    expect(activities.map(({ session: item, status }) => [item.id, status])).toEqual([
      ['waiting', 'waiting'],
      ['failed', 'failed'],
      ['running', 'running'],
      ['idle', 'idle'],
      ['review', 'idle'],
    ])
  })

  it('prefers active chat state over a stale review marker', () => {
    expect(resolvePetSessionStatus(chat({ chatState: 'streaming' }), true)).toBe('running')
  })

  it('keeps a turn error failed after chat state returns to idle', () => {
    const failedChat = chat({
      chatState: 'idle',
      messages: [{
        id: 'error-1',
        type: 'error',
        message: 'The turn failed',
        code: 'TURN_FAILED',
        timestamp: 1,
      }],
    })

    expect(resolvePetSessionStatus(failedChat, true)).toBe('failed')
    expect(resolvePetSessionStatus({ ...failedChat, chatState: 'thinking' }, true)).toBe('running')
  })

  it('lets live and observed work outrank a stale history-load error', () => {
    expect(resolvePetSessionStatus(
      chat({ chatState: 'thinking', historyStatus: 'error' }),
    )).toBe('running')
    expect(resolvePetSessionStatus(
      chat({ historyStatus: 'error' }),
      false,
      'waiting',
    )).toBe('waiting')
  })

  it('counts running background agents and ignores legacy review markers', () => {
    expect(resolvePetSessionStatus(chat({
      backgroundAgentTasks: {
        agent: {
          taskId: 'agent',
          status: 'running',
          startedAt: 1,
          updatedAt: 1,
        },
      },
    }))).toBe('running')

    const [activity] = buildPetSessionActivities({
      sessions: [session('remote', '2026-07-19T12:00:00Z')],
      chats: {},
      observedStatuses: { remote: 'review' },
    })
    expect(activity?.status).toBe('idle')
  })

  it('shows current streaming progress before the previous assistant reply', () => {
    expect(currentPetPreview(chat({
      streamingText: '  Writing\n tests… ',
      messages: [{ id: 'old', type: 'assistant_text', content: 'old reply', timestamp: 1 }],
    }))).toBe('Writing tests…')
    expect(currentPetPreview(chat({ statusVerb: 'Thinking' }))).toBe('Thinking')
  })

  it('extracts and bounds the latest assistant reply', () => {
    expect(latestAssistantPreview([
      { id: 'a', type: 'assistant_text', content: 'old', timestamp: 1 },
      { id: 'u', type: 'user_text', content: 'question', timestamp: 2 },
      { id: 'b', type: 'assistant_text', content: '  newest\nreply  ', timestamp: 3 },
    ])).toBe('newest reply')
    expect(latestAssistantPreview([
      { id: 'b', type: 'assistant_text', content: '123456789', timestamp: 3 },
    ], 6)).toBe('12345…')
  })
})
