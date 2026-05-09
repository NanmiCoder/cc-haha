import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import '@testing-library/jest-dom'

import { skillsApi } from '../api/skills'
import { mcpApi } from '../api/mcp'
import { sessionsApi } from '../api/sessions'
import { useUIStore } from '../stores/uiStore'

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: vi.fn(async () => ({ skills: [] })),
  },
}))

vi.mock('../api/providers', () => ({
  providersApi: {
    list: vi.fn(async () => ({ providers: [], activeId: null })),
  },
}))

vi.mock('../api/mcp', () => ({
  mcpApi: {
    list: vi.fn(async () => ({ servers: [] })),
    status: vi.fn(async (name: string) => ({
      server: {
        name,
        scope: 'user',
        transport: 'http',
        enabled: true,
        status: 'connected',
        statusLabel: 'Connected',
        configLocation: 'User',
        summary: 'https://mcp.example.com/mcp',
        canEdit: true,
        canRemove: true,
        canReconnect: true,
        canToggle: true,
        config: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
      },
    })),
  },
}))

vi.mock('../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getInspection: vi.fn(async () => ({
        active: true,
        status: {
          sessionId: 'status-panel-session',
          workDir: '/workspace/project',
          cwd: '/workspace/project',
          permissionMode: 'bypassPermissions',
          model: 'kimi-k2.6',
          version: '999.0.0-local',
          apiKeySource: 'ANTHROPIC_API_KEY',
          outputStyle: 'default',
          mcpServers: [
            { name: 'deepwiki', status: 'connected' },
            { name: 'chatLog', status: 'failed' },
          ],
          tools: [{ name: 'Read' }, { name: 'Bash' }],
          slashCommandCount: 3,
        },
      })),
    },
  }
})

// Import all pages
import { EmptySession } from '../pages/EmptySession'
import { ActiveSession } from '../pages/ActiveSession'
import { AgentTeams } from '../pages/AgentTeams'
import { ScheduledTasks } from '../pages/ScheduledTasks'
import { ToolInspection } from '../pages/ToolInspection'

// Layout components (chrome is now here, not in pages)
import { Sidebar } from '../components/layout/Sidebar'
import { UserMessage } from '../components/chat/UserMessage'
import { ContextUsageIndicator } from '../components/chat/ContextUsageIndicator'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useProviderStore } from '../stores/providerStore'
import { useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { useTabStore } from '../stores/tabStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useProviderStore.setState({
    providers: [],
    activeId: null,
    hasLoadedProviders: true,
    isLoading: false,
  })
  useSessionRuntimeStore.setState({ selections: {} })
})

afterEach(async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  cleanup()
})

function resetPageStores() {
  cleanup()
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
  useChatStore.setState({ sessions: {} })
}

/**
 * Core rendering tests: content-only pages must render without crashing
 * and contain key structural elements from the prototype.
 */
