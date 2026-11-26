import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSessionState, useChatStore, type PerSessionState } from './chatStore'
import { useQueueSendPreferenceStore } from './queueSendPreferenceStore'
import { useTabStore } from './tabStore'
import { wsManager } from '@/api/websocket'

const QUEUE_SESSION = 'session-queue-auto-send'

function sessionState(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    ...createDefaultSessionState(),
    connectionState: 'connected',
    historyHydrated: true,
    historyStatus: 'ready',
    historyBootstrapDisabled: true,
    ...overrides,
  }
}

function queue(content: string): string {
  const id = useChatStore.getState().queueUserMessage(QUEUE_SESSION, {
    content,
    displayContent: content,
  })
  return id
}

function queuedContents(): string[] {
  return (useChatStore.getState().sessions[QUEUE_SESSION]?.queuedUserMessages ?? [])
    .map((message) => message.content)
}

function sentContents(): string[] {
  return vi.mocked(wsManager.send).mock.calls
    .map(([, message]) => message)
    .filter((message) => message.type === 'user_message')
    .map((message) => message.content)
}

function completeTurn(): void {
  useChatStore.getState().handleServerMessage(QUEUE_SESSION, {
    type: 'message_complete',
    usage: { input_tokens: 1, output_tokens: 2 },
  })
}

describe('queued prompt auto-send (#1988, #2002)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(wsManager, 'send').mockImplementation(() => {})
    useQueueSendPreferenceStore.setState({ sendQueuedMessagesAtOnce: false })
    useChatStore.setState({
      sessions: { [QUEUE_SESSION]: sessionState({ chatState: 'streaming' }) },
    })
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  afterEach(() => {
    const session = useChatStore.getState().sessions[QUEUE_SESSION]
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
    useChatStore.setState({ sessions: {} })
    useTabStore.setState({ tabs: [], activeTabId: null })
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sends one queued prompt per turn by default and keeps the rest queued', () => {
    queue('first follow-up')
    queue('second follow-up')

    completeTurn()

    expect(sentContents()).toEqual(['first follow-up'])
    expect(queuedContents()).toEqual(['second follow-up'])
    expect(useChatStore.getState().sessions[QUEUE_SESSION]?.chatState).not.toBe('idle')

    completeTurn()

    expect(sentContents()).toEqual(['first follow-up', 'second follow-up'])
    expect(queuedContents()).toEqual([])
  })

  it('keeps the batch behavior when the preference is enabled', () => {
    useQueueSendPreferenceStore.setState({ sendQueuedMessagesAtOnce: true })
    queue('first follow-up')
    queue('second follow-up')

    completeTurn()

    expect(sentContents()).toEqual(['first follow-up', 'second follow-up'])
    expect(queuedContents()).toEqual([])
  })

  it('drains a queue stranded by a missed completion when an idle snapshot arrives', () => {
    // The prompt was queued while the turn ran, then the socket dropped and
    // message_complete never reached this renderer. The reconnect snapshot is
    // authoritative: the session is idle, so the queue must resume (#1988).
    useChatStore.setState({
      sessions: {
        [QUEUE_SESSION]: sessionState({
          chatState: 'thinking',
          awaitingReconnectSync: true,
        }),
      },
    })
    queue('queued across the gap')
    queue('still behind it')

    useChatStore.getState().handleServerMessage(QUEUE_SESSION, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })

    expect(sentContents()).toEqual(['queued across the gap'])
    expect(queuedContents()).toEqual(['still behind it'])
  })

  it('pauses automatic sending after a failed turn until the user acts', () => {
    queue('after the failure')
    queue('behind it')

    useChatStore.getState().handleServerMessage(QUEUE_SESSION, {
      type: 'error',
      message: 'provider failed',
      code: 'CLI_ERROR',
    })
    completeTurn()

    expect(useChatStore.getState().sessions[QUEUE_SESSION]?.queuedMessagesPaused).toBe('turn-error')
    expect(sentContents()).toEqual([])
    expect(queuedContents()).toEqual(['after the failure', 'behind it'])

    const firstId = useChatStore.getState().sessions[QUEUE_SESSION]!.queuedUserMessages![0]!.id
    useChatStore.getState().sendQueuedUserMessage(QUEUE_SESSION, firstId)

    expect(sentContents()).toEqual(['after the failure'])
    expect(queuedContents()).toEqual(['behind it'])
    expect(useChatStore.getState().sessions[QUEUE_SESSION]?.queuedMessagesPaused).toBeUndefined()
  })

  it('changes the send order without sending anything', () => {
    queue('A')
    queue('B')
    queue('C')
    const cId = useChatStore.getState().sessions[QUEUE_SESSION]!.queuedUserMessages![2]!.id

    useChatStore.getState().reorderQueuedUserMessage(QUEUE_SESSION, cId, 0)

    expect(queuedContents()).toEqual(['C', 'A', 'B'])
    expect(sentContents()).toEqual([])

    completeTurn()

    expect(sentContents()).toEqual(['C'])
    expect(queuedContents()).toEqual(['A', 'B'])
  })

  it('flushes an idle queue on demand, one prompt at a time', () => {
    useChatStore.setState({
      sessions: { [QUEUE_SESSION]: sessionState({ chatState: 'idle' }) },
    })
    queue('stranded one')
    queue('stranded two')

    useChatStore.getState().flushQueuedUserMessages(QUEUE_SESSION)

    expect(sentContents()).toEqual(['stranded one'])
    expect(queuedContents()).toEqual(['stranded two'])
  })
})
