import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSkillStore } from '../stores/skillStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTabStore, SETTINGS_TAB_ID } from '../stores/tabStore'

vi.mock('../api/agents', () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }),
  },
}))

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

vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    activeAgents: [],
    allAgents: [],
    isLoading: false,
    error: null,
    selectedAgent: null,
    fetchAgents: vi.fn(),
    selectAgent: vi.fn(),
  }),
}))

vi.mock('../components/chat/CodeViewer', () => ({
  CodeViewer: ({ code }: { code: string }) => <pre data-testid="code-viewer">{code}</pre>,
}))

const MOCK_FETCH_SKILLS = vi.fn()
const MOCK_FETCH_SKILL_DETAIL = vi.fn()
const MOCK_CLEAR_SELECTION = vi.fn()

function switchToSkillsTab() {
  fireEvent.click(screen.getByText('Skills'))
}

describe('Settings > Skills tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
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
      selectedProjects: [],
      availableProjects: ['/workspace/project'],
    })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSkillStore.setState({
      skills: [],
      selectedSkill: null,
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills: MOCK_FETCH_SKILLS,
      fetchSkillDetail: MOCK_FETCH_SKILL_DETAIL,
      clearSelection: MOCK_CLEAR_SELECTION,
    })
  })

  it('renders browser summary and grouped skill cards', () => {
    useSkillStore.setState({
      skills: [
        {
          name: 'alpha',
          displayName: 'Alpha Skill',
          description: 'First skill description',
          source: 'user',
          userInvocable: true,
          version: '1.0.0',
          contentLength: 400,
          hasDirectory: true,
        },
        {
          name: 'beta',
          description: 'Second skill description',
          source: 'project',
          userInvocable: false,
          contentLength: 200,
          hasDirectory: true,
        },
      ],
    })

    render(<Settings />)
    switchToSkillsTab()

    expect(screen.getByText('Browse installed skills')).toBeInTheDocument()
    expect(screen.getByText('Skill Browser')).toBeInTheDocument()
    expect(screen.getByText('Total skills')).toBeInTheDocument()
    expect(screen.getByText('Alpha Skill')).toBeInTheDocument()
    expect(screen.getByText('Second skill description')).toBeInTheDocument()
  })

  it('uses the active session workDir even when settings tab is focused', () => {
    const fetchSkills = vi.fn()
    useSkillStore.setState({
      skills: [],
      selectedSkill: null,
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills,
      fetchSkillDetail: MOCK_FETCH_SKILL_DETAIL,
      clearSelection: MOCK_CLEAR_SELECTION,
    })
    useTabStore.setState({
      activeTabId: SETTINGS_TAB_ID,
      tabs: [{ sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'settings', status: 'idle' }],
    })

    render(<Settings />)
    switchToSkillsTab()

    expect(fetchSkills).toHaveBeenCalledWith('/workspace/project')
  })

  it('opens skill detail with metadata cards and parsed markdown body', () => {
    useSkillStore.setState({
      selectedSkill: {
        meta: {
          name: 'alpha',
          displayName: 'Alpha Skill',
          description: 'First skill description',
          source: 'user',
          userInvocable: true,
          version: '1.0.0',
          contentLength: 400,
          hasDirectory: true,
        },
        tree: [
          { name: 'SKILL.md', path: 'SKILL.md', type: 'file' },
          { name: 'run.ts', path: 'run.ts', type: 'file' },
        ],
        files: [
          {
            path: 'SKILL.md',
            content: '# Hello\n\nBody content',
            body: '# Hello\n\nBody content',
            language: 'markdown',
            isEntry: true,
            frontmatter: {
              description: 'Frontmatter description',
              'allowed-tools': ['Read', 'Edit'],
              model: 'sonnet',
            },
          },
          {
            path: 'run.ts',
            content: 'console.log("hello")',
            language: 'typescript',
            isEntry: false,
          },
        ],
        skillRoot: '/tmp/alpha',
      },
    })

    render(<Settings />)
    switchToSkillsTab()

    expect(screen.getByText('Skill metadata')).toBeInTheDocument()
    expect(screen.getByText('/slash')).toBeInTheDocument()
    expect(screen.getByText('Frontmatter description')).toBeInTheDocument()
    expect(screen.getByText('Read, Edit')).toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.queryByText(/^---$/)).not.toBeInTheDocument()
  })
})
