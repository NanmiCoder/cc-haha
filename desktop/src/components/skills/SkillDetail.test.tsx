import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    content,
    variant,
    className,
  }: {
    content: string
    variant?: string
    className?: string
  }) => (
    <div
      data-testid="markdown-renderer"
      data-content={content}
      data-variant={variant}
      data-classname={className}
    />
  ),
}))

vi.mock('../chat/CodeViewer', () => ({
  CodeViewer: ({ code }: { code: string }) => <div data-testid="code-viewer">{code}</div>,
}))

const getActiveSkills = vi.fn()
const setActiveSkills = vi.fn()
vi.mock('../../api/skills', () => ({
  skillsApi: {
    getActiveSkills: (...args: unknown[]) => getActiveSkills(...args),
    setActiveSkills: (...args: unknown[]) => setActiveSkills(...args),
  },
}))

const apiGet = vi.fn()
vi.mock('../../api/client', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}))

import { SkillDetail } from './SkillDetail'
import { useSkillStore } from '../../stores/skillStore'
import { useSettingsStore } from '../../stores/settingsStore'

const fetchSkills = vi.fn()
const fetchSkillDetail = vi.fn()
const clearSelection = vi.fn(() => {
  useSkillStore.setState({ selectedSkill: null })
})

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useSkillStore.setState({
    skills: [],
    selectedSkill: null,
    isLoading: false,
    isDetailLoading: false,
    error: null,
    fetchSkills,
    fetchSkillDetail,
    clearSelection,
  })
  fetchSkills.mockReset()
  fetchSkillDetail.mockReset()
  clearSelection.mockClear()
  getActiveSkills.mockReset()
  setActiveSkills.mockReset()
  apiGet.mockReset()
  // Default: no active skills, no projects.
  getActiveSkills.mockResolvedValue({ activeSkills: [] })
  setActiveSkills.mockResolvedValue(undefined)
  apiGet.mockResolvedValue({ projects: [] })
})

describe('SkillDetail markdown presentation', () => {
  it('renders markdown files with the document variant and readable width', () => {
    useSkillStore.setState({
      selectedSkill: {
        meta: {
          name: 'skill-test',
          displayName: 'Skill Test',
          description: 'Skill description',
          source: 'user',
          userInvocable: true,
          contentLength: 120,
          hasDirectory: true,
        },
        tree: [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file' }],
        files: [
          {
            path: 'SKILL.md',
            content: '# Skill Body',
            language: 'markdown',
            isEntry: true,
          },
        ],
        skillRoot: '/tmp/skill-test',
      },
    })

    render(<SkillDetail />)

    const markdown = screen.getByTestId('markdown-renderer')
    expect(markdown).toBeInTheDocument()
    expect(markdown).toHaveAttribute('data-variant', 'document')
    expect(markdown).toHaveAttribute('data-classname', 'mx-auto max-w-[72ch]')
    expect(markdown).toHaveAttribute('data-content', '# Skill Body')
  })
})

function selectSkill(name: string) {
  useSkillStore.setState({
    selectedSkill: {
      meta: {
        name,
        displayName: name,
        description: 'desc',
        source: 'user',
        userInvocable: true,
        contentLength: 10,
        hasDirectory: true,
      },
      tree: [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file' }],
      files: [{ path: 'SKILL.md', content: '# Body', language: 'markdown', isEntry: true }],
      skillRoot: '/tmp/' + name,
    },
  })
}

describe('SkillActivationScope', () => {
  it('renders the three activation scope buttons', async () => {
    selectSkill('demo-skill')
    render(<SkillDetail />)

    expect(await screen.findByRole('button', { name: /Off/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Global/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Project/i })).toBeInTheDocument()
    // Let the mount-time effects (getActiveSkills x2, api.get) settle.
    await waitFor(() => expect(getActiveSkills).toHaveBeenCalled())
  })

  it('marks the global button selected with high-contrast brand styling when the skill is globally active', async () => {
    // 'global' scope: the skill name is in the global active list.
    getActiveSkills.mockImplementation((scope: string) =>
      Promise.resolve({ activeSkills: scope === 'global' ? ['demo-skill'] : [] }),
    )
    selectSkill('demo-skill')
    render(<SkillDetail />)

    const globalBtn = await screen.findByRole('button', { name: /Global/i })
    // Selected state uses brand background + paired high-contrast foreground,
    // not the old low-contrast primary-fixed/text-primary combo.
    await waitFor(() => {
      expect(globalBtn.className).toContain('bg-[var(--color-brand)]')
    })
    expect(globalBtn.className).toContain('text-[var(--color-btn-primary-fg)]')
    expect(globalBtn.className).not.toContain('bg-[var(--color-primary-fixed)]')
  })

  it('shows the project Dropdown (with selectable items) when project scope is active', async () => {
    getActiveSkills.mockImplementation((scope: string) =>
      Promise.resolve({ activeSkills: scope === 'project' ? ['demo-skill'] : [] }),
    )
    apiGet.mockResolvedValue({
      projects: [
        { id: 'p1', label: '/work/alpha', projectPath: '/work/alpha', isCurrent: true },
        { id: 'p2', label: '/work/beta', projectPath: '/work/beta', isCurrent: false },
      ],
    })
    selectSkill('demo-skill')
    render(<SkillDetail />)

    // "Applies to:" label appears only under project scope with resolved projects.
    expect(await screen.findByText(/Applies to/i)).toBeInTheDocument()
  })

  it('treats multiple projects as independently active and surfaces the count', async () => {
    // Skill is active in 2 of 3 projects — the trigger should show "2 projects".
    getActiveSkills.mockImplementation((scope: string, cwd?: string) => {
      if (scope !== 'project') return Promise.resolve({ activeSkills: [] })
      if (cwd === '/work/alpha' || cwd === '/work/beta') {
        return Promise.resolve({ activeSkills: ['multi-skill'] })
      }
      return Promise.resolve({ activeSkills: [] })
    })
    apiGet.mockResolvedValue({
      projects: [
        { id: 'p1', label: '/work/alpha', projectPath: '/work/alpha', isCurrent: true },
        { id: 'p2', label: '/work/beta', projectPath: '/work/beta', isCurrent: false },
        { id: 'p3', label: '/work/gamma', projectPath: '/work/gamma', isCurrent: false },
      ],
    })
    selectSkill('multi-skill')
    render(<SkillDetail />)

    // Trigger label uses the {count} key once 2+ projects are active.
    expect(await screen.findByText(/2 projects/i)).toBeInTheDocument()
    // The activated badge is still shown.
    expect(screen.getByText(/Active/)).toBeInTheDocument()
  })
})
