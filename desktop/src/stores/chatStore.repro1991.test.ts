import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSessionState, useChatStore } from './chatStore'
import { useTabStore } from './tabStore'
import { wsManager } from '@/api/websocket'

const SESSION_RECONNECT = 'session-1991-reconnect'
const SESSION_RECONNECT_BG = 'session-1991-reconnect-bg'
const SESSION_WORKER_ALLOW = 'session-1991-worker-perm-allow'
const SESSION_WORKER_CANCEL = 'session-1991-worker-perm-cancel'
const SESSION_WORKER_MULTI = 'session-1991-worker-perm-multi'
const SESSION_WORKER_REMOTE = 'session-1991-worker-perm-remote'
const SESSION_MAIN_PERM = 'session-1991-main-perm'

describe('Issue #1991 Part 2 — Sidebar spinner stuck running after task completion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(wsManager, 'send').mockImplementation(() => {})
    vi.spyOn(wsManager, 'isConnected').mockReturnValue(true)
  })

  afterEach(() => {
    for (const id of [
      SESSION_RECONNECT,
      SESSION_RECONNECT_BG,
      SESSION_WORKER_ALLOW,
      SESSION_WORKER_CANCEL,
      SESSION_WORKER_MULTI,
      SESSION_WORKER_REMOTE,
      SESSION_MAIN_PERM,
    ]) {
      const session = useChatStore.getState().sessions[id]
      if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
    }
    useChatStore.setState({ sessions: {} })
    useTabStore.setState({ tabs: [], activeTabId: null })
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('clears tab.status and elapsedTimer when reconnect delivers permission_requests_snapshot(turnActive: false) before session_state(idle)', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_RECONNECT,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'running',
      }],
      activeTabId: SESSION_RECONNECT,
    })

    const timer = setInterval(() => {}, 1000)
    useChatStore.setState({
      sessions: {
        [SESSION_RECONNECT]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          awaitingReconnectSync: true,
          chatState: 'thinking',
          elapsedTimer: timer,
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()

    // Exact server reconnect frame sequence:
    // 1. open(ws) synchronously sends connected + permission_requests_snapshot(turnActive: false)
    store.handleServerMessage(SESSION_RECONNECT, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })

    // 2. sync_state response arrives with turnState: 'idle' and no active background tasks
    store.handleServerMessage(SESSION_RECONNECT, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })

    const session = useChatStore.getState().sessions[SESSION_RECONNECT]
    const tab = useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_RECONNECT)

    expect(session?.chatState).toBe('idle')
    // Bug: permission_requests_snapshot flipped chatState to 'idle' without updating tab.status
    // or clearing elapsedTimer, causing session_state to take its `if (session.chatState === 'idle')`
    // fast path and skip updateTabStatus('idle'). Sidebar then spins forever via tab.status === 'running'.
    expect(tab?.status).toBe('idle')
    expect(session?.elapsedTimer).toBeNull()
  })

  it('returns an idle lead session to idle after approving a detached team worker permission replayed after message_complete', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_WORKER_ALLOW,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'running',
      }],
      activeTabId: SESSION_WORKER_ALLOW,
    })

    useChatStore.setState({
      sessions: {
        [SESSION_WORKER_ALLOW]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          chatState: 'streaming',
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()

    // 1. Lead finishes its turn -> chatState becomes idle and tab.status becomes idle.
    store.handleServerMessage(SESSION_WORKER_ALLOW, {
      type: 'message_complete',
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    expect(useChatStore.getState().sessions[SESSION_WORKER_ALLOW]?.chatState).toBe('idle')
    expect(useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_WORKER_ALLOW)?.status).toBe('idle')

    // 2. Server replays a detached team worker's pending permission right after message_complete
    //    (see src/server/ws/handler.ts replayPendingPermissionRequests after message_complete).
    store.handleServerMessage(SESSION_WORKER_ALLOW, {
      type: 'permission_request',
      requestId: 'req-worker-allow',
      toolName: 'Bash',
      toolUseId: 'tool-worker-1',
      displayName: 'builder',
      input: { command: 'npm test' },
    })
    expect(useChatStore.getState().sessions[SESSION_WORKER_ALLOW]?.chatState).toBe('permission_pending')

    // 3. User approves the worker's permission; server echoes permission_resolved(allowed: true).
    //    The tool runs in the worker's subprocess, so the idle lead gets no tool_result/message_complete.
    store.respondToPermission(SESSION_WORKER_ALLOW, 'req-worker-allow', true)
    store.handleServerMessage(SESSION_WORKER_ALLOW, {
      type: 'permission_resolved',
      requestId: 'req-worker-allow',
      permissionType: 'tool',
      allowed: true,
    })

    // Bug: lead chatState is stuck in 'tool_executing', keeping Sidebar runningChatSessionIds spinning forever.
    expect(useChatStore.getState().sessions[SESSION_WORKER_ALLOW]?.chatState).toBe('idle')
  })

  it('returns an idle lead session to idle when a detached team worker permission is cancelled on worker exit', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_WORKER_CANCEL,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'idle',
      }],
      activeTabId: SESSION_WORKER_CANCEL,
    })

    useChatStore.setState({
      sessions: {
        [SESSION_WORKER_CANCEL]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          chatState: 'idle',
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()

    // Detached team worker asks for permission while lead is idle.
    store.handleServerMessage(SESSION_WORKER_CANCEL, {
      type: 'permission_request',
      requestId: 'req-worker-cancel',
      toolName: 'Bash',
      toolUseId: 'tool-worker-2',
      displayName: 'builder',
      input: { command: 'ls' },
    })
    expect(useChatStore.getState().sessions[SESSION_WORKER_CANCEL]?.chatState).toBe('permission_pending')

    // Worker process exits/stops -> conversationService sends control_cancel_request
    // -> handler translates to permission_resolved without `allowed`.
    store.handleServerMessage(SESSION_WORKER_CANCEL, {
      type: 'permission_resolved',
      requestId: 'req-worker-cancel',
      permissionType: 'tool',
    })

    // Bug: getChatStateAfterPermissionResolution transitions 'permission_pending' -> 'thinking'
    // even though the lead had no running turn, leaving Sidebar spinning forever.
    expect(useChatStore.getState().sessions[SESSION_WORKER_CANCEL]?.chatState).toBe('idle')
  })

  it('keeps tab.status running during reconnect idle reconciliation when a real background task is still running', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_RECONNECT_BG,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'running',
      }],
      activeTabId: SESSION_RECONNECT_BG,
    })

    const timer = setInterval(() => {}, 1000)
    useChatStore.setState({
      sessions: {
        [SESSION_RECONNECT_BG]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          awaitingReconnectSync: true,
          chatState: 'thinking',
          elapsedTimer: timer,
          backgroundAgentTasks: {
            'bg-task-1': {
              taskId: 'bg-task-1',
              taskType: 'local_agent',
              description: 'Background analysis',
              status: 'running',
              startedAt: 1000,
              updatedAt: 1000,
            },
          },
        },
      },
    })

    const store = useChatStore.getState()
    store.handleServerMessage(SESSION_RECONNECT_BG, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    store.handleServerMessage(SESSION_RECONNECT_BG, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: ['bg-task-1'],
    })

    const session = useChatStore.getState().sessions[SESSION_RECONNECT_BG]
    const tab = useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_RECONNECT_BG)
    expect(session?.chatState).toBe('idle')
    expect(session?.elapsedTimer).toBeNull()
    expect(tab?.status).toBe('running')
  })

  it('returns to idle after resolving multiple sequential delegated worker permissions while lead is idle', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_WORKER_MULTI,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'idle',
      }],
      activeTabId: SESSION_WORKER_MULTI,
    })

    useChatStore.setState({
      sessions: {
        [SESSION_WORKER_MULTI]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          chatState: 'idle',
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()
    store.handleServerMessage(SESSION_WORKER_MULTI, {
      type: 'permission_request',
      requestId: 'req-worker-a',
      toolName: 'Bash',
      toolUseId: 'tool-worker-a',
      displayName: 'builder',
      input: { command: 'echo a' },
    })
    store.handleServerMessage(SESSION_WORKER_MULTI, {
      type: 'permission_request',
      requestId: 'req-worker-b',
      toolName: 'Bash',
      toolUseId: 'tool-worker-b',
      displayName: 'reviewer',
      input: { command: 'echo b' },
    })

    store.respondToPermission(SESSION_WORKER_MULTI, 'req-worker-a', true)
    expect(useChatStore.getState().sessions[SESSION_WORKER_MULTI]?.chatState).toBe('permission_pending')

    store.respondToPermission(SESSION_WORKER_MULTI, 'req-worker-b', true)
    expect(useChatStore.getState().sessions[SESSION_WORKER_MULTI]?.chatState).toBe('idle')
    expect(useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_WORKER_MULTI)?.status).toBe('idle')
  })

  it('returns to idle when a delegated worker permission is resolved remotely after a turnActive: false reconnect snapshot', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_WORKER_REMOTE,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'running',
      }],
      activeTabId: SESSION_WORKER_REMOTE,
    })

    const timer = setInterval(() => {}, 1000)
    useChatStore.setState({
      sessions: {
        [SESSION_WORKER_REMOTE]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          chatState: 'thinking',
          elapsedTimer: timer,
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()
    store.handleServerMessage(SESSION_WORKER_REMOTE, {
      type: 'permission_request',
      requestId: 'req-worker-remote',
      toolName: 'Bash',
      toolUseId: 'tool-worker-remote',
      displayName: 'builder',
      input: { command: 'npm test' },
    })
    // Reconnect snapshot confirms lead turn is no longer active, only the delegated worker request remains.
    store.handleServerMessage(SESSION_WORKER_REMOTE, {
      type: 'permission_requests_snapshot',
      toolRequestIds: ['req-worker-remote'],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(useChatStore.getState().sessions[SESSION_WORKER_REMOTE]?.chatState).toBe('permission_pending')

    // Another client approves the delegated worker permission.
    store.handleServerMessage(SESSION_WORKER_REMOTE, {
      type: 'permission_resolved',
      requestId: 'req-worker-remote',
      permissionType: 'tool',
      allowed: true,
    })

    const session = useChatStore.getState().sessions[SESSION_WORKER_REMOTE]
    const tab = useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_WORKER_REMOTE)
    expect(session?.chatState).toBe('idle')
    expect(session?.elapsedTimer).toBeNull()
    expect(tab?.status).toBe('idle')
  })

  it('preserves main-session permission transitions to tool_executing and thinking when no displayName is set', () => {
    useChatStore.setState({
      sessions: {
        [SESSION_MAIN_PERM]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          chatState: 'idle',
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()
    store.handleServerMessage(SESSION_MAIN_PERM, {
      type: 'permission_request',
      requestId: 'req-main-allow',
      toolName: 'Read',
      toolUseId: 'tool-main-1',
      input: { file_path: '/tmp/a.ts' },
    })
    store.respondToPermission(SESSION_MAIN_PERM, 'req-main-allow', true)
    expect(useChatStore.getState().sessions[SESSION_MAIN_PERM]?.chatState).toBe('tool_executing')

    useChatStore.setState({
      sessions: {
        [SESSION_MAIN_PERM]: {
          ...useChatStore.getState().sessions[SESSION_MAIN_PERM]!,
          chatState: 'idle',
        },
      },
    })
    store.handleServerMessage(SESSION_MAIN_PERM, {
      type: 'permission_request',
      requestId: 'req-main-cancel',
      toolName: 'Read',
      toolUseId: 'tool-main-2',
      input: { file_path: '/tmp/b.ts' },
    })
    store.handleServerMessage(SESSION_MAIN_PERM, {
      type: 'permission_resolved',
      requestId: 'req-main-cancel',
      permissionType: 'tool',
    })
    expect(useChatStore.getState().sessions[SESSION_MAIN_PERM]?.chatState).toBe('thinking')
  })
})
