import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getRepositoryContext: vi.fn(),
  getMessages: vi.fn(),
  getSlashCommands: vi.fn(),
  listSkills: vi.fn(),
  getTasksForList: vi.fn(),
  resetTaskList: vi.fn(),
  wsClearHandlers: vi.fn(),
  wsConnect: vi.fn(),
  wsOnMessage: vi.fn(),
  wsSend: vi.fn(),
  wsDisconnect: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    create: mocks.createSession,
    list: mocks.listSessions,
    getRepositoryContext: mocks.getRepositoryContext,
    getMessages: mocks.getMessages,
    getSlashCommands: mocks.getSlashCommands,
  },
}))

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: mocks.listSkills,
  },
}))

vi.mock('../api/cliTasks', () => ({
  cliTasksApi: {
    getTasksForList: mocks.getTasksForList,
    resetTaskList: mocks.resetTaskList,
  },
}))

vi.mock('../api/websocket', () => ({
  wsManager: {
    clearHandlers: mocks.wsClearHandlers,
    connect: mocks.wsConnect,
    onMessage: mocks.wsOnMessage,
    send: mocks.wsSend,
    disconnect: mocks.wsDisconnect,
  },
}))

vi.mock('../components/shared/DirectoryPicker', () => ({
  DirectoryPicker: ({ value, onChange }: { value: string; onChange: (path: string) => void }) => (
    <button type="button" aria-label="Pick project" data-value={value} onClick={() => onChange('/workspace/project')}>
      Pick project
    </button>
  ),
}))

vi.mock('../components/controls/PermissionModeSelector', () => ({
  PermissionModeSelector: () => <button type="button">Bypass</button>,
}))

vi.mock('../components/controls/ModelSelector', () => ({
  ModelSelector: () => <button type="button">Model</button>,
}))

