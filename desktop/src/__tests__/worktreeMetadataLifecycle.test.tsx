import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const server = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  getGitInfo: vi.fn(),
  getMessages: vi.fn(),
  getSlashCommands: vi.fn(),
  getInspection: vi.fn(),
  getRepositoryContext: vi.fn(),
  getRecentProjects: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
  materialized: false,
}))

vi.mock('../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      create: server.create,
      list: server.list,
      getGitInfo: server.getGitInfo,
      getMessages: server.getMessages,
      getSlashCommands: server.getSlashCommands,
      getInspection: server.getInspection,
      getRepositoryContext: server.getRepositoryContext,
      getRecentProjects: server.getRecentProjects,
    },
  }
})

vi.mock('../api/agents', () => ({
  agentsApi: { list: vi.fn(async () => ({ activeAgents: [], allAgents: [] })) },
}))
vi.mock('../api/skills', () => ({
  skillsApi: { list: vi.fn(async () => ({ skills: [] })) },
}))
vi.mock('../api/providers', () => ({
  providersApi: { list: vi.fn(async () => ({ providers: [], activeId: null })) },
}))
vi.mock('../api/mcp', () => ({
  mcpApi: { list: vi.fn(async () => ({ servers: [] })), status: vi.fn() },
}))
vi.mock('../api/teams', () => ({
  teamsApi: {
    list: vi.fn(async () => ({ teams: [] })),
    getWorkbenchForSession: vi.fn(async () => null),
  },
}))
vi.mock('../api/cliTasks', () => ({
  cliTasksApi: {
    getTasksForList: vi.fn(async () => ({ tasks: [] })),
    resetTaskList: vi.fn(async () => ({ ok: true })),
  },
}))
vi.mock('../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearHandlers: vi.fn(),
    onConnectionState: vi.fn((_sessionId: string, handler: (state: string) => void) => {
      handler('connected')
      return () => {}
    }),
    onMessage: vi.fn(() => () => {}),
    send: vi.fn(),
  },
}))
vi.mock('../hooks/useMobileViewport', () => ({
  useMobileViewport: () => false,
}))
vi.mock('../components/chat/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}))
vi.mock('../components/controls/PermissionModeSelector', () => ({
  PermissionModeSelector: () => <button type="button">Permissions</button>,
}))
vi.mock('../components/controls/ModelSelector', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ModelSelector: React.forwardRef(() => <button type="button">Model</button>),
  }
})

import { ActiveSession } from '../pages/ActiveSession'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useWorkspaceChatContextStore } from '../stores/workspaceChatContextStore'

const WORKTREE_SESSION_ID = 'worktree-lifecycle-session'
const REGULAR_SESSION_ID = 'regular-lifecycle-session'
const SOURCE_WORK_DIR = '/tmp/express'
const PLANNED_WORKTREE_PATH = '/tmp/express/.claude/worktrees/desktop-main-planned'
const ACTUAL_WORKTREE_CWD = '/private/tmp/express/.claude/worktrees/desktop-main-planned'
const REGULAR_WORK_DIR = '/tmp/plain-project'

function sessionRow(id: string, workDir: string, messageCount = 0) {
  return {
    id,
    title: id === WORKTREE_SESSION_ID ? 'Worktree Session' : 'Regular Session',
    createdAt: '2026-08-10T00:00:00.000Z',
    modifiedAt: '2026-08-10T00:00:00.000Z',
    messageCount,
    projectPath: workDir,
    projectRoot: workDir,
    workDir,
    workDirExists: true,
    workspaceState: 'available',
  }
}

