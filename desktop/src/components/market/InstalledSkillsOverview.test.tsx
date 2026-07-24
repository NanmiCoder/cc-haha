import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSkillStore } from '../../stores/skillStore'
import type { SkillMeta } from '../../types/skill'
import { InstalledSkillsOverview } from './InstalledSkillsOverview'

const fetchSkills = vi.fn().mockResolvedValue(undefined)
const fetchSkillDetail = vi.fn().mockResolvedValue(undefined)

function makeSkill(name: string, source: SkillMeta['source']): SkillMeta {
  return {
    name: name.toLocaleLowerCase(),
    displayName: name,
    description: `${name} description`,
    source,
    userInvocable: true,
    version: '1.0.0',
    contentLength: 240,
    hasDirectory: true,
  }
}

const installedSkills = [
  makeSkill('Alpha', 'user'),
  makeSkill('Beta', 'project'),
  makeSkill('Gamma', 'plugin'),
  makeSkill('Delta', 'mcp'),
  makeSkill('Epsilon', 'bundled'),
  makeSkill('Zeta', 'user'),
  makeSkill('Eta', 'bundled'),
  makeSkill('Theta', 'plugin'),
]

describe('InstalledSkillsOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        title: 'Current project',
        createdAt: '2026-07-22T00:00:00.000Z',
        modifiedAt: '2026-07-22T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: 'session-1',
      isLoading: false,
      error: null,
    })
    useSkillStore.setState({
      skills: installedSkills,
      selectedSkill: null,
      selectedSkillReturnTab: 'skills',
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills,
      fetchSkillDetail,
      clearSelection: vi.fn(),
    })
  })

  it('loads real installed skills for the active project and opens local details', () => {
    render(<InstalledSkillsOverview />)

    expect(fetchSkills).toHaveBeenCalledWith('/workspace/project')
    expect(screen.getByTestId('installed-skills-overview')).toBeInTheDocument()
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))

    expect(fetchSkillDetail).toHaveBeenCalledWith('user', 'alpha', '/workspace/project', 'skills')
  })

  it('collapses long lists, searches locally, and filters personal versus system skills', () => {
    render(<InstalledSkillsOverview />)

    expect(screen.getByRole('button', { name: 'View 2 more' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View 2 more' }))
    expect(screen.getByRole('button', { name: 'Zeta' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gamma' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('installed-skills-search'), { target: { value: 'zeta' } })
    expect(screen.getByRole('button', { name: 'Zeta' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'System' }))
    expect(screen.getByText('No matching skills')).toBeInTheDocument()
  })
  it('keeps cached installed skills visible when a background refresh fails', () => {
    useSkillStore.setState({ error: 'Request timed out after 120s' })

    render(<InstalledSkillsOverview />)

    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.queryByText('Request timed out after 120s')).not.toBeInTheDocument()
  })
})
