import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { usePluginStore } from '../stores/pluginStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useUIStore } from '../stores/uiStore'

const MOCK_FETCH_SKILLS = vi.fn()
const MOCK_FETCH_SKILL_DETAIL = vi.fn()
const MOCK_FETCH_AGENTS = vi.fn()
const MOCK_FETCH_SERVERS = vi.fn()

vi.mock('../api/agents', () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }),
  },
}))

vi.mock('../stores/providerStore', () => ({
  useProviderStore: () => ({
    providers: [],
    activeId: null,
    presets: [],
    isLoading: false,
    isPresetsLoading: false,
    fetchProviders: vi.fn(),
    fetchPresets: vi.fn(),
    deleteProvider: vi.fn(),
    activateProvider: vi.fn(),
    activateOfficial: vi.fn(),
    testProvider: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    testConfig: vi.fn(),
  }),
}))

vi.mock('../pages/AdapterSettings', () => ({
  AdapterSettings: () => <div>Adapter Settings Mock</div>,
}))

vi.mock('../stores/agentStore', () => ({
  useAgentStore: Object.assign((selector?: (state: any) => unknown) => {
    const state = {
      activeAgents: [],
      allAgents: [],
      isLoading: false,
      error: null,
      selectedAgent: null,
      fetchAgents: MOCK_FETCH_AGENTS,
      selectAgent: vi.fn(),
    }
    return selector ? selector(state) : state
  }, {
    getState: () => ({
      activeAgents: [],
      allAgents: [],
      isLoading: false,
      error: null,
      selectedAgent: null,
      fetchAgents: MOCK_FETCH_AGENTS,
      selectAgent: vi.fn(),
    }),
  }),
}))

vi.mock('../stores/skillStore', () => ({
  useSkillStore: Object.assign((selector?: (state: any) => unknown) => {
    const state = {
      skills: [],
      selectedSkill: null,
      isLoading: false,
      isDetailLoading: false,
      error: null,
      catalog: [],
      isCatalogLoading: false,
      installingName: null,
      fetchSkills: MOCK_FETCH_SKILLS,
      fetchSkillDetail: MOCK_FETCH_SKILL_DETAIL,
      fetchCatalog: vi.fn(async () => {}),
      installSkill: vi.fn(async () => {}),
      clearSelection: vi.fn(),
    }
    return selector ? selector(state) : state
  }, {
    getState: () => ({
      skills: [],
      selectedSkill: null,
      isLoading: false,
      isDetailLoading: false,
      error: null,
      catalog: [],
      isCatalogLoading: false,
      installingName: null,
      fetchSkills: MOCK_FETCH_SKILLS,
      fetchSkillDetail: MOCK_FETCH_SKILL_DETAIL,
      fetchCatalog: vi.fn(async () => {}),
      installSkill: vi.fn(async () => {}),
      clearSelection: vi.fn(),
    }),
  }),
}))

vi.mock('../stores/mcpStore', () => ({
  useMcpStore: Object.assign((selector?: (state: any) => unknown) => {
    const state = {
      servers: [],
      selectedServer: null,
      isLoading: false,
      error: null,
      fetchServers: MOCK_FETCH_SERVERS,
      createServer: vi.fn(),
      updateServer: vi.fn(),
      deleteServer: vi.fn(),
      toggleServer: vi.fn(),
      reconnectServer: vi.fn(),
      selectServer: vi.fn(),
    }
    return selector ? selector(state) : state
  }, {
    getState: () => ({
      servers: [],
      selectedServer: null,
      isLoading: false,
      error: null,
      fetchServers: MOCK_FETCH_SERVERS,
      createServer: vi.fn(),
      updateServer: vi.fn(),
      deleteServer: vi.fn(),
      toggleServer: vi.fn(),
      reconnectServer: vi.fn(),
      selectServer: vi.fn(),
    }),
  }),
}))

const noop = vi.fn()

function switchToPluginsTab() {
  fireEvent.click(screen.getByText('Plugins'))
}

