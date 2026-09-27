import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getRecentProjects: vi.fn(),
    },
  }
})

vi.mock('../api/desktopUiPreferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/desktopUiPreferences')>()
  return {
    ...actual,
    desktopUiPreferencesApi: {
      ...actual.desktopUiPreferencesApi,
      updateProjectDisplayName: vi.fn(),
    },
  }
})

import { sessionsApi, type RecentProject } from '../api/sessions'
import { desktopUiPreferencesApi } from '../api/desktopUiPreferences'
import { DirectoryPicker } from '../components/composite/DirectoryPicker'
import { RepositoryLaunchControls } from '../components/chat/RepositoryLaunchControls'
import { invalidateRecentProjectsCache } from '../lib/recentProjectsCache'
import { useSettingsStore } from '../stores/settingsStore'

const PROJECTS: RecentProject[] = [
  {
    projectPath: '/Users/nanmi/workspace/myself_code/MediaCrawler',
    realPath: '/Users/nanmi/workspace/myself_code/MediaCrawler',
    projectName: 'MediaCrawler',
    isGit: true,
    repoName: 'NanmiCoder/MediaCrawler',
    branch: 'main',
    modifiedAt: '2026-09-18T10:00:00Z',
    sessionCount: 12,
  },
  {
    projectPath: '/Users/nanmi/workspace/myself_code/claude-code-haha',
    realPath: '/Users/nanmi/workspace/myself_code/claude-code-haha',
    projectName: 'claude-code-haha',
    isGit: true,
    repoName: 'NanmiCoder/cc-haha',
    branch: 'main',
    modifiedAt: '2026-09-17T10:00:00Z',
    sessionCount: 30,
  },
  {
    projectPath: '/Users/nanmi/个人自媒体/399-Union-Alpha-新模型',
    realPath: '/Users/nanmi/个人自媒体/399-Union-Alpha-新模型',
    projectName: '399-Union-Alpha-新模型',
    isGit: false,
    repoName: null,
    branch: null,
    modifiedAt: '2026-09-16T10:00:00Z',
    sessionCount: 2,
  },
]

function openPicker(onChange = vi.fn()) {
  const utils = render(<DirectoryPicker value="" onChange={onChange} />)
  fireEvent.click(screen.getByText('选择项目...'))
  return { ...utils, onChange }
}

describe('DirectoryPicker project list', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView; the panel calls it for
    // keyboard-highlight tracking.
    Element.prototype.scrollIntoView = vi.fn()
  })

  beforeEach(() => {
    invalidateRecentProjectsCache()
    vi.mocked(sessionsApi.getRecentProjects).mockReset()
    vi.mocked(sessionsApi.getRecentProjects).mockResolvedValue({ projects: PROJECTS })
    vi.mocked(desktopUiPreferencesApi.updateProjectDisplayName).mockReset()
    vi.mocked(desktopUiPreferencesApi.updateProjectDisplayName)
      .mockImplementation(async (projectKey, displayName) => ({ ok: true, projectKey, displayName }))
    useSettingsStore.setState({ locale: 'zh' })
  })

  it('loads the full project list with a deep scan', async () => {
    openPicker()
    await screen.findByText('NanmiCoder/MediaCrawler')
    expect(sessionsApi.getRecentProjects).toHaveBeenCalledWith(500, 5000)
    // All known projects render, not just a top-10 slice.
    expect(screen.getByText('NanmiCoder/cc-haha')).toBeInTheDocument()
    expect(screen.getByText('399-Union-Alpha-新模型')).toBeInTheDocument()
  })

  it('filters projects by fuzzy query and restores them when cleared', async () => {
    openPicker()
    const search = await screen.findByPlaceholderText('搜索项目…')
    fireEvent.change(search, { target: { value: 'haha' } })

    expect(screen.getByText('NanmiCoder/cc-haha')).toBeInTheDocument()
    expect(screen.queryByText('NanmiCoder/MediaCrawler')).not.toBeInTheDocument()
    expect(screen.queryByText('399-Union-Alpha-新模型')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByText('NanmiCoder/MediaCrawler')).toBeInTheDocument()
  })

  it('shows an empty-filter state instead of an empty list', async () => {
    openPicker()
    const search = await screen.findByPlaceholderText('搜索项目…')
    fireEvent.change(search, { target: { value: 'zzzzz-nothing' } })
    expect(screen.getByText('没有匹配的项目')).toBeInTheDocument()
  })

  it('selects the keyboard-highlighted project on Enter', async () => {
    const { onChange } = openPicker()
    const search = await screen.findByPlaceholderText('搜索项目…')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('/Users/nanmi/workspace/myself_code/claude-code-haha')
    await waitFor(() => {
      expect(screen.queryByTestId('directory-picker-menu')).not.toBeInTheDocument()
    })
  })

  it('creates a named project and selects its folder without creating a session', async () => {
    // The create entry ships in the composer's launch controls; plain
    // DirectoryPicker hosts (settings dialogs, the editor's own folder field)
    // do not get it.
    const onWorkDirChange = vi.fn()
    render(
      <RepositoryLaunchControls
        workDir=""
        onWorkDirChange={onWorkDirChange}
        branch={null}
        onBranchChange={() => {}}
        useWorktree={false}
        onUseWorktreeChange={() => {}}
      />,
    )

    // No repo context → the pill opens straight on the directory view.
    fireEvent.click(screen.getByRole('button', { name: /选择项目/ }))
    await screen.findByText('NanmiCoder/MediaCrawler')

    fireEvent.click(screen.getByText('新建项目'))

    const dialog = await screen.findByRole('dialog', { name: '创建项目' })

    // Pick the source folder through the modal's own picker.
    fireEvent.click(within(dialog).getByText('选择项目...'))
    const folderRow = await screen.findByRole('option', { name: /cc-haha/ })
    fireEvent.click(folderRow)

    // The name defaults to the folder basename; rename it.
    const nameInput = within(dialog).getByLabelText(/项目名称/) as HTMLInputElement
    await waitFor(() => expect(nameInput.value).toBe('claude-code-haha'))
    fireEvent.change(nameInput, { target: { value: '我的项目' } })

    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }))

    await waitFor(() => {
      expect(desktopUiPreferencesApi.updateProjectDisplayName)
        .toHaveBeenCalledWith('/Users/nanmi/workspace/myself_code/claude-code-haha', '我的项目')
    })
    await waitFor(() => {
      expect(onWorkDirChange).toHaveBeenCalledWith('/Users/nanmi/workspace/myself_code/claude-code-haha')
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '创建项目' })).not.toBeInTheDocument()
    })
  })
})