import { EmptySession } from './EmptySession'
import { ApiError } from '../api/client'
import { useChatStore } from '../stores/chatStore'
import { useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import type { RepositoryContextResult } from '../api/sessions'

function okRepositoryContext(overrides: Partial<RepositoryContextResult> = {}): RepositoryContextResult {
  return {
    state: 'ok',
    workDir: '/workspace/project',
    repoRoot: '/workspace/project',
    repoName: 'project',
    currentBranch: 'main',
    defaultBranch: 'main',
    dirty: false,
    branches: [{
      name: 'main',
      current: true,
      local: true,
      remote: false,
      checkedOut: true,
      worktreePath: '/workspace/project',
    }],
    worktrees: [{
      path: '/workspace/project',
      branch: 'main',
      current: true,
    }],
    ...overrides,
  }
}

function notGitRepositoryContext(): RepositoryContextResult {
  return {
    state: 'not_git_repo',
    workDir: '/workspace/project',
    repoRoot: null,
    repoName: null,
    currentBranch: null,
    defaultBranch: null,
    dirty: false,
    branches: [],
    worktrees: [],
  }
}

describe('EmptySession', () => {
  const initialSessionState = useSessionStore.getInitialState()
  const initialChatState = useChatStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialRuntimeState = useSessionRuntimeStore.getInitialState()
  const initialUiState = useUIStore.getInitialState()

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en', activeProviderName: null })
    useSessionStore.setState(initialSessionState, true)
    useChatStore.setState(initialChatState, true)
    useTabStore.setState(initialTabState, true)
    useSessionRuntimeStore.setState(initialRuntimeState, true)
    useUIStore.setState(initialUiState, true)

    mocks.createSession.mockResolvedValue({ sessionId: 'draft-session' })
    mocks.getRepositoryContext.mockResolvedValue(okRepositoryContext())
    mocks.listSessions.mockResolvedValue({
      sessions: [{
        id: 'draft-session',
        title: 'New Session',
        createdAt: '2026-05-01T00:00:00.000Z',
        modifiedAt: '2026-05-01T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      total: 1,
    })
    mocks.getMessages.mockResolvedValue({ messages: [] })
    mocks.getSlashCommands.mockResolvedValue({ commands: [] })
    mocks.listSkills.mockResolvedValue({ skills: [] })
    mocks.getTasksForList.mockResolvedValue({ tasks: [] })
    mocks.resetTaskList.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    useSessionStore.setState(initialSessionState, true)
    useChatStore.setState(initialChatState, true)
    useTabStore.setState(initialTabState, true)
    useSessionRuntimeStore.setState(initialRuntimeState, true)
    useUIStore.setState(initialUiState, true)
  })

  it('creates a session with the selected project and branch when submitted', async () => {
    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }))

    expect(mocks.createSession).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    const runButton = screen.getByRole('button', { name: /Run/i })
    await waitFor(() => {
      expect(runButton).not.toBeDisabled()
    })

    fireEvent.click(runButton)

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        repository: { branch: 'main', worktree: false },
      })
    })

    expect(useTabStore.getState().activeTabId).toBe('draft-session')
    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: 'draft-session', title: 'draft question', type: 'session', status: 'idle' },
    ])
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'draft-session',
      workDir: '/workspace/project',
    })
    const messages = useChatStore.getState().sessions['draft-session']?.messages ?? []
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'user_text',
      content: 'draft question',
    })
    expect(mocks.wsSend).toHaveBeenCalledWith('draft-session', {
      type: 'user_message',
      content: 'draft question',
      attachments: [],
    })
    expect(mocks.wsConnect).toHaveBeenCalledWith('draft-session')
    expect(useSessionRuntimeStore.getState().selections['draft-session']).toBeUndefined()
  })

  it('stores and replays a draft runtime only when the user explicitly selected one', async () => {
    useSessionRuntimeStore.getState().setSelection('__draft__', {
      providerId: 'provider-explicit',
      modelId: 'model-explicit',
    })

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({})
    })

    expect(useSessionRuntimeStore.getState().selections['draft-session']).toEqual({
      providerId: 'provider-explicit',
      modelId: 'model-explicit',
    })
    expect(useSessionRuntimeStore.getState().selections['__draft__']).toBeUndefined()
    expect(mocks.wsSend.mock.calls.slice(0, 2)).toEqual([
      [
        'draft-session',
        {
          type: 'set_runtime_config',
          providerId: 'provider-explicit',
          modelId: 'model-explicit',
        },
      ],
      ['draft-session', { type: 'prewarm_session' }],
    ])
  })

  it('starts in a selected non-Git project without showing a repository warning', async () => {
    mocks.getRepositoryContext.mockResolvedValueOnce(notGitRepositoryContext())

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Run/i })).not.toBeDisabled()
    })

    expect(screen.queryByText('Current project is not a Git repository.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Select branch:/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Current worktree')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
      })
    })
  })

  it('shows an actionable repository error when direct branch switching is blocked', async () => {
    mocks.createSession.mockRejectedValueOnce(new ApiError(400, {
      error: 'REPOSITORY_DIRTY_WORKTREE',
      message: 'Working tree has uncommitted changes.',
    }))

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }))

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      const toasts = useUIStore.getState().toasts
      expect(toasts[toasts.length - 1]?.message).toBe(
        'Current project has uncommitted changes. Direct branch switching was blocked; enable "Isolated worktree" or commit/stash your changes first.',
      )
    })
    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it('keeps Run disabled until repository context resolves for a selected project', async () => {
    let resolveContext: (context: RepositoryContextResult) => void = () => {}
    mocks.getRepositoryContext.mockImplementationOnce(() => new Promise<RepositoryContextResult>((resolve) => {
      resolveContext = resolve
    }))

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Run/i })).toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))
    expect(mocks.createSession).not.toHaveBeenCalled()

    resolveContext(okRepositoryContext())

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Run/i })).not.toBeDisabled()
    })
  })

  it('falls back to a visible branch when the current branch is an internal desktop worktree branch', async () => {
    mocks.getRepositoryContext.mockResolvedValueOnce(okRepositoryContext({
      currentBranch: 'worktree-desktop-feature-a-12345678',
      defaultBranch: 'main',
      branches: [
        {
          name: 'main',
          current: false,
          local: true,
          remote: false,
          checkedOut: false,
        },
        {
          name: 'feature/a',
          current: false,
          local: true,
          remote: false,
          checkedOut: false,
        },
      ],
      worktrees: [{
        path: '/workspace/project/.claude/worktrees/desktop-feature-a-12345678',
        branch: 'worktree-desktop-feature-a-12345678',
        current: true,
      }],
    }))

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }))

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    expect(screen.queryByText('worktree-desktop-feature-a-12345678')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        repository: { branch: 'main', worktree: false },
      })
    })
  })

  it('keeps the repository launch context on one row and truncates long branch names', async () => {
    const longBranch = 'feature/super-long-branch-name-for-repository-launch-controls-e2e'
    mocks.getRepositoryContext.mockResolvedValueOnce(okRepositoryContext({
      currentBranch: longBranch,
      defaultBranch: 'main',
      branches: [{
        name: longBranch,
        current: true,
        local: true,
        remote: false,
        checkedOut: true,
        worktreePath: '/workspace/project',
      }],
      worktrees: [{
        path: '/workspace/project',
        branch: longBranch,
        current: true,
      }],
    }))

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }))

    const branchButton = await screen.findByRole('button', { name: new RegExp(`Select branch: ${longBranch}`) })
    const branchClasses = branchButton.className.split(/\s+/)
    expect(branchButton.parentElement?.className).toContain('flex-nowrap')
    expect(branchButton.parentElement?.className).not.toContain('flex-wrap')
    expect(branchClasses).toContain('max-w-[260px]')
    expect(branchClasses).not.toContain('max-w-full')
    expect(branchButton.querySelector('span')?.className).toContain('truncate')
  })

  it('keeps current worktree selectable when the fallback branch is checked out elsewhere', async () => {
    mocks.getRepositoryContext.mockResolvedValueOnce(okRepositoryContext({
      currentBranch: null,
      defaultBranch: 'main',
      branches: [
        {
          name: 'main',
          current: false,
          local: true,
          remote: false,
          checkedOut: true,
          worktreePath: '/workspace/project',
        },
        {
          name: 'feature/a',
          current: false,
          local: true,
          remote: false,
          checkedOut: false,
        },
      ],
      worktrees: [{
        path: '/workspace/project/.codex/worktrees/detached/project',
        branch: null,
        current: true,
      }],
    }))

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'draft question', selectionStart: 14 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }))

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
      expect(screen.getByText('Current worktree')).toBeInTheDocument()
    })

    expect(screen.getByText('Selected branch is already checked out in another worktree. Direct launch may be blocked by Git; use "Isolated worktree" to avoid changing directories.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Select worktree mode: Current worktree/ }))
    expect(await screen.findByRole('option', { name: 'Current worktree' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Run/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        workDir: '/workspace/project',
        repository: { branch: 'main', worktree: false },
      })
    })
  })
})
