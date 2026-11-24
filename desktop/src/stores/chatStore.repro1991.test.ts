import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSessionState, useChatStore } from './chatStore'
import { useTabStore } from './tabStore'
import { wsManager } from '@/api/websocket'
import { sessionsApi } from '@/api/sessions'

const SESSION_RECONNECT = 'session-1991-reconnect'
const SESSION_RECONNECT_BG = 'session-1991-reconnect-bg'
const SESSION_RECONNECT_ERROR = 'session-1991-reconnect-error'
const SESSION_WORKER_ALLOW = 'session-1991-worker-perm-allow'
const SESSION_WORKER_CANCEL = 'session-1991-worker-perm-cancel'
const SESSION_WORKER_MULTI = 'session-1991-worker-perm-multi'
const SESSION_WORKER_REMOTE = 'session-1991-worker-perm-remote'
const SESSION_WORKER_RECONNECT_LOCAL = 'session-1991-worker-reconnect-local'
const SESSION_WORKER_STATUS_IDLE = 'session-1991-worker-status-idle'
const SESSION_WORKER_ATTACHMENT_RETRY = 'session-1991-worker-attachment-retry'
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
      SESSION_RECONNECT_ERROR,
      SESSION_WORKER_ALLOW,
      SESSION_WORKER_CANCEL,
      SESSION_WORKER_MULTI,
      SESSION_WORKER_REMOTE,
      SESSION_WORKER_RECONNECT_LOCAL,
      SESSION_WORKER_STATUS_IDLE,
      SESSION_WORKER_ATTACHMENT_RETRY,
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
    // Real reconnect immediately follows with sync_state -> session_state(idle).
    store.handleServerMessage(SESSION_WORKER_REMOTE, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
    expect(useChatStore.getState().sessions[SESSION_WORKER_REMOTE]?.chatState).toBe('permission_pending')
    expect(useChatStore.getState().sessions[SESSION_WORKER_REMOTE]?.pendingPermissions).toHaveProperty('req-worker-remote')

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

  it('keeps delegated worker permission and returns to idle on local approval across full reconnect snapshot + session_state(idle) + reloadHistory', async () => {
    const getFullHistorySpy = vi.spyOn(sessionsApi, 'getFullHistory').mockResolvedValue({
      messages: [],
      page: {
        hasMore: false,
        nextCursor: null,
        historyComplete: true,
        scannedBytes: 0,
        omittedOversizedEntries: 0,
        sourceVersion: 'v1',
      },
    })

    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_WORKER_RECONNECT_LOCAL,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'running',
      }],
      activeTabId: SESSION_WORKER_RECONNECT_LOCAL,
    })

    const timer = setInterval(() => {}, 1000)
    useChatStore.setState({
      sessions: {
        [SESSION_WORKER_RECONNECT_LOCAL]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: false,
          chatState: 'idle',
          elapsedTimer: timer,
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()
    // 1. Reconnect replays pending delegated worker permission + snapshot(turnActive: false)
    store.handleServerMessage(SESSION_WORKER_RECONNECT_LOCAL, {
      type: 'permission_request',
      requestId: 'req-worker-reconnect-local',
      toolName: 'Bash',
      toolUseId: 'tool-worker-reconnect-local',
      displayName: 'builder',
      input: { command: 'npm test' },
    })
    store.handleServerMessage(SESSION_WORKER_RECONNECT_LOCAL, {
      type: 'permission_requests_snapshot',
      toolRequestIds: ['req-worker-reconnect-local'],
      computerUseRequestIds: [],
      turnActive: false,
    })
    // 2. sync_state returns session_state(idle), which also triggers reloadHistory
    store.handleServerMessage(SESSION_WORKER_RECONNECT_LOCAL, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
    await vi.runAllTimersAsync()
    expect(getFullHistorySpy).toHaveBeenCalled()

    let session = useChatStore.getState().sessions[SESSION_WORKER_RECONNECT_LOCAL]
    expect(session?.chatState).toBe('permission_pending')
    expect(session?.pendingPermissions).toHaveProperty('req-worker-reconnect-local')
    expect(session?.pendingPermission?.requestId).toBe('req-worker-reconnect-local')
    expect(useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_WORKER_RECONNECT_LOCAL)?.status).toBe('idle')

    // 3. Local user clicks Allow -> must return to idle, not stick in tool_executing
    store.respondToPermission(SESSION_WORKER_RECONNECT_LOCAL, 'req-worker-reconnect-local', true)
    session = useChatStore.getState().sessions[SESSION_WORKER_RECONNECT_LOCAL]
    expect(session?.chatState).toBe('idle')
    expect(session?.elapsedTimer).toBeNull()
    expect(useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_WORKER_RECONNECT_LOCAL)?.status).toBe('idle')
  })

  it('preserves delegated worker permission invariant when status(idle) arrives while waiting for approval', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_WORKER_STATUS_IDLE,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'running',
      }],
      activeTabId: SESSION_WORKER_STATUS_IDLE,
    })

    useChatStore.setState({
      sessions: {
        [SESSION_WORKER_STATUS_IDLE]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          chatState: 'thinking',
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()
    store.handleServerMessage(SESSION_WORKER_STATUS_IDLE, {
      type: 'permission_request',
      requestId: 'req-worker-status-idle',
      toolName: 'Bash',
      toolUseId: 'tool-worker-status-idle',
      displayName: 'builder',
      input: { command: 'ls' },
    })
    store.handleServerMessage(SESSION_WORKER_STATUS_IDLE, {
      type: 'status',
      state: 'idle',
    })

    expect(useChatStore.getState().sessions[SESSION_WORKER_STATUS_IDLE]?.chatState).toBe('permission_pending')
    expect(useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_WORKER_STATUS_IDLE)?.status).toBe('idle')

    store.respondToPermission(SESSION_WORKER_STATUS_IDLE, 'req-worker-status-idle', true)
    expect(useChatStore.getState().sessions[SESSION_WORKER_STATUS_IDLE]?.chatState).toBe('idle')
  })

  it('preserves tab.status error across idle reconnect reconciliation and delegated permission resolution', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_RECONNECT_ERROR,
        title: 'Errored Lead',
        type: 'session',
        status: 'error',
      }],
      activeTabId: SESSION_RECONNECT_ERROR,
    })

    useChatStore.setState({
      sessions: {
        [SESSION_RECONNECT_ERROR]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          awaitingReconnectSync: true,
          chatState: 'idle',
          backgroundAgentTasks: {},
        },
      },
    })

    const store = useChatStore.getState()
    store.handleServerMessage(SESSION_RECONNECT_ERROR, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    store.handleServerMessage(SESSION_RECONNECT_ERROR, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
    expect(useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_RECONNECT_ERROR)?.status).toBe('error')

    // Delegated worker permission arriving and resolving on an errored tab must also keep error indicator.
    store.handleServerMessage(SESSION_RECONNECT_ERROR, {
      type: 'permission_request',
      requestId: 'req-worker-on-error',
      toolName: 'Bash',
      toolUseId: 'tool-worker-on-error',
      displayName: 'builder',
      input: { command: 'pwd' },
    })
    store.respondToPermission(SESSION_RECONNECT_ERROR, 'req-worker-on-error', true)
    expect(useChatStore.getState().sessions[SESSION_RECONNECT_ERROR]?.chatState).toBe('idle')
    expect(useTabStore.getState().tabs.find((t) => t.sessionId === SESSION_RECONNECT_ERROR)?.status).toBe('error')
  })

  it('restores restoreIdleAfterPermissions when a delegated worker AskUserQuestion recovers from ATTACHMENT_PROCESSING_FAILED', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_WORKER_ATTACHMENT_RETRY,
        title: 'Agent Team Lead',
        type: 'session',
        status: 'idle',
      }],
      activeTabId: SESSION_WORKER_ATTACHMENT_RETRY,
    })

    useChatStore.setState({
      sessions: {
        [SESSION_WORKER_ATTACHMENT_RETRY]: {
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
    store.handleServerMessage(SESSION_WORKER_ATTACHMENT_RETRY, {
      type: 'permission_request',
      requestId: 'req-worker-ask-attach',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-worker-ask-attach',
      displayName: 'builder',
      input: { questions: [] },
    })

    // First submission with attachment stashes the delegated permission and returns to idle.
    store.respondToPermission(SESSION_WORKER_ATTACHMENT_RETRY, 'req-worker-ask-attach', true, {
      attachments: [{
        type: 'image',
        name: 'screenshot.png',
        mimeType: 'image/png',
        data: 'ZmFrZQ==',
      }],
    })
    expect(useChatStore.getState().sessions[SESSION_WORKER_ATTACHMENT_RETRY]?.chatState).toBe('idle')

    // Server rejects attachment processing -> stashed permission is restored with restoreIdleAfterPermissions.
    store.handleServerMessage(SESSION_WORKER_ATTACHMENT_RETRY, {
      type: 'error',
      code: 'ATTACHMENT_PROCESSING_FAILED',
      permissionRequestId: 'req-worker-ask-attach',
      message: 'Failed to process image',
    })
    expect(useChatStore.getState().sessions[SESSION_WORKER_ATTACHMENT_RETRY]?.chatState).toBe('permission_pending')
    expect(useChatStore.getState().sessions[SESSION_WORKER_ATTACHMENT_RETRY]?.pendingPermissions).toHaveProperty('req-worker-ask-attach')

    // Retrying approval must return to idle (not stick in tool_executing).
    store.respondToPermission(SESSION_WORKER_ATTACHMENT_RETRY, 'req-worker-ask-attach', true)
    expect(useChatStore.getState().sessions[SESSION_WORKER_ATTACHMENT_RETRY]?.chatState).toBe('idle')
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
