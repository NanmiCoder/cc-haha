// A session socket is what keeps its CLI and MCP servers alive on the server,
// which reclaims a runtime only after the last client socket closes (#1485).
// These tests drive the real wsManager, chat store and tab store on top of a
// fake WebSocket that answers heartbeats, so they see when a socket really
// closes. On the desktop a chat leaves the screen by dropping out of the warm
// set: the shown chat and the three used before it (WARM_SESSION_LIMIT).
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const notifyDesktopMock = vi.hoisted(() => vi.fn())
const discardSideChatMock = vi.hoisted(() => vi.fn(async () => ({})))
const sessionsApiMock = vi.hoisted(() => ({
  delete: vi.fn(() => Promise.resolve()),
  getSlashCommands: vi.fn(async () => ({ commands: [] })),
  getFullHistory: vi.fn(async () => ({ messages: [] })),
  getHistoryPage: vi.fn(async () => ({ messages: [] })),
  getHistoryRecovery: vi.fn(async () => ({ status: 'incomplete', messages: [] })),
}))

vi.mock('../api/sessions', () => ({ sessionsApi: sessionsApiMock }))
vi.mock('../api/sideChats', () => ({ sideChatsApi: { discard: discardSideChatMock } }))
vi.mock('../api/teams', () => ({ teamsApi: { getWorkbenchForSession: vi.fn() } }))
vi.mock('../lib/desktopNotifications', () => ({ notifyDesktop: notifyDesktopMock }))

import { wsManager } from '../api/websocket'
import { useChatStore } from './chatStore'
import { installHiddenSessionRelease, RELEASED_TRANSCRIPT_LIMIT } from './hiddenSessionRelease'
import { registerSideChatSession, unregisterSideChatSession } from '../lib/sideChatSessions'
import { WARM_SESSION_LIMIT, useTabStore, type Tab } from './tabStore'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { useSideChatStore } from './sideChatStore'
import { navigateMobileUp } from '../components/mobile/mobileNavigation'
import type { ServerMessage } from '../types/chat'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: Array<{ type: string }> = []
  closedByClient = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    const message = JSON.parse(data) as { type: string }
    this.sent.push(message)
    // A healthy server answers the heartbeat, so only the client can end it.
    if (message.type === 'ping') {
      setTimeout(() => {
        if (this.readyState === FakeWebSocket.OPEN) this.receive({ type: 'pong' })
      }, 0)
    }
  }

  close() {
    this.closedByClient = true
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

function socketsFor(sessionId: string) {
  return FakeWebSocket.instances.filter((socket) => socket.url.includes(`/ws/${sessionId}`))
}

function isHeld(sessionId: string) {
  return wsManager.getConnectedSessionIds().includes(sessionId)
}

function sessionTab(sessionId: string, title: string): Tab {
  return { sessionId, title, type: 'session', status: 'idle' }
}

function connect(sessionId: string) {
  act(() => {
    useChatStore.getState().connectToSession(sessionId, {
      minimalBootstrap: true,
      prewarm: false,
      applyRuntimeSelection: false,
    })
  })
  const sockets = socketsFor(sessionId)
  const socket = sockets[sockets.length - 1]!
  act(() => socket.open())
  return socket
}

function serverSays(socket: FakeWebSocket, message: ServerMessage) {
  act(() => socket.receive(message))
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

/** Open enough other chats that `sessionId` drops out of the warm set. */
function moveOnFrom(sessionId: string) {
  act(() => {
    for (let index = 0; index < WARM_SESSION_LIMIT; index += 1) {
      useTabStore.getState().openTab(`next-${index}`, `Next ${index}`)
    }
  })
  expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === sessionId)).toBe(false)
}

/** Released, but the conversation, draft and queue are still there to come back to. */
function expectReleasedWithTranscript(sessionId: string) {
  expect(isHeld(sessionId)).toBe(false)
  expect(useChatStore.getState().sessions[sessionId]?.connectionState).toBe('disconnected')
}

/** What the server forwards from the CLI's `session_state_changed`. */
function cliRun(state: 'running' | 'idle'): ServerMessage {
  return {
    type: 'system_notification',
    subtype: 'session_state_changed',
    data: { type: 'system', subtype: 'session_state_changed', state },
  }
}