describe('Content-only pages render without errors', () => {
  it('EmptySession slash picker includes dynamic skills before the first session starts', async () => {
    vi.mocked(skillsApi.list).mockResolvedValueOnce({
      skills: [
        {
          name: 'lark-mail',
          description: 'Draft, send, and search emails',
          source: 'user',
          userInvocable: true,
          contentLength: 120,
          hasDirectory: true,
        },
        {
          name: 'internal-only',
          description: 'Should stay hidden',
          source: 'user',
          userInvocable: false,
          contentLength: 60,
          hasDirectory: true,
        },
      ],
    })

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '/', selectionStart: 1 },
    })

    expect(await screen.findByText('/lark-mail')).toBeInTheDocument()
    expect(screen.getByText('/mcp')).toBeInTheDocument()
    expect(screen.getByText('/skills')).toBeInTheDocument()
    expect(screen.getByText('/help')).toBeInTheDocument()
    expect(screen.getByText('/plugin')).toBeInTheDocument()
    expect(screen.getByText('/context')).toBeInTheDocument()
    expect(screen.queryByText('/plugins')).not.toBeInTheDocument()
    expect(screen.queryByText('/internal-only')).not.toBeInTheDocument()
  })

  it('EmptySession renders mascot and composer', async () => {
    let container!: HTMLElement
    await act(async () => {
      container = render(<EmptySession />).container
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('textarea')).toBeInTheDocument()
    expect(container.innerHTML).toContain('New session')
    expect(container.innerHTML).toContain('Ask anything')
  })

  it('EmptySession shows draft context usage before a session is created', async () => {
    render(<EmptySession />)

    const indicator = await screen.findByLabelText('Context usage not calculated')
    expect(indicator).toHaveTextContent('--')
    expect(vi.mocked(sessionsApi.getInspection)).not.toHaveBeenCalled()
  })

  it('ContextUsageIndicator does not render a first-paint spinner for draft sessions', () => {
    const html = renderToStaticMarkup(
      <ContextUsageIndicator
        chatState="idle"
        messageCount={0}
        fallbackModelLabel="kimi-k2.6"
        draft
      />,
    )

    expect(html).toMatch(/aria-label="(Context usage not calculated|上下文用量待计算)"/)
    expect(html).toContain('--')
    expect(html).not.toContain('animate-spin')
  })

  it('EmptySession plus menu exposes uploads and slash commands before chat starts', async () => {
    await act(async () => {
      render(<EmptySession />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
      await Promise.resolve()
    })
    expect(screen.getByText('Add files or photos')).toBeInTheDocument()
    expect(screen.getByText('Slash commands')).toBeInTheDocument()
  })

  it('ActiveSession renders with chat components', () => {
    const SESSION_ID = 'test-active-session'
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    const { container } = render(<ActiveSession />)
    // With empty messages, the hero is shown
    expect(container.innerHTML).toContain('New session')
    // ChatInput has a textarea
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeInTheDocument()
    expect(textarea).toHaveAttribute('placeholder', 'Ask anything...')
    expect(textarea).toHaveAttribute('rows', '2')
    expect(container.innerHTML).not.toContain('Preview')
    // Cleanup
    resetPageStores()
  })

  it('ActiveSession keeps the compact composer once messages exist', () => {
    const SESSION_ID = 'test-active-session-with-messages'
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [{
            id: 'msg-1',
            type: 'user_text',
            content: 'hello',
            timestamp: Date.now(),
          }],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: null,
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })

    render(<ActiveSession />)

    const textarea = screen.getByPlaceholderText('Ask Claude to edit, debug or explain...')
    expect(textarea).toHaveAttribute('rows', '1')

    resetPageStores()
  })

  it('ActiveSession shows a single primary action button while a turn is active', () => {
    useTabStore.setState({ activeTabId: 'active-tab', tabs: [{ sessionId: 'active-tab', title: 'Test', type: 'session' as const, status: 'idle' }] })
    useChatStore.setState({
      sessions: {
        'active-tab': {
          messages: [],
          chatState: 'thinking',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    render(<ActiveSession />)

    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument()
    resetPageStores()
  })

  it('ActiveSession opens a local /mcp panel and clicking an item routes to settings', async () => {
    const SESSION_ID = 'mcp-panel-session'
    const sendMessage = vi.fn()
    vi.mocked(mcpApi.list).mockResolvedValueOnce({
      servers: [
        {
          name: 'deepwiki',
          scope: 'user',
          transport: 'http',
          enabled: true,
          status: 'connected',
          statusLabel: 'Connected',
          configLocation: '/tmp/config',
          summary: 'https://mcp.deepwiki.com/mcp',
          canEdit: true,
          canRemove: true,
          canReconnect: true,
          canToggle: true,
          config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp', headers: {} },
        },
      ],
    })
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/mcp', selectionStart: 4 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText('Available MCP tools')).toBeInTheDocument()
    fireEvent.click(screen.getByText('deepwiki'))
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
    expect(useUIStore.getState().pendingSettingsTab).toBe('mcp')

    resetPageStores()
  })

  it('ActiveSession opens a local /skills panel from the fallback slash commands', async () => {
    const SESSION_ID = 'skills-panel-session'
    const sendMessage = vi.fn()
    vi.mocked(skillsApi.list).mockResolvedValueOnce({
      skills: [
        {
          name: 'lark-mail',
          description: 'Draft, send, and search emails',
          source: 'user',
          userInvocable: true,
          contentLength: 120,
          hasDirectory: true,
        },
      ],
    })
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/skills', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText('Available skills')).toBeInTheDocument()
    expect(screen.getByText('/lark-mail')).toBeInTheDocument()

    resetPageStores()
  })

  it('ActiveSession routes /plugin to Settings > Plugins instead of sending a chat message', () => {
    const SESSION_ID = 'plugin-panel-session'
    const sendMessage = vi.fn()
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/plugin', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
    expect(useUIStore.getState().pendingSettingsTab).toBe('plugins')

    resetPageStores()
  })

  it('ActiveSession routes /help to the local command panel', () => {
    const SESSION_ID = 'help-panel-session'
    const sendMessage = vi.fn()
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [
            { name: 'cost', description: 'Show token usage and costs' },
            ...Array.from({ length: 14 }, (_, index) => ({
              name: `extra-${index + 1}`,
              description: `Extra command ${index + 1}`,
            })),
          ],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/help', selectionStart: 5 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByText('Slash commands')).toBeInTheDocument()
    expect(screen.getByText('/clear')).toBeInTheDocument()
    expect(screen.getByText('/cost')).toBeInTheDocument()
    expect(screen.getByText('13 more commands available. Type / to search the full command list.')).toBeInTheDocument()

    resetPageStores()
  })

  it('ActiveSession /status inspector uses theme tokens instead of fixed light colors', async () => {
    const SESSION_ID = 'status-panel-session'
    const sendMessage = vi.fn()
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    const { container } = render(<ActiveSession />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/status', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText('Session inspector')).toBeInTheDocument()
    expect(vi.mocked(sessionsApi.getInspection)).toHaveBeenCalledWith(SESSION_ID, { includeContext: false })
    expect(container.innerHTML).toContain('bg-[var(--color-inspector-surface)]')
    expect(container.innerHTML).not.toContain('bg-[#fbfaf6]')
    expect(container.innerHTML).not.toContain('bg-[#f4f2ed]')
    expect(container.innerHTML).not.toContain('border-[#d8b3a8]')

    resetPageStores()
  })

  it('ActiveSession shows live context usage near the composer', async () => {
    const SESSION_ID = 'context-indicator-session'
    vi.mocked(sessionsApi.getInspection).mockResolvedValueOnce({
      active: true,
      status: {
        sessionId: SESSION_ID,
        workDir: '/workspace/project',
        cwd: '/workspace/project',
        permissionMode: 'bypassPermissions',
        model: 'kimi-k2.6',
      },
      context: {
        categories: [
          { name: 'Messages', tokens: 42_000, color: '#2D628F' },
          { name: 'Tools', tokens: 8_000, color: '#8F482F' },
          { name: 'Free space', tokens: 70_000, color: '#9B928C' },
        ],
        totalTokens: 50_000,
        maxTokens: 120_000,
        rawMaxTokens: 120_000,
        percentage: 42,
        gridRows: [],
        model: 'kimi-k2.6',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      },
    })

    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [{ id: 'm-1', type: 'assistant_text', content: 'done', timestamp: Date.now() }],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 50_000, output_tokens: 1_000 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    expect(await screen.findByLabelText('Context usage 42%')).toBeInTheDocument()
    expect(screen.getByText('120,000')).toBeInTheDocument()
    expect(vi.mocked(sessionsApi.getInspection)).toHaveBeenCalledWith(SESSION_ID, {
      includeContext: true,
      contextOnly: true,
      timeout: 20_000,
    })

    resetPageStores()
  })

  it('ActiveSession keeps a stable context placeholder while context usage loads', async () => {
    const SESSION_ID = 'context-loading-session'
    vi.mocked(sessionsApi.getInspection).mockImplementationOnce(() => new Promise(() => {}))

    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    const indicator = await screen.findByLabelText('Context usage loading')
    expect(indicator).toHaveTextContent('--')
    expect(indicator).toHaveClass('h-8')

    resetPageStores()
  })

  it('ActiveSession treats an empty idle session without a running CLI as pending context', async () => {
    const SESSION_ID = 'context-empty-idle-session'
    vi.mocked(sessionsApi.getInspection).mockResolvedValueOnce({
      active: false,
      status: {
        sessionId: SESSION_ID,
        workDir: '/workspace/project',
        cwd: '/workspace/project',
        permissionMode: 'bypassPermissions',
        model: 'kimi-k2.6',
      },
      errors: {
        context: 'CLI session is not running',
      },
    })

    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    const indicator = await screen.findByLabelText('Context usage not calculated')
    expect(indicator).toHaveTextContent('--')
    expect(screen.getAllByText('kimi-k2.6').length).toBeGreaterThan(0)
    expect(screen.getByText('Context usage will be calculated after the session starts.')).toBeInTheDocument()
    expect(screen.queryByText('CLI session is not running')).not.toBeInTheDocument()

    resetPageStores()
  })

  it('ActiveSession shows initial context usage for an empty live session', async () => {
    const SESSION_ID = 'context-empty-live-session'
    vi.mocked(sessionsApi.getInspection).mockResolvedValueOnce({
      active: true,
      status: {
        sessionId: SESSION_ID,
        workDir: '/workspace/project',
        cwd: '/workspace/project',
        permissionMode: 'bypassPermissions',
        model: 'kimi-k2.6',
      },
      context: {
        categories: [
          { name: 'System prompt', tokens: 6_800, color: '#8a8a8a' },
          { name: 'System tools', tokens: 13_200, color: '#9B928C' },
          { name: 'MCP tools', tokens: 8_000, color: '#06b6d4' },
          { name: 'Free space', tokens: 100_000, color: '#9B928C', isDeferred: true },
        ],
        totalTokens: 28_000,
        maxTokens: 128_000,
        rawMaxTokens: 128_000,
        percentage: 22,
        gridRows: [],
        model: 'kimi-k2.6',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      },
    })

    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    const indicator = await screen.findByLabelText('Context usage 22%')
    expect(indicator).toHaveTextContent('22%')
    expect(screen.getAllByText('kimi-k2.6').length).toBeGreaterThan(0)
    expect(screen.queryByText('Context usage will be calculated after the session starts.')).not.toBeInTheDocument()

    resetPageStores()
  })

  it('ActiveSession shows context estimate during compaction or reconnect fallback', async () => {
    const SESSION_ID = 'context-estimate-session'
    vi.mocked(sessionsApi.getInspection).mockResolvedValueOnce({
      active: false,
      status: {
        sessionId: SESSION_ID,
        workDir: '/workspace/project',
        cwd: '/workspace/project',
        permissionMode: 'bypassPermissions',
        model: 'deepseek-v4-pro',
      },
      contextEstimate: {
        categories: [
          { name: 'Messages', tokens: 72_000, color: '#2D628F' },
          { name: 'Autocompact buffer', tokens: 24_000, color: '#9B928C', isDeferred: true },
        ],
        totalTokens: 72_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 7,
        gridRows: [],
        model: 'deepseek-v4-pro',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
      },
      errors: {
        context: 'CLI session is not running',
      },
    })

    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 4,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [
            { id: 'm-1', type: 'system', content: 'Context compacted', timestamp: Date.now() },
            { id: 'm-2', type: 'assistant_text', content: 'ready', timestamp: Date.now() },
          ],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 72_000, output_tokens: 2_000 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    expect(await screen.findByLabelText('Context usage 7%')).toBeInTheDocument()
    expect(screen.getByText('deepseek-v4-pro')).toBeInTheDocument()
    expect(screen.getByText('1,000,000')).toBeInTheDocument()
    expect(screen.getByText('Estimate')).toBeInTheDocument()
    expect(screen.queryByText('Autocompact buffer')).not.toBeInTheDocument()

    resetPageStores()
  })

  it('ActiveSession keeps selected runtime model visible when context is unavailable', async () => {
    const SESSION_ID = 'context-unavailable-model-session'
    vi.mocked(sessionsApi.getInspection).mockResolvedValueOnce({
      active: false,
      status: {
        sessionId: SESSION_ID,
        workDir: '/workspace/project',
        cwd: '/workspace/project',
        permissionMode: 'bypassPermissions',
      },
      errors: {
        context: 'CLI session is not running',
      },
    })

    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useSessionRuntimeStore.getState().setSelection(SESSION_ID, {
      providerId: 'volcengine-provider',
      modelId: 'kimi-k2.6',
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [{ id: 'm-1', type: 'assistant_text', content: 'ready', timestamp: Date.now() }],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    render(<ActiveSession />)

    expect(await screen.findByLabelText('Context usage unavailable')).toBeInTheDocument()
    expect(screen.getAllByText('kimi-k2.6').length).toBeGreaterThan(0)
    expect(screen.queryByText('Unknown model')).not.toBeInTheDocument()

    resetPageStores()
    useSessionRuntimeStore.setState({ selections: {} })
  })

  it('ActiveSession refreshes context usage when the selected runtime model changes', async () => {
    const SESSION_ID = 'context-runtime-refresh-session'
    vi.mocked(sessionsApi.getInspection)
      .mockResolvedValueOnce({
        active: true,
        status: {
          sessionId: SESSION_ID,
          workDir: '/workspace/project',
          cwd: '/workspace/project',
          permissionMode: 'bypassPermissions',
          model: 'kimi-k2.6',
        },
        context: {
          categories: [{ name: 'Messages', tokens: 26_000, color: '#2D628F' }],
          totalTokens: 26_000,
          maxTokens: 262_144,
          rawMaxTokens: 262_144,
          percentage: 10,
          gridRows: [],
          model: 'kimi-k2.6',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
        },
      })
      .mockResolvedValueOnce({
        active: true,
        status: {
          sessionId: SESSION_ID,
          workDir: '/workspace/project',
          cwd: '/workspace/project',
          permissionMode: 'bypassPermissions',
          model: 'glm-4.5-air',
        },
        context: {
          categories: [{ name: 'Messages', tokens: 26_000, color: '#2D628F' }],
          totalTokens: 26_000,
          maxTokens: 128_000,
          rawMaxTokens: 128_000,
          percentage: 20,
          gridRows: [],
          model: 'glm-4.5-air',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
        },
      })

    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [{ id: 'm-1', type: 'assistant_text', content: 'done', timestamp: Date.now() }],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 26_000, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    const inspectionCallsBeforeRender = vi.mocked(sessionsApi.getInspection).mock.calls.length
    render(<ActiveSession />)

    expect(await screen.findByLabelText('Context usage 10%')).toBeInTheDocument()

    act(() => {
      useSessionRuntimeStore.getState().setSelection(SESSION_ID, {
        providerId: 'zhipu-provider',
        modelId: 'glm-4.5-air',
      })
    })

    expect(await screen.findByLabelText('Context usage 20%')).toBeInTheDocument()
    await waitFor(() => {
      expect(vi.mocked(sessionsApi.getInspection).mock.calls.length - inspectionCallsBeforeRender)
        .toBeGreaterThanOrEqual(2)
    })

    resetPageStores()
    useSessionRuntimeStore.setState({ selections: {} })
  })

  it('AgentTeams renders team strip and members', () => {
    const { container } = render(<AgentTeams />)
    expect(container.innerHTML).toContain('Architect')
    expect(container.innerHTML).toContain('session-dev')
    expect(container.innerHTML).toContain('groups')
  })

  it('ScheduledTasks renders (store-connected)', async () => {
    const { container } = render(<ScheduledTasks />)
    await screen.findByText('Scheduled tasks')
    expect(container.innerHTML).toContain('Scheduled tasks')
  })

  it('ToolInspection renders diff viewer', () => {
    const { container } = render(<ToolInspection />)
    expect(container.innerHTML).toContain('edit_file')
    expect(container.innerHTML).toContain('Split')
    expect(container.innerHTML).toContain('Unified')
  })
})

describe('Chat attachments', () => {
  it('UserMessage opens image gallery when an attachment is clicked', () => {
    render(
      <UserMessage
        content=""
        attachments={[
          {
            type: 'image',
            name: 'diagram.png',
            data: 'data:image/png;base64,abc123',
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('diagram.png')).toBeInTheDocument()
  })
})

describe('AppShell layout renders chrome', () => {
  it('AppShell renders sidebar and session shell', () => {
    useSessionStore.setState({
      fetchSessions: vi.fn(async () => {}),
    } as Partial<ReturnType<typeof useSessionStore.getState>>)

    const { container } = render(<Sidebar />)
    expect(container.querySelector('aside')).toBeInTheDocument()
    expect(container.innerHTML).toContain('New session')
    expect(container.innerHTML).toContain('Scheduled')
    expect(container.innerHTML).toContain('All projects')
  })
})

describe('Design system compliance', () => {
  it('Pages use Material Symbols Outlined icons', () => {
    const pages = [EmptySession, AgentTeams, ToolInspection]
    for (const Page of pages) {
      const { container, unmount } = render(<Page />)
      const icons = container.querySelectorAll('.material-symbols-outlined')
      expect(icons.length).toBeGreaterThan(0)
      unmount()
    }
  })

  it('Current brand color is used in content pages', () => {
    const pages = [EmptySession]
    for (const Page of pages) {
      const { container, unmount } = render(<Page />)
      const html = container.innerHTML
      expect(
        html.includes('C47A5A') ||
        html.includes('8F482F') ||
        html.includes('var(--color-brand)') ||
        html.includes('bg-[var(--color-brand)]') ||
        html.includes('var(--gradient-btn-primary)'),
      ).toBe(true)
      unmount()
    }
  })
})

describe('Mock data integration', () => {
  it('AgentTeams shows team members from mock data', () => {
    const { container } = render(<AgentTeams />)
    expect(container.innerHTML).toContain('Architect')
    expect(container.innerHTML).toContain('Frontend Dev')
    expect(container.innerHTML).toContain('Backend Dev')
    expect(container.innerHTML).toContain('Tester')
  })
})
