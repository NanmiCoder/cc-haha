// A session socket is what keeps its CLI and MCP servers alive on the server,
// which reclaims a runtime only after the last client socket closes (#1485).
// These tests drive the real wsManager, chat store and tab bar on top of a fake
// WebSocket that answers heartbeats, so they see when a socket really closes.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const notifyDesktopMock = vi.hoisted(() => vi.fn())
const sessionsApiMock = vi.hoisted(() => ({
  delete: vi.fn(() => Promise.resolve()),
  getSlashCommands: vi.fn(async () => ({ commands: [] })),
  getFullHistory: vi.fn(async () => ({ messages: [] })),
  getHistoryPage: vi.fn(async () => ({ messages: [] })),
  getHistoryRecovery: vi.fn(async () => ({ status: 'incomplete', messages: [] })),
}))

vi.mock('../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../i18n')>()),
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'tabs.closeConfirmTitle': 'Session Running',
      'tabs.closeConfirmMessage': 'Still running',
      'tabs.closeConfirmKeep': 'Keep Running',
      'tabs.closeConfirmStop': 'Stop & Close',
      'tabs.closeTab': 'Close {title}',
      'common.cancel': 'Cancel',
    }
    let text = translations[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replace(`{${name}}`, String(value))
    }
    return text
  },
}))
vi.mock('../api/sessions', () => ({ sessionsApi: sessionsApiMock }))
vi.mock('../api/teams', () => ({ teamsApi: { getWorkbenchForSession: vi.fn() } }))
vi.mock('../lib/desktopNotifications', () => ({ notifyDesktop: notifyDesktopMock }))
vi.mock('../components/layout/OpenProjectMenu', () => ({ OpenProjectMenu: () => null }))
vi.mock('../components/layout/WindowControls', () => ({ WindowControls: () => null, showWindowControls: false }))

import { wsManager } from '../api/websocket'
import { useChatStore } from './chatStore'
import { installHiddenSessionRelease } from './hiddenSessionRelease'
import { useTabStore, type Tab } from './tabStore'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { TabBar } from '../components/layout/TabBar'
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

function closeTabKeepingItRunning(title: string) {
  fireEvent.click(screen.getByLabelText(`Close ${title}`))
  expect(screen.getByRole('dialog', { name: 'Session Running' })).toBeInTheDocument()
  fireEvent.click(screen.getByText('Keep Running'))
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
    uninstall = installHiddenSessionRelease(useChatStore)

    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserverMock })
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })

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

  it('releases a session kept running from its tab once its CLI run ends, after notifying', async () => {
    useTabStore.setState({ tabs: [sessionTab('busy', 'Busy chat'), sessionTab('other', 'Other chat')], activeTabId: 'busy' })
    const socket = connect('busy')
    serverSays(socket, cliRun('running'))
    serverSays(socket, { type: 'status', state: 'thinking', verb: 'Thinking' })

    render(<TabBar />)
    closeTabKeepingItRunning('Busy chat')
    await settle()

    // Still working: the user asked to keep it running.
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['other'])
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
    expect(isHeld('busy')).toBe(false)
    expect(useChatStore.getState().sessions.busy).toBeUndefined()
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

    render(<TabBar />)
    closeTabKeepingItRunning('Build chat')
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

  it('releases at once when the turn finished while the close dialog was open', async () => {
    useTabStore.setState({ tabs: [sessionTab('racing', 'Racing chat')], activeTabId: 'racing' })
    const socket = connect('racing')
    serverSays(socket, { type: 'status', state: 'tool_executing' })

    render(<TabBar />)
    fireEvent.click(screen.getByLabelText('Close Racing chat'))
    serverSays(socket, TURN_COMPLETE)
    fireEvent.click(screen.getByText('Keep Running'))
    await settle()

    expect(socket.closedByClient).toBe(true)
    expect(isHeld('racing')).toBe(false)
  })

  it('keeps a hidden session while it waits on the user, and releases it once that turn ends', async () => {
    useTabStore.setState({ tabs: [sessionTab('asking', 'Asking chat')], activeTabId: 'asking' })
    const socket = connect('asking')
    serverSays(socket, { type: 'status', state: 'thinking' })

    render(<TabBar />)
    closeTabKeepingItRunning('Asking chat')
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

    render(<TabBar />)
    closeTabKeepingItRunning('Desktop chat')
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

    render(<TabBar />)
    closeTabKeepingItRunning('Queued chat')
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

    render(<TabBar />)
    // An idle chat still counts as running while it shows a background shell.
    closeTabKeepingItRunning('Old chat')
    await settle()
    expect(isHeld('ghost')).toBe(true)

    // A later run ends: the CLI has nothing left, whatever the stale row says.
    serverSays(socket, cliRun('running'))
    serverSays(socket, cliRun('idle'))
    await settle()

    expect(useChatStore.getState().sessions.ghost).toBeUndefined()
    expect(isHeld('ghost')).toBe(false)
  })

  it('keeps a team lead and releases it only once its team is gone', async () => {
    useTabStore.setState({ tabs: [sessionTab('lead', 'Lead chat')], activeTabId: 'lead' })
    const socket = connect('lead')
    useTeamStore.setState({ teamNameBySession: { lead: 'review-team' } })
    serverSays(socket, cliRun('running'))
    serverSays(socket, { type: 'status', state: 'thinking' })

    render(<TabBar />)
    closeTabKeepingItRunning('Lead chat')
    serverSays(socket, TURN_COMPLETE)
    serverSays(socket, cliRun('idle'))
    await settle()

    // Members ask for approval and report through the lead's socket only.
    expect(isHeld('lead')).toBe(true)

    act(() => useTeamStore.setState({ teamNameBySession: {} }))
    await settle()
    expect(isHeld('lead')).toBe(false)
  })

  it('keeps a session while its team workbench or a subagent tab still reads it', async () => {
    useTabStore.setState({
      tabs: [
        sessionTab('source', 'Source chat'),
        { sessionId: 'team:source', title: 'Agent Teams', type: 'team', status: 'idle', teamLeadSessionId: 'source', sourceSessionId: 'source' },
        { sessionId: 'subagent:source__tool-1', title: 'SubAgent', type: 'subagent', status: 'idle', sourceSessionId: 'source', subagentToolUseId: 'tool-1' },
      ],
      activeTabId: 'source',
    })
    const socket = connect('source')
    serverSays(socket, cliRun('running'))
    serverSays(socket, { type: 'status', state: 'thinking' })

    render(<TabBar />)
    closeTabKeepingItRunning('Source chat')
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

  it('keeps sessions that a tab shows, side chats, and the tab the user reopens', async () => {
    useTabStore.setState({
      tabs: [sessionTab('front', 'Front chat'), sessionTab('back', 'Back chat'), sessionTab('reopened', 'Reopened chat')],
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

    render(<TabBar />)
    closeTabKeepingItRunning('Reopened chat')
    act(() => {
      reopenedSocket.receive(TURN_COMPLETE)
      useTabStore.getState().openTab('reopened', 'Reopened chat')
    })
    await settle()
    act(() => { vi.advanceTimersByTime(EIGHTEEN_HOURS_MS) })

    expect(isHeld('front')).toBe(true)
    expect(isHeld('back')).toBe(true)
    expect(isHeld('reopened')).toBe(true)
    expect(isHeld('side-chat-1')).toBe(true)
    expect(disconnectSpy).not.toHaveBeenCalled()
  })
})