describe('Settings > Plugins tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ pendingSettingsTab: null })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Active session',
          createdAt: '2026-04-20T00:00:00.000Z',
          modifiedAt: '2026-04-20T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
      activeSessionId: 'session-1',
      isLoading: false,
      error: null,
    })
    usePluginStore.setState({
      plugins: [],
      marketplaces: [],
      summary: { total: 0, enabled: 0, errorCount: 0, marketplaceCount: 0 },
      selectedPlugin: null,
      lastReloadSummary: null,
      isLoading: false,
      isDetailLoading: false,
      isApplying: false,
      error: null,
      catalog: [],
      installingCatalogId: null,
      isAddingMarketplace: false,
      fetchPlugins: noop,
      fetchPluginDetail: noop,
      fetchCatalog: vi.fn().mockResolvedValue(undefined),
      installCatalogPlugin: vi.fn().mockResolvedValue('installed'),
      addMarketplaceFromInput: vi.fn().mockResolvedValue({ name: 'mock', alreadyMaterialized: true }),
      reloadPlugins: vi.fn().mockResolvedValue({
        enabled: 1,
        disabled: 0,
        skills: 2,
        agents: 1,
        hooks: 0,
        mcpServers: 1,
        lspServers: 0,
        errors: 0,
      }),
      enablePlugin: vi.fn().mockResolvedValue('enabled'),
      disablePlugin: vi.fn().mockResolvedValue('disabled'),
      bulkEnablePlugins: vi.fn().mockResolvedValue(0),
      bulkDisablePlugins: vi.fn().mockResolvedValue(0),
      updatePlugin: vi.fn().mockResolvedValue('updated'),
      uninstallPlugin: vi.fn().mockResolvedValue('uninstalled'),
      clearSelection: vi.fn(),
    })
  })

  it('renders plugin browser summary and grouped cards', () => {
    usePluginStore.setState({
      plugins: [
        {
          id: 'github@claude-plugins-official',
          name: 'github',
          marketplace: 'claude-plugins-official',
          scope: 'user',
          enabled: true,
          hasErrors: false,
          isBuiltin: false,
          version: '1.2.3',
          description: 'GitHub integration',
          authorName: 'Anthropic',
          componentCounts: {
            commands: 1,
            agents: 1,
            skills: 2,
            hooks: 0,
            mcpServers: 1,
            lspServers: 0,
          },
          errors: [],
        },
        {
          id: 'pyright-lsp@claude-plugins-official',
          name: 'pyright-lsp',
          marketplace: 'claude-plugins-official',
          scope: 'project',
          enabled: false,
          hasErrors: true,
          isBuiltin: false,
          description: 'Python language tooling',
          componentCounts: {
            commands: 0,
            agents: 0,
            skills: 0,
            hooks: 0,
            mcpServers: 0,
            lspServers: 1,
          },
          errors: ['Executable not found in $PATH'],
        },
      ],
      marketplaces: [
        {
          name: 'claude-plugins-official',
          source: 'github:anthropics/claude-plugins-official',
          autoUpdate: true,
          installedCount: 2,
        },
      ],
      summary: { total: 2, enabled: 1, errorCount: 1, marketplaceCount: 1 },
    })

    render(<Settings />)
    switchToPluginsTab()

    expect(screen.getByText('Browse installed plugins')).toBeInTheDocument()
    expect(screen.getByText('Plugin Manager')).toBeInTheDocument()
    expect(screen.getByText('Language Servers')).toBeInTheDocument()
    expect(screen.getByText('Install LSP plugins to add diagnostics, go-to-definition, references, and other code intelligence to the workspace editor.')).toBeInTheDocument()
    expect(screen.getAllByText('pyright-lsp').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1 LSP servers').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0)
    expect(screen.getByText('github')).toBeInTheDocument()
    expect(screen.getAllByText('Python language tooling').length).toBeGreaterThan(0)
    expect(screen.getByText('Known marketplaces')).toBeInTheDocument()
  })

  it('bulk enables selected disabled plugins from the list after confirmation', async () => {
    const bulkEnablePlugins = vi.fn().mockResolvedValue(2)
    usePluginStore.setState({
      plugins: [
        {
          id: 'drawing@claude-plugins-official',
          name: 'drawing',
          marketplace: 'claude-plugins-official',
          scope: 'user',
          enabled: false,
          hasErrors: false,
          isBuiltin: false,
          description: 'Render diagrams.',
          componentCounts: {
            commands: 0,
            agents: 0,
            skills: 1,
            hooks: 0,
            mcpServers: 0,
            lspServers: 0,
          },
          errors: [],
        },
        {
          id: 'review@claude-plugins-official',
          name: 'review',
          marketplace: 'claude-plugins-official',
          scope: 'project',
          enabled: false,
          hasErrors: false,
          isBuiltin: false,
          description: 'Review pull requests.',
          componentCounts: {
            commands: 0,
            agents: 1,
            skills: 0,
            hooks: 0,
            mcpServers: 0,
            lspServers: 0,
          },
          errors: [],
        },
        {
          id: 'github@claude-plugins-official',
          name: 'github',
          marketplace: 'claude-plugins-official',
          scope: 'user',
          enabled: true,
          hasErrors: false,
          isBuiltin: false,
          description: 'GitHub integration',
          componentCounts: {
            commands: 1,
            agents: 0,
            skills: 0,
            hooks: 0,
            mcpServers: 1,
            lspServers: 0,
          },
          errors: [],
        },
      ],
      summary: { total: 3, enabled: 1, errorCount: 0, marketplaceCount: 1 },
      bulkEnablePlugins,
    })

    render(<Settings />)
    switchToPluginsTab()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select drawing' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable selected' }))

    expect(screen.getByText('Enable 2 selected plugins?')).toBeInTheDocument()
    expect(screen.getByText('This will enable drawing, review and apply plugin changes to the current desktop runtime.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    await waitFor(() => {
      expect(bulkEnablePlugins).toHaveBeenCalledWith(
        [
          { id: 'drawing@claude-plugins-official', scope: 'user' },
          { id: 'review@claude-plugins-official', scope: 'project' },
        ],
        '/workspace/project',
        'session-1',
      )
    })

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Select drawing' })).not.toBeChecked()
      expect(screen.queryByText('2 selected')).not.toBeInTheDocument()
    })
  })

  it('bulk disables selected enabled plugins from the list after confirmation', async () => {
    const bulkDisablePlugins = vi.fn().mockResolvedValue(1)
    usePluginStore.setState({
      plugins: [
        {
          id: 'github@claude-plugins-official',
          name: 'github',
          marketplace: 'claude-plugins-official',
          scope: 'user',
          enabled: true,
          hasErrors: false,
          isBuiltin: false,
          description: 'GitHub integration',
          componentCounts: {
            commands: 1,
            agents: 0,
            skills: 0,
            hooks: 0,
            mcpServers: 1,
            lspServers: 0,
          },
          errors: [],
        },
        {
          id: 'drawing@claude-plugins-official',
          name: 'drawing',
          marketplace: 'claude-plugins-official',
          scope: 'user',
          enabled: false,
          hasErrors: false,
          isBuiltin: false,
          description: 'Render diagrams.',
          componentCounts: {
            commands: 0,
            agents: 0,
            skills: 1,
            hooks: 0,
            mcpServers: 0,
            lspServers: 0,
          },
          errors: [],
        },
      ],
      summary: { total: 2, enabled: 1, errorCount: 0, marketplaceCount: 1 },
      bulkDisablePlugins,
    })

    render(<Settings />)
    switchToPluginsTab()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select github' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable selected' }))

    expect(screen.getByText('Disable 1 selected plugins?')).toBeInTheDocument()
    expect(screen.getByText('This will disable github and apply plugin changes to the current desktop runtime.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))

    await waitFor(() => {
      expect(bulkDisablePlugins).toHaveBeenCalledWith(
        [
          { id: 'github@claude-plugins-official', scope: 'user' },
        ],
        '/workspace/project',
        'session-1',
      )
    })
  })

  it('renders plugin detail with bundled capability sections', () => {
    usePluginStore.setState({
      selectedPlugin: {
        id: 'github@claude-plugins-official',
        name: 'github',
        marketplace: 'claude-plugins-official',
        scope: 'user',
        enabled: true,
        hasErrors: false,
        isBuiltin: false,
        version: '1.2.3',
        description: 'GitHub integration',
        authorName: 'Anthropic',
        installPath: '/Users/test/.claude/plugins/cache/github',
        componentCounts: {
          commands: 1,
          agents: 1,
          skills: 2,
          hooks: 1,
          mcpServers: 1,
          lspServers: 1,
        },
        capabilities: {
          commands: ['review-pr'],
          agents: ['pr-reviewer'],
          skills: ['commit', 'create-pr'],
          hooks: ['SessionStart'],
          mcpServers: ['github-api'],
          lspServers: ['github-lsp'],
        },
        commandEntries: [
          {
            name: 'review-pr',
            description: 'Review the current pull request.',
          },
        ],
        agentEntries: [
          {
            name: 'pr-reviewer',
            description: 'Review pull request quality and risk.',
          },
        ],
        hookEntries: [
          {
            event: 'SessionStart',
            matcher: 'Write',
            actions: ['echo preparing plugin runtime'],
          },
        ],
        skillEntries: [
          {
            name: 'create-pr',
            description: 'Create a pull request from the current branch.',
          },
          {
            name: 'commit',
            description: 'Commit the current staged changes.',
            version: '1.0.0',
          },
        ],
        mcpServerEntries: [
          {
            name: 'plugin:github:github-api',
            displayName: 'github-api',
            transport: 'http',
            summary: 'https://api.github.com/mcp',
          },
        ],
        errors: [],
      },
    })

    render(<Settings />)
    switchToPluginsTab()

    expect(screen.getByText('Plugin Detail')).toBeInTheDocument()
    expect(screen.getByText('GitHub integration')).toBeInTheDocument()
    expect(screen.getByText('Bundled capabilities')).toBeInTheDocument()
    expect(screen.getByText('/review-pr')).toBeInTheDocument()
    expect(screen.getByText('Review pull request quality and risk.')).toBeInTheDocument()
    expect(screen.getByText('echo preparing plugin runtime')).toBeInTheDocument()
    expect(screen.getByText('Create a pull request from the current branch.')).toBeInTheDocument()
    expect(screen.getByText('https://api.github.com/mcp')).toBeInTheDocument()
    expect(screen.getAllByText('LSP servers').length).toBeGreaterThan(0)
    expect(screen.getByText('github-lsp')).toBeInTheDocument()
    expect(screen.getByText('Apply changes')).toBeInTheDocument()
    expect(screen.getByText('Uninstall')).toBeInTheDocument()
  })

  it('keeps plugin detail hook order stable while the selected plugin reloads', () => {
    usePluginStore.setState({
      selectedPlugin: {
        id: 'github@claude-plugins-official',
        name: 'github',
        marketplace: 'claude-plugins-official',
        scope: 'user',
        enabled: false,
        hasErrors: false,
        isBuiltin: false,
        description: 'GitHub integration',
        componentCounts: {
          commands: 1,
          agents: 0,
          skills: 0,
          hooks: 0,
          mcpServers: 0,
          lspServers: 0,
        },
        capabilities: {
          commands: ['review-pr'],
          agents: [],
          skills: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
        },
        commandEntries: [
          {
            name: 'review-pr',
            description: 'Review the current pull request.',
          },
        ],
        agentEntries: [],
        hookEntries: [],
        skillEntries: [],
        mcpServerEntries: [],
        errors: [],
      },
    })

    const { container } = render(<Settings />)
    switchToPluginsTab()

    expect(screen.getByText('GitHub integration')).toBeInTheDocument()

    act(() => {
      usePluginStore.setState({ isDetailLoading: true })
    })

    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('navigates plugin skills into the shared Skills page flow', () => {
    usePluginStore.setState({
      selectedPlugin: {
        id: 'telegram@claude-plugins-official',
        name: 'telegram',
        marketplace: 'claude-plugins-official',
        scope: 'user',
        enabled: true,
        hasErrors: false,
        isBuiltin: false,
        description: 'Telegram integration',
        componentCounts: {
          commands: 0,
          agents: 0,
          skills: 1,
          hooks: 0,
          mcpServers: 0,
          lspServers: 0,
        },
        capabilities: {
          commands: [],
          agents: [],
          skills: ['telegram:access'],
          hooks: [],
          mcpServers: [],
          lspServers: [],
        },
        commandEntries: [],
        agentEntries: [],
        hookEntries: [],
        skillEntries: [
          {
            name: 'telegram:access',
            displayName: 'access',
            description: 'Manage Telegram access.',
            pluginName: 'telegram',
          },
        ],
        mcpServerEntries: [],
        errors: [],
      },
    })

    render(<Settings />)
    switchToPluginsTab()

    fireEvent.click(screen.getByText('access'))

    expect(MOCK_FETCH_SKILL_DETAIL).toHaveBeenCalledWith('plugin', 'telegram:access', '/workspace/project', 'plugins')
  })

  it('disables shared navigation cards for disabled plugins', () => {
    usePluginStore.setState({
      selectedPlugin: {
        id: 'codex@openai-codex',
        name: 'codex',
        marketplace: 'openai-codex',
        scope: 'user',
        enabled: false,
        hasErrors: false,
        isBuiltin: false,
        description: 'Use Codex from Claude Code',
        componentCounts: {
          commands: 0,
          agents: 1,
          skills: 1,
          hooks: 0,
          mcpServers: 0,
          lspServers: 0,
        },
        capabilities: {
          commands: [],
          agents: ['codex:codex-rescue'],
          skills: ['codex:gpt-5-4-prompting'],
          hooks: [],
          mcpServers: [],
          lspServers: [],
        },
        commandEntries: [],
        agentEntries: [
          {
            name: 'codex:codex-rescue',
            displayName: 'codex-rescue',
            description: 'Delegate to Codex.',
          },
        ],
        hookEntries: [],
        skillEntries: [
          {
            name: 'codex:gpt-5-4-prompting',
            displayName: 'gpt-5-4-prompting',
            description: 'Prompting guide.',
          },
        ],
        mcpServerEntries: [],
        errors: [],
      },
    })

    render(<Settings />)
    switchToPluginsTab()

    expect(screen.getAllByText('Enable this plugin and apply changes before opening its skills, agents, or MCP entries in the shared management pages.').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /codex-rescue/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /gpt-5-4-prompting/i })).toBeDisabled()
  })
})