function replyText(text: string): ServerMessage[] {
  return [{ type: 'content_start', blockType: 'text' }, { type: 'content_delta', text }]
}

function shellTask(subtype: 'task_started' | 'task_notification', taskId: string): ServerMessage {
  return {
    type: 'system_notification',
    subtype,
    data: {
      task_id: taskId,
      tool_use_id: `${taskId}-tool`,
      task_type: 'local_bash',
      description: 'npm test',
      ...(subtype === 'task_notification' ? { status: 'completed', summary: 'exited 0' } : {}),
    },
  }
}

const TURN_COMPLETE: ServerMessage = { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } }
const EIGHTEEN_HOURS_MS = 18 * 60 * 60 * 1000

describe('releasing sessions that no tab shows (#1485)', () => {
  const originalWebSocket = globalThis.WebSocket
  let disconnectSpy: ReturnType<typeof vi.spyOn>
  let uninstall: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    wsManager.disconnectAll()
    disconnectSpy = vi.spyOn(wsManager, 'disconnect')
    notifyDesktopMock.mockClear()
    discardSideChatMock.mockClear()
    useSideChatStore.setState({ entries: {} })
    uninstall = installHiddenSessionRelease(useChatStore)

    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserverMock })

    useTabStore.setState({ tabs: [], activeTabId: null })
    useChatStore.setState({ sessions: {} } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({ sessions: [], activeSessionId: null } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useTeamStore.setState({ teamNameBySession: {} })
  })

  afterEach(() => {
    cleanup()
    uninstall()
    disconnectSpy.mockRestore()
    wsManager.disconnectAll()
    vi.clearAllTimers()
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('releases a chat that left the warm set mid-run once its CLI run ends, after notifying', async () => {
    useTabStore.setState({ tabs: [sessionTab('busy', 'Busy chat')], activeTabId: 'busy' })
    const socket = connect('busy')
    serverSays(socket, cliRun('running'))
    serverSays(socket, { type: 'status', state: 'thinking', verb: 'Thinking' })

    moveOnFrom('busy')
    await settle()

    // Still working: moving on never stops a run.
    expect(isHeld('busy')).toBe(true)

    for (const message of replyText('Refactor finished.')) serverSays(socket, message)
    serverSays(socket, TURN_COMPLETE)
    // The completion notification still comes from this socket.
    expect(notifyDesktopMock).toHaveBeenCalledTimes(1)
    await settle()
    expect(isHeld('busy')).toBe(true)

    serverSays(socket, cliRun('idle'))
    await settle()

    // Nothing is left to do: release it, so the server can reclaim the CLI.
    expect(disconnectSpy).toHaveBeenCalledWith('busy')
    expect(socket.closedByClient).toBe(true)
    expectReleasedWithTranscript('busy')
    const text = useChatStore.getState().sessions.busy?.messages
      .map((message) => message.type === 'assistant_text' ? message.content : '').join('')
    expect(text).toContain('Refactor finished.')
    act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })
    expect(socketsFor('busy')).toHaveLength(1)
  })

  it('stays for the reply a finished background task triggers and notifies it before releasing', async () => {
    useTabStore.setState({ tabs: [sessionTab('builder', 'Build chat')], activeTabId: 'builder' })
    const socket = connect('builder')
    serverSays(socket, cliRun('running'))
    serverSays(socket, { type: 'status', state: 'thinking' })
    serverSays(socket, shellTask('task_started', 'tests'))
    serverSays(socket, TURN_COMPLETE)

    moveOnFrom('builder')
    await settle()
    expect(isHeld('builder')).toBe(true)

    // The shell ends first; the CLI then replies about it in the same run.
    serverSays(socket, shellTask('task_notification', 'tests'))
    await settle()
    expect(isHeld('builder')).toBe(true)

    notifyDesktopMock.mockClear()
    serverSays(socket, { type: 'status', state: 'thinking' })
    for (const message of replyText('All 412 tests passed.')) serverSays(socket, message)
    serverSays(socket, TURN_COMPLETE)
    expect(notifyDesktopMock).toHaveBeenCalledTimes(1)
    await settle()
    expect(isHeld('builder')).toBe(true)

    serverSays(socket, cliRun('idle'))
    await settle()
    expect(isHeld('builder')).toBe(false)
  })

  it('releases at once a chat whose turn was already done when it left the warm set', async () => {
    useTabStore.setState({ tabs: [sessionTab('racing', 'Racing chat')], activeTabId: 'racing' })
    const socket = connect('racing')
    serverSays(socket, { type: 'status', state: 'tool_executing' })
    serverSays(socket, TURN_COMPLETE)

    moveOnFrom('racing')
    await settle()

    expect(socket.closedByClient).toBe(true)
    expectReleasedWithTranscript('racing')
  })

  it('keeps every chat in the warm set connected however long it sits idle', async () => {
    const warm = ['w1', 'w2', 'w3', 'w4']
    for (const id of warm) {
      act(() => useTabStore.getState().openTab(id, id))
      const socket = connect(id)
      serverSays(socket, cliRun('running'))
      serverSays(socket, TURN_COMPLETE)
      serverSays(socket, cliRun('idle'))
    }
    await settle()
    act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })

    expect(warm.map(isHeld)).toEqual([true, true, true, true])
    expect(disconnectSpy).not.toHaveBeenCalled()

    // A fifth chat pushes out the least recently shown one, and only that one.
    act(() => useTabStore.getState().openTab('w5', 'w5'))
    connect('w5')
    await settle()
    expect(['w1', 'w2', 'w3', 'w4', 'w5'].map(isHeld)).toEqual([false, true, true, true, true])
    expectReleasedWithTranscript('w1')
  })

  it('keeps a hidden session while it waits on the user, and releases it once that turn ends', async () => {
    useTabStore.setState({ tabs: [sessionTab('asking', 'Asking chat')], activeTabId: 'asking' })
    const socket = connect('asking')
    serverSays(socket, { type: 'status', state: 'thinking' })

    moveOnFrom('asking')
    serverSays(socket, { type: 'permission_request', requestId: 'req-1', toolName: 'Bash', input: { command: 'rm -rf build' } })
    await settle()
    act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })

    // The prompt is the user's move; its notification is the way back in.
    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'permission:req-1' }))
    expect(useChatStore.getState().sessions.asking?.chatState).toBe('permission_pending')
    expect(isHeld('asking')).toBe(true)

    serverSays(socket, { type: 'permission_resolved', requestId: 'req-1', permissionType: 'tool', allowed: true })
    serverSays(socket, TURN_COMPLETE)
    await settle()

    expect(isHeld('asking')).toBe(false)
  })

  it('keeps a hidden session waiting on a Computer Use approval', async () => {
    useTabStore.setState({ tabs: [sessionTab('desk', 'Desktop chat')], activeTabId: 'desk' })
    const socket = connect('desk')
    serverSays(socket, { type: 'status', state: 'thinking' })

    moveOnFrom('desk')
    serverSays(socket, {
      type: 'computer_use_permission_request',
      requestId: 'cu-1',
      request: { requestId: 'cu-1', reason: 'Open Finder', apps: [], requestedFlags: {}, screenshotFiltering: 'none' },
    })
    await settle()
    act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })

    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'computer-use-permission:cu-1' }))
    expect(useChatStore.getState().sessions.desk?.pendingComputerUsePermission?.requestId).toBe('cu-1')
    expect(isHeld('desk')).toBe(true)
  })

  it('sends a message queued behind the finishing turn instead of releasing the session', async () => {
    useTabStore.setState({ tabs: [sessionTab('queued', 'Queued chat')], activeTabId: 'queued' })
    const socket = connect('queued')
    serverSays(socket, { type: 'status', state: 'thinking' })
    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          queued: {
            ...state.sessions.queued!,
            queuedUserMessages: [{ id: 'q-1', content: 'and then run the tests', displayContent: 'and then run the tests', createdAt: 1 }],
          },
        },
      }))
    })

    moveOnFrom('queued')
    serverSays(socket, TURN_COMPLETE)
    await settle()

    expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'user_message', content: 'and then run the tests' }))
    expect(useChatStore.getState().sessions.queued?.chatState).not.toBe('idle')
    expect(isHeld('queued')).toBe(true)
  })

  it('does not let a task the session still shows hold it once the CLI reports idle', async () => {
    useTabStore.setState({ tabs: [sessionTab('ghost', 'Old chat')], activeTabId: 'ghost' })
    const socket = connect('ghost')
    // A task restored from a transcript without its terminal record.
    serverSays(socket, shellTask('task_started', 'stale-shell'))

    // An idle chat still counts as running while it shows a background shell.
    moveOnFrom('ghost')
    await settle()
    expect(isHeld('ghost')).toBe(true)

    // A later run ends: the CLI has nothing left, whatever the stale row says.
    serverSays(socket, cliRun('running'))
    serverSays(socket, cliRun('idle'))
    await settle()

    expectReleasedWithTranscript('ghost')
  })

  it('keeps a team lead and releases it only once its team is gone', async () => {
    useTabStore.setState({ tabs: [sessionTab('lead', 'Lead chat')], activeTabId: 'lead' })
    const socket = connect('lead')
    useTeamStore.setState({ teamNameBySession: { lead: 'review-team' } })
    serverSays(socket, cliRun('running'))
    serverSays(socket, { type: 'status', state: 'thinking' })

    moveOnFrom('lead')
    serverSays(socket, TURN_COMPLETE)
    serverSays(socket, cliRun('idle'))
    await settle()

    // Members ask for approval and report through the lead's socket only.
    expect(isHeld('lead')).toBe(true)

    act(() => useTeamStore.setState({ teamNameBySession: {} }))
    await settle()
    expect(isHeld('lead')).toBe(false)
  })

  it('keeps a session while its team workbench or a subagent page still reads it', async () => {
    useTabStore.setState({
      tabs: [
        { sessionId: 'team:source', title: 'Agent Teams', type: 'team', status: 'idle', teamLeadSessionId: 'source', sourceSessionId: 'source' },
        { sessionId: 'subagent:source__tool-1', title: 'SubAgent', type: 'subagent', status: 'idle', sourceSessionId: 'source', subagentToolUseId: 'tool-1' },
      ],
      activeTabId: 'subagent:source__tool-1',
    })
    const socket = connect('source')
    serverSays(socket, cliRun('running'))
    serverSays(socket, { type: 'status', state: 'thinking' })
    serverSays(socket, TURN_COMPLETE)
    serverSays(socket, cliRun('idle'))
    await settle()
    expect(isHeld('source')).toBe(true)

    act(() => useTabStore.getState().closeTab('team:source'))
    await settle()
    expect(isHeld('source')).toBe(true)

    act(() => useTabStore.getState().closeTab('subagent:source__tool-1'))
    await settle()
    expect(isHeld('source')).toBe(false)
  })

  it.each([
    { scope: 'open-tabs' as const, finishesWhileHidden: false },
    { scope: 'open-tabs' as const, finishesWhileHidden: true },
    { scope: 'active-tab' as const, finishesWhileHidden: false },
    { scope: 'active-tab' as const, finishesWhileHidden: true },
  ])('keeps a temporary side chat usable until explicitly closed ($scope, finishes while hidden: $finishesWhileHidden)', async ({ scope, finishesWhileHidden }) => {
    uninstall()
    uninstall = installHiddenSessionRelease(useChatStore, { scope })
    registerSideChatSession('side-of-parent', 'parent')
    try {
      useSideChatStore.setState({ entries: {
        'side-of-parent': { sessionId: 'side-of-parent', parentSessionId: 'parent', workDir: '/repo', title: 'Side chat', ephemeral: true },
      } })
      useTabStore.setState({ tabs: [sessionTab('parent', 'Parent chat')], activeTabId: 'parent' })
      const parentSocket = connect('parent')
      const sideSocket = connect('side-of-parent')
      serverSays(parentSocket, TURN_COMPLETE)
      serverSays(sideSocket, cliRun('running'))
      serverSays(sideSocket, { type: 'status', state: 'thinking' })
      for (const message of replyText('Side chat context.')) serverSays(sideSocket, message)
      if (!finishesWhileHidden) {
        serverSays(sideSocket, TURN_COMPLETE)
        serverSays(sideSocket, cliRun('idle'))
      }
      await settle()

      moveOnFrom('parent')
      await settle()
      expect(isHeld('parent')).toBe(false)
      if (finishesWhileHidden) {
        serverSays(sideSocket, TURN_COMPLETE)
        serverSays(sideSocket, cliRun('idle'))
      }
      await settle()
      // #1513 released this socket when the parent left the warm set. The
      // server then destroyed the non-persistent CLI after its idle grace,
      // and a later send failed with SESSION_DELETED despite cached messages.
      act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })
      await settle()
      expect(sideSocket.closedByClient).toBe(false)
      expect(isHeld('side-of-parent')).toBe(true)
      expect(disconnectSpy).not.toHaveBeenCalledWith('side-of-parent')

      act(() => useTabStore.getState().openTab('parent', 'Parent chat'))
      act(() => useChatStore.getState().sendMessage('side-of-parent', 'Continue the side chat'))
      expect(socketsFor('side-of-parent')).toEqual([sideSocket])
      expect(sideSocket.sent).toContainEqual(expect.objectContaining({ type: 'user_message', content: 'Continue the side chat' }))
      expect(useChatStore.getState().sessions['side-of-parent']?.messages).toContainEqual(expect.objectContaining({ type: 'assistant_text', content: 'Side chat context.' }))
      serverSays(sideSocket, TURN_COMPLETE)
      serverSays(sideSocket, cliRun('idle'))
      await settle()

      await act(async () => { await useSideChatStore.getState().close('side-of-parent') })
      expect(discardSideChatMock).toHaveBeenCalledWith('parent', 'side-of-parent')
      expect(sideSocket.closedByClient).toBe(true)
      expect(isHeld('side-of-parent')).toBe(false)
      expect(useChatStore.getState().sessions['side-of-parent']).toBeUndefined()
      expect(useSideChatStore.getState().entries['side-of-parent']).toBeUndefined()
    } finally {
      unregisterSideChatSession('side-of-parent')
    }
  })

  it(`keeps at most ${RELEASED_TRANSCRIPT_LIMIT} released conversations, never dropping one with something unsent`, async () => {
    const ids = Array.from({ length: RELEASED_TRANSCRIPT_LIMIT + 3 }, (_, index) => `released-${index}`)
    for (const id of ids) {
      const socket = connect(id)
      if (id === 'released-1') {
        act(() => {
          useChatStore.setState((state) => ({
            sessions: {
              ...state.sessions,
              [id]: { ...state.sessions[id]!, composerDraft: { input: 'a question I have not sent', attachments: [] } },
            },
          }))
        })
      }
      serverSays(socket, TURN_COMPLETE)
      await settle()
    }

    const sessions = useChatStore.getState().sessions
    // Oldest first; the one holding a draft is skipped over, not dropped.
    expect(sessions['released-0']).toBeUndefined()
    expect(sessions['released-1']?.composerDraft?.input).toBe('a question I have not sent')
    expect(sessions['released-2']).toBeUndefined()
    expect(sessions['released-3']).toBeUndefined()
    const kept = ids.filter((id) => sessions[id])
    expect(kept).toHaveLength(RELEASED_TRANSCRIPT_LIMIT)
    expect(kept.every((id) => sessions[id]!.connectionState === 'disconnected')).toBe(true)
  })

  describe('in the phone and tablet shells, which show one session at a time', () => {
    beforeEach(() => {
      uninstall()
      uninstall = installHiddenSessionRelease(useChatStore, { scope: 'active-tab' })
    })

    function finishTurn(socket: FakeWebSocket, reply: string) {
      serverSays(socket, cliRun('running'))
      serverSays(socket, { type: 'status', state: 'thinking' })
      for (const message of replyText(reply)) serverSays(socket, message)
      serverSays(socket, TURN_COMPLETE)
    }

    it('drops the socket of a session left for the list once its CLI is done, keeping its transcript', async () => {
      useTabStore.setState({ tabs: [sessionTab('phone-chat', 'Phone chat')], activeTabId: 'phone-chat' })
      const socket = connect('phone-chat')
      finishTurn(socket, 'First answer.')
      serverSays(socket, cliRun('running'))
      serverSays(socket, { type: 'status', state: 'thinking' })

      // Back to the list while the next turn still runs: it keeps going.
      act(() => navigateMobileUp())
      await settle()
      expect(useTabStore.getState().activeTabId).toBeNull()
      expect(isHeld('phone-chat')).toBe(true)

      for (const message of replyText('Second answer.')) serverSays(socket, message)
      serverSays(socket, TURN_COMPLETE)
      serverSays(socket, cliRun('idle'))
      await settle()

      expect(socket.closedByClient).toBe(true)
      expect(isHeld('phone-chat')).toBe(false)
      const cached = useChatStore.getState().sessions['phone-chat']
      expect(cached?.connectionState).toBe('disconnected')
      const cachedText = cached?.messages.map((message) => message.type === 'assistant_text' ? message.content : '').join('')
      expect(cachedText).toContain('First answer.')
      expect(cachedText).toContain('Second answer.')

      // Coming back reconnects on top of the cached conversation.
      act(() => useTabStore.getState().setActiveTab('phone-chat'))
      const returned = connect('phone-chat')
      expect(returned).not.toBe(socket)
      expect(isHeld('phone-chat')).toBe(true)
      expect(useChatStore.getState().sessions['phone-chat']?.messages.length).toBe(cached?.messages.length)
    })

    it('keeps a session that waits on an approval while it is off screen', async () => {
      useTabStore.setState({ tabs: [sessionTab('needs-ok', 'Needs approval')], activeTabId: 'needs-ok' })
      const socket = connect('needs-ok')
      serverSays(socket, cliRun('running'))
      serverSays(socket, { type: 'status', state: 'thinking' })
      serverSays(socket, { type: 'permission_request', requestId: 'req-phone', toolName: 'Bash', input: { command: 'git push' } })

      act(() => navigateMobileUp())
      await settle()
      act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })

      expect(isHeld('needs-ok')).toBe(true)
    })

    it('on a tablet, switching sessions releases the one left behind once it is done', async () => {
      useTabStore.setState({
        tabs: [sessionTab('left', 'Left chat'), sessionTab('right', 'Right chat')],
        activeTabId: 'left',
      })
      const leftSocket = connect('left')
      finishTurn(leftSocket, 'Done on the left.')
      serverSays(leftSocket, cliRun('idle'))
      await settle()
      expect(isHeld('left')).toBe(true)

      // Opening the other session in the right pane.
      act(() => useTabStore.getState().setActiveTab('right'))
      connect('right')
      await settle()

      expect(isHeld('left')).toBe(false)
      expect(useChatStore.getState().sessions.left?.connectionState).toBe('disconnected')
      expect(isHeld('right')).toBe(true)
    })
  })

  it('keeps the warm chats, side chats, and a chat the user goes back to before it is done', async () => {
    useTabStore.setState({
      tabs: [sessionTab('reopened', 'Reopened chat'), sessionTab('back', 'Back chat'), sessionTab('front', 'Front chat')],
      activeTabId: 'front',
    })
    connect('front')
    const backSocket = connect('back')
    const reopenedSocket = connect('reopened')
    // A side chat lives in its parent's workspace, never in a tab.
    const sideSocket = connect('side-chat-1')
    serverSays(backSocket, { type: 'status', state: 'thinking' })
    serverSays(backSocket, TURN_COMPLETE)
    serverSays(sideSocket, { type: 'status', state: 'thinking' })
    serverSays(sideSocket, TURN_COMPLETE)
    serverSays(reopenedSocket, { type: 'status', state: 'thinking' })

    // Two more chats push the oldest, still-running one out of the warm set...
    act(() => {
      useTabStore.getState().openTab('next-a', 'Next A')
      useTabStore.getState().openTab('next-b', 'Next B')
    })
    expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === 'reopened')).toBe(false)
    // ...and the user goes back to it in the same update its turn ends in.
    act(() => {
      reopenedSocket.receive(TURN_COMPLETE)
      useTabStore.getState().openTab('reopened', 'Reopened chat')
    })
    await settle()
    act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })

    expect(isHeld('front')).toBe(true)
    expect(isHeld('reopened')).toBe(true)
    expect(isHeld('side-chat-1')).toBe(true)
    // Going back made `back` the least recent of five, and it was done.
    expectReleasedWithTranscript('back')
    expect(disconnectSpy.mock.calls).toEqual([['back']])
  })
})
