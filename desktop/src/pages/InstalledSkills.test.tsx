import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { InstalledSkills } from '@/pages/InstalledSkills'
import { useSkillStore } from '@/stores/skillStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { marketApi } from '@/api/market'
import type { SkillDetail } from '@/types/skill'

vi.mock('@/components/markdown/MarkdownRenderer', () => ({ MarkdownRenderer: () => <div /> }))
vi.mock('@/components/chat/CodeViewer', () => ({ CodeViewer: () => <div /> }))
vi.mock('@/api/market', () => ({ marketApi: { uninstall: vi.fn().mockResolvedValue(undefined) } }))

const originalClearSelection = useSkillStore.getState().clearSelection
const fetchSkills = vi.fn()
const detail: SkillDetail = {
  meta: { name: 'example', displayName: 'Example skill', description: 'Reusable workflow', source: 'user', userInvocable: true, hasDirectory: true, contentLength: 24 },
  tree: [], files: [], skillRoot: '/fixture/example',
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useUIStore.setState({ pendingSettingsTab: null })
  useSkillStore.setState({ skills: [detail.meta], selectedSkill: null, selectedSkillContext: null, selectedSkillReturnTab: 'skills', isLoading: false, isDetailLoading: false, error: null, clearSelection: originalClearSelection, fetchSkills })
})

function selectSkill(selected = detail, context = '') {
  act(() => useSkillStore.setState({ selectedSkill: selected, selectedSkillContext: context }))
}

describe('InstalledSkills', () => {
  it('starts at a compact searchable list and clears stale Settings detail', () => {
    selectSkill()
    render(<InstalledSkills />)
    expect(useSkillStore.getState().selectedSkill).toBeNull()
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    expect(screen.queryByText('Browse installed skills')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(screen.queryByText('Example skill')).not.toBeInTheDocument()
  })

  it('returns to its own list even if selection originated from plugins', () => {
    render(<InstalledSkills />)
    selectSkill()
    act(() => useSkillStore.setState({ selectedSkillReturnTab: 'plugins' }))
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    expect(useUIStore.getState().pendingSettingsTab).toBeNull()
  })

  it('uses the current project and clears its selection when the project changes', () => {
    useSessionStore.setState({ activeSessionId: 'a', sessions: [{ id: 'a', workDir: '/fixture/project' } as never] })
    const view = render(<InstalledSkills />)
    expect(fetchSkills).toHaveBeenCalledWith('/fixture/project')
    selectSkill(detail, '/fixture/project')
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    act(() => useSessionStore.setState({ activeSessionId: null }))
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    expect(useSkillStore.getState().selectedSkill).toBeNull()
    view.unmount()
    expect(useSkillStore.getState().isDetailLoading).toBe(false)
  })

  it('uninstalls a market skill through the existing confirmation flow and refreshes its project', async () => {
    useSessionStore.setState({ activeSessionId: 'a', sessions: [{ id: 'a', workDir: '/fixture/project' } as never] })
    render(<InstalledSkills />)
    selectSkill({ ...detail, marketMeta: { id: 'fixture/example', installedAt: '2026-09-14' } as NonNullable<SkillDetail['marketMeta']> }, '/fixture/project')
    fireEvent.click(screen.getByTestId('local-skill-uninstall-button'))
    expect(marketApi.uninstall).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Uninstall' }))
    await waitFor(() => expect(marketApi.uninstall).toHaveBeenCalledWith('fixture/example'))
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeInTheDocument())
    expect(fetchSkills).toHaveBeenLastCalledWith('/fixture/project')
  })

  it('never offers arbitrary deletion for non-market skills', () => {
    render(<InstalledSkills />)
    selectSkill()
    expect(screen.queryByTestId('local-skill-uninstall-button')).not.toBeInTheDocument()
  })
})
