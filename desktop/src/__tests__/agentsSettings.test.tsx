import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useAgentStore } from '../stores/agentStore'
import { useSkillStore } from '../stores/skillStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'

vi.mock('../api/agents', () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }),
  },
}))

const noopFetch = vi.fn()

vi.mock('../stores/providerStore', () => ({
  useProviderStore: () => ({
    providers: [],
    activeId: null,
    isLoading: false,
    fetchProviders: vi.fn(),
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

vi.mock('../components/chat/CodeViewer', () => ({
  CodeViewer: ({ code }: { code: string }) => <pre data-testid="code-viewer">{code}</pre>,
}))

const MOCK_AGENTS = [
  {
    agentType: 'code-reviewer',
    description: 'Reviews code for quality and security',
    model: 'claude-sonnet-4-6',
    modelDisplay: 'claude-sonnet-4-6',
    tools: ['Read', 'Grep', 'Glob'],
    systemPrompt: '# Code Reviewer\n\nYou are an expert code reviewer.',
    color: 'blue',
    source: 'userSettings' as const,
    baseDir: '~/.claude/agents',
    isActive: true,
  },
  {
    agentType: 'doc-writer',
    description: 'Writes technical documentation',
    model: 'claude-haiku-4-5',
    modelDisplay: 'claude-haiku-4-5',
    tools: ['Read'],
    systemPrompt: 'You write clear and concise docs.',
    color: 'green',
    source: 'built-in' as const,
    baseDir: 'built-in',
    isActive: true,
  },
  {
    agentType: 'plain-agent',
    description: undefined,
    model: undefined,
    modelDisplay: 'inherit',
    tools: undefined,
    systemPrompt: undefined,
    color: undefined,
    source: 'projectSettings' as const,
    baseDir: '/workspace/project/.claude/agents',
    isActive: false,
    overriddenBy: 'userSettings' as const,
  },
]

const MOCK_SKILL_DETAIL = {
  meta: {
    name: 'skill-docs',
    displayName: 'Skill Docs',
    description: 'A rich skill readme',
    source: 'user' as const,
    userInvocable: true,
    contentLength: 200,
    hasDirectory: true,
  },
  tree: [
    { name: 'SKILL.md', path: 'SKILL.md', type: 'file' as const },
    { name: 'helper.ts', path: 'helper.ts', type: 'file' as const },
  ],
  files: [
    {
      path: 'SKILL.md',
      language: 'markdown',
      content: '# Heading\n\nParagraph with `inline code`.\n\n## Section\n\n- First item\n- Second item\n\n> Helpful quote',
      body: '# Heading\n\nParagraph with `inline code`.\n\n## Section\n\n- First item\n- Second item\n\n> Helpful quote',
      isEntry: true,
      frontmatter: {
        description: 'A rich skill readme',
        model: 'sonnet',
      },
    },
    {
      path: 'helper.ts',
      language: 'typescript',
      content: 'export const helper = true',
      isEntry: false,
    },
  ],
  skillRoot: '/tmp/skill-docs',
}

function switchToAgentsTab() {
  fireEvent.click(screen.getByText('Agents'))
}

function switchToSkillsTab() {
  fireEvent.click(screen.getByText('Skills'))
}

describe('Settings > Agents tab', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: 'session-1',
      tabs: [{ sessionId: 'session-1', title: 'Test', type: 'session', status: 'idle' }],
    })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Test Session',
          createdAt: '',
          modifiedAt: '',
          messageCount: 0,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
      activeSessionId: 'session-1',
      isLoading: false,
      error: null,
      selectedProjects: [],
      availableProjects: [],
      fetchSessions: noopFetch,
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      updateSessionTitle: vi.fn(),
      setActiveSession: vi.fn(),
      setSelectedProjects: vi.fn(),
    })
    useAgentStore.setState({
      activeAgents: [],
      allAgents: [],
      isLoading: false,
      error: null,
      selectedAgent: null,
      fetchAgents: noopFetch,
      selectAgent: (agent) => useAgentStore.setState({ selectedAgent: agent }),
    })
    useSkillStore.setState({
      skills: [],
      selectedSkill: null,
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills: noopFetch,
      fetchSkillDetail: noopFetch,
      clearSelection: () => useSkillStore.setState({ selectedSkill: null }),
    })
  })

  it('renders the Agents tab button in sidebar', () => {
    render(<Settings />)
    expect(screen.getByText('Agents')).toBeInTheDocument()
  })

  it('shows loading spinner when fetching agents', () => {
    useAgentStore.setState({ isLoading: true, allAgents: [], activeAgents: [], fetchAgents: noopFetch })
    render(<Settings />)
    switchToAgentsTab()

    const spinner = document.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('uses the active session workDir even when settings tab is focused', async () => {
    const fetchAgents = vi.fn()
    useAgentStore.setState({
      allAgents: [],
      activeAgents: [],
      isLoading: false,
      fetchAgents,
    })
    useTabStore.setState({
      activeTabId: SETTINGS_TAB_ID,
      tabs: [{ sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' }],
    })

    render(<Settings />)
    switchToAgentsTab()

    expect(fetchAgents).toHaveBeenCalledWith('/workspace/project')
  })

  it('shows error state with retry button when API fails', () => {
    useAgentStore.setState({ allAgents: [], activeAgents: [], isLoading: false, error: 'Network error', fetchAgents: noopFetch })
    render(<Settings />)
    switchToAgentsTab()

    expect(screen.getByText('Network error')).toBeInTheDocument()
    expect(screen.getByText('Retry')).toBeInTheDocument()
  })

  it('renders grouped agent browser with source sections', () => {
    useAgentStore.setState({
      allAgents: MOCK_AGENTS,
      activeAgents: MOCK_AGENTS.filter((agent) => agent.isActive),
      isLoading: false,
      fetchAgents: noopFetch,
    })
    render(<Settings />)
    switchToAgentsTab()

    expect(screen.getByText('Browse installed agents')).toBeInTheDocument()
    expect(screen.getByText('Agent Browser')).toBeInTheDocument()
    expect(screen.getAllByText('User').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Built-in').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Project').length).toBeGreaterThan(0)
    expect(screen.getByText('code-reviewer')).toBeInTheDocument()
    expect(screen.getByText('Writes technical documentation')).toBeInTheDocument()
    expect(screen.getByText('Overridden by User')).toBeInTheDocument()
  })

  it('opens agent detail with metadata cards and document prompt', () => {
    useAgentStore.setState({
      allAgents: MOCK_AGENTS,
      activeAgents: MOCK_AGENTS.filter((agent) => agent.isActive),
      isLoading: false,
      fetchAgents: noopFetch,
    })
    render(<Settings />)
    switchToAgentsTab()

    fireEvent.click(screen.getByText('code-reviewer'))

    expect(screen.getByText('Back to list')).toBeInTheDocument()
    expect(screen.getByText('Agent Profile')).toBeInTheDocument()
    expect(screen.getAllByText('claude-sonnet-4-6')[0]).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Code Reviewer' })).toBeInTheDocument()

    const rendererRoot = screen.getByRole('heading', { name: 'Code Reviewer' }).closest('div[class*="prose"]')
    expect(rendererRoot?.className).toContain('max-w-[72ch]')
  })

  it('shows no system prompt state when agent has no prompt', () => {
    useAgentStore.setState({
      allAgents: MOCK_AGENTS,
      activeAgents: MOCK_AGENTS.filter((agent) => agent.isActive),
      isLoading: false,
      fetchAgents: noopFetch,
    })
    render(<Settings />)
    switchToAgentsTab()

    fireEvent.click(screen.getByText('plain-agent'))

    expect(screen.getByText('No system prompt defined.')).toBeInTheDocument()
    expect(screen.getByText('shadowed by User')).toBeInTheDocument()
  })

  it('navigates back to list from detail view', () => {
    useAgentStore.setState({
      allAgents: MOCK_AGENTS,
      activeAgents: MOCK_AGENTS.filter((agent) => agent.isActive),
      isLoading: false,
      fetchAgents: noopFetch,
    })
    render(<Settings />)
    switchToAgentsTab()

    fireEvent.click(screen.getByText('code-reviewer'))
    fireEvent.click(screen.getByText('Back to list'))

    expect(screen.getByText('code-reviewer')).toBeInTheDocument()
    expect(screen.getByText('doc-writer')).toBeInTheDocument()
    expect(screen.getByText('plain-agent')).toBeInTheDocument()
  })
})

describe('Settings > Skills tab', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useSkillStore.setState({
      skills: [],
      selectedSkill: null,
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills: noopFetch,
      fetchSkillDetail: noopFetch,
      clearSelection: () => useSkillStore.setState({ selectedSkill: null }),
    })
  })

  it('renders markdown skills with document styling in detail view', () => {
    useSkillStore.setState({
      selectedSkill: MOCK_SKILL_DETAIL,
      clearSelection: () => useSkillStore.setState({ selectedSkill: null }),
    })

    render(<Settings />)
    switchToSkillsTab()

    expect(screen.getByText('Skill metadata')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()

    const rendererRoot = screen.getByRole('heading', { name: 'Heading' }).closest('div[class*="prose"]')
    expect(rendererRoot?.className).toContain('max-w-[72ch]')
    expect(rendererRoot?.className).toContain('prose-h2:border-b')
    expect(rendererRoot?.className).toContain('prose-p:text-[15px]')
    expect(screen.getByText('Helpful quote')).toBeInTheDocument()
  })

  it('keeps code files rendered in CodeViewer instead of markdown prose', () => {
    useSkillStore.setState({
      selectedSkill: MOCK_SKILL_DETAIL,
      clearSelection: () => useSkillStore.setState({ selectedSkill: null }),
    })

    render(<Settings />)
    switchToSkillsTab()

    fireEvent.click(screen.getAllByText('helper.ts')[0]!)

    expect(screen.getByTestId('code-viewer')).toHaveTextContent('export const helper = true')
    expect(screen.queryByRole('heading', { name: 'Heading' })).not.toBeInTheDocument()
  })
})