async function finishTurn(sessionId: string, text: string) {
  await act(async () => {
    const chat = useChatStore.getState()
    chat.handleServerMessage(sessionId, { type: 'status', state: 'thinking' })
    chat.handleServerMessage(sessionId, { type: 'content_start', blockType: 'text' })
    chat.handleServerMessage(sessionId, { type: 'content_delta', text })
    chat.handleServerMessage(sessionId, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await Promise.resolve()
  })
}

async function expectTooltipPath(trigger: HTMLElement, path: string) {
  fireEvent.focus(trigger)
  const tooltip = await screen.findByRole('tooltip')
  expect(tooltip).toHaveTextContent(path)
  fireEvent.blur(trigger)
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
}

describe('worktree metadata across the live session lifecycle', () => {
  const initialChatState = useChatStore.getInitialState()
  const initialSessionState = useSessionStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialWorkspaceContextState = useWorkspaceChatContextStore.getInitialState()

  beforeEach(() => {
    vi.clearAllMocks()
    server.rows = []
    server.materialized = false
    useSettingsStore.setState({ locale: 'en', permissionMode: 'default' })
    useChatStore.setState(initialChatState, true)
    useSessionStore.setState(initialSessionState, true)
    useTabStore.setState(initialTabState, true)
    useWorkspaceChatContextStore.setState(initialWorkspaceContextState, true)

    server.create.mockImplementation(async (input: {
      workDir?: string
      repository?: { worktree?: boolean }
    }) => {
      const isolated = input.repository?.worktree === true
      const id = isolated ? WORKTREE_SESSION_ID : REGULAR_SESSION_ID
      const workDir = input.workDir || REGULAR_WORK_DIR
      server.rows = [
        sessionRow(id, workDir),
        ...server.rows.filter((row) => row.id !== id),
      ]
      return { sessionId: id, workDir }
    })
    server.list.mockImplementation(async () => ({
      sessions: server.rows,
      total: server.rows.length,
    }))
    server.getGitInfo.mockImplementation(async (sessionId: string) => {
      if (sessionId === REGULAR_SESSION_ID) {
        return {
          branch: 'main',
          repoName: 'plain-project',
          workDir: REGULAR_WORK_DIR,
          changedFiles: 0,
          worktree: null,
        }
      }
      return {
        branch: 'main',
        repoName: 'express',
        workDir: server.materialized ? ACTUAL_WORKTREE_CWD : SOURCE_WORK_DIR,
        changedFiles: 0,
        worktree: {
          enabled: true,
          path: server.materialized ? ACTUAL_WORKTREE_CWD : null,
          plannedPath: PLANNED_WORKTREE_PATH,
          sourceWorkDir: SOURCE_WORK_DIR,
          slug: 'desktop-main-planned',
          branch: 'worktree-desktop-main-planned',
        },
      }
    })
    server.getMessages.mockResolvedValue({ messages: [] })
    server.getSlashCommands.mockResolvedValue({ commands: [] })
    server.getInspection.mockImplementation(async (sessionId: string) => ({
      active: false,
      status: {
        sessionId,
        workDir: sessionId === WORKTREE_SESSION_ID ? ACTUAL_WORKTREE_CWD : REGULAR_WORK_DIR,
        permissionMode: 'default',
      },
    }))
    server.getRepositoryContext.mockImplementation(async (workDir: string) => ({
      state: 'ok',
      workDir,
      repoRoot: workDir,
      repoName: workDir.split('/').filter(Boolean).at(-1) || null,
      currentBranch: 'main',
      defaultBranch: 'main',
      dirty: false,
      branches: [{
        name: 'main',
        current: true,
        local: true,
        remote: false,
        checkedOut: true,
        worktreePath: workDir,
      }],
      worktrees: [{ path: workDir, branch: 'main', current: true }],
    }))
    server.getRecentProjects.mockResolvedValue({ projects: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps header and composer on the actual cwd after create, materialize, and a regular-session switch', async () => {
    let sessionId = ''
    await act(async () => {
      sessionId = await useSessionStore.getState().createSession(SOURCE_WORK_DIR, {
        repository: { branch: 'main', worktree: true },
      })
    })
    act(() => {
      useTabStore.getState().openTab(sessionId, 'Worktree Session', 'session')
    })

    render(<ActiveSession />)

    await waitFor(() => {
      expect(server.getGitInfo).toHaveBeenCalledWith(sessionId)
    })
    expect(screen.queryByTestId('session-worktree-indicator')).not.toBeInTheDocument()

    const callsBeforeMaterialize = server.getGitInfo.mock.calls.length
    server.materialized = true
    await finishTurn(sessionId, 'worktree ready')

    await waitFor(() => {
      expect(server.getGitInfo.mock.calls.length).toBeGreaterThan(callsBeforeMaterialize)
      expect(screen.getByTestId('worktree-details-trigger')).toBeInTheDocument()
    })

    await expectTooltipPath(screen.getByTestId('session-worktree-indicator'), ACTUAL_WORKTREE_CWD)
    await expectTooltipPath(screen.getByTestId('worktree-details-trigger'), ACTUAL_WORKTREE_CWD)

    let regularSessionId = ''
    await act(async () => {
      regularSessionId = await useSessionStore.getState().createSession(REGULAR_WORK_DIR)
    })
    act(() => {
      useTabStore.getState().openTab(regularSessionId, 'Regular Session', 'session')
    })
    await finishTurn(regularSessionId, 'plain checkout ready')

    await waitFor(() => {
      expect(screen.queryByTestId('session-worktree-indicator')).not.toBeInTheDocument()
      expect(screen.queryByTestId('worktree-details-trigger')).not.toBeInTheDocument()
    })
  })

  it('synchronizes both header and composer branch badges when a regular checkout switches branches', async () => {
    let liveBranch = 'master'
    server.getGitInfo.mockImplementation(async () => ({
      branch: liveBranch,
      repoName: 'plain-project',
      workDir: REGULAR_WORK_DIR,
      changedFiles: 0,
      worktree: null,
    }))

    let regularSessionId = ''
    await act(async () => {
      regularSessionId = await useSessionStore.getState().createSession(REGULAR_WORK_DIR)
    })
    act(() => {
      useTabStore.getState().openTab(regularSessionId, 'Regular Session', 'session')
    })

    render(
      <div>
        <textarea data-testid="external-terminal-focus" aria-label="Terminal" />
        <ActiveSession />
      </div>,
    )
    await finishTurn(regularSessionId, 'initial reply')

    await waitFor(() => {
      expect(screen.getByTestId('session-header-branch')).toHaveTextContent('master')
      expect(screen.getByTestId('run-location-readonly')).toHaveTextContent('master')
    })

    liveBranch = 'dev_xxxx'
    const callsBeforeWindowFocus = server.getGitInfo.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('session-header-branch')).toHaveTextContent('dev_xxxx')
      expect(screen.getByTestId('run-location-readonly')).toHaveTextContent('dev_xxxx')
    })
    expect(server.getGitInfo).toHaveBeenCalledTimes(callsBeforeWindowFocus + 1)

    // Switching branches in the docked terminal and focusing the composer updates the header too.
    const terminalFocus = screen.getByTestId('external-terminal-focus')
    fireEvent.focus(terminalFocus)
    liveBranch = 'feat/synced-header'
    const callsBeforeComposerFocus = server.getGitInfo.mock.calls.length
    fireEvent.focus(within(screen.getByTestId('chat-input-panel')).getByRole('textbox'), { relatedTarget: terminalFocus })
    await waitFor(() => {
      expect(screen.getByTestId('session-header-branch')).toHaveTextContent('feat/synced-header')
      expect(screen.getByTestId('run-location-readonly')).toHaveTextContent('feat/synced-header')
    })
    expect(server.getGitInfo).toHaveBeenCalledTimes(callsBeforeComposerFocus + 1)
  })
})
