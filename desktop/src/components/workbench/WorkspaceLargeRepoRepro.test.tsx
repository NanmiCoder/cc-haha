import '@testing-library/jest-dom'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWorkspaceMeta: vi.fn(),
  getWorkspaceStatus: vi.fn(),
  getWorkspaceTree: vi.fn(),
  getWorkspaceFile: vi.fn(),
  searchWorkspace: vi.fn(),
  reviewGetStatus: vi.fn(),
  reviewGetDiff: vi.fn(),
  openTarget: vi.fn().mockResolvedValue(undefined),
  copyText: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getWorkspaceMeta: mocks.getWorkspaceMeta,
    getWorkspaceStatus: mocks.getWorkspaceStatus,
    getWorkspaceTree: mocks.getWorkspaceTree,
    getWorkspaceFile: mocks.getWorkspaceFile,
    searchWorkspace: mocks.searchWorkspace,
  },
}))

vi.mock('../../api/review', () => ({
  reviewApi: {
    getStatus: mocks.reviewGetStatus,
    getDiff: mocks.reviewGetDiff,
    stage: vi.fn(),
    unstage: vi.fn(),
    revert: vi.fn(),
    stageHunk: vi.fn(),
    unstageHunk: vi.fn(),
  },
}))

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copyText }))
vi.mock('@/stores/openTargetStore', () => {
  const state = { targets: [], getTargetsForPath: () => new Promise(() => {}), openTarget: mocks.openTarget }
  return {
    useOpenTargetStore: Object.assign(
      (select: (s: typeof state) => unknown) => select(state),
      { getState: () => state },
    ),
  }
})
vi.mock('../workspace/workspaceFileOpenTargets', () => ({
  useWorkspaceFileOpenTargets: () => ({
    primaryTarget: null,
    targets: [],
    loading: false,
    error: null,
    openTarget: vi.fn(),
  }),
}))
vi.mock('../workspace/WorkspaceDiffSurface', () => ({
  WorkspaceDiffSurface: ({ path }: { path: string }) => <div data-testid={`diff-surface-${path}`} />,
}))

import { WorkspaceFileTab } from './WorkspaceFileTab'
import { WorkspaceFileTreePane } from './WorkspaceFileTreePane'
import { WorkspaceReviewTab } from './WorkspaceReviewTab'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { ReviewFile, ReviewStatusResult } from '../../api/review'
import type {
  WorkspaceFileTab as WorkspaceFileTabModel,
  WorkspaceReviewTab as WorkspaceReviewTabModel,
} from '../../lib/workspace/types'

const SESSION = 'repro-1989-session'

function createFileTab(path: string): WorkspaceFileTabModel {
  return {
    id: 'file-tab-1',
    kind: 'file',
    dock: 'side',
    preview: true,
    createdAt: 0,
    path,
  }
}

function createReviewTab(): WorkspaceReviewTabModel {
  return {
    id: 'review-tab-1',
    kind: 'review',
    dock: 'side',
    preview: false,
    createdAt: 0,
    source: { kind: 'unstaged' },
    selectedPath: null,
  }
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useWorkspaceContentStore.getState().clearSession(SESSION)
  useWorkspaceReviewStore.setState({ byKey: {} })
  useWorkspaceStore.setState({ bySession: {}, sideWidth: 860, bottomHeight: 420 })

  mocks.getWorkspaceMeta.mockReset()
  mocks.getWorkspaceStatus.mockReset()
  mocks.getWorkspaceTree.mockReset()
  mocks.getWorkspaceFile.mockReset()
  mocks.searchWorkspace.mockReset()
  mocks.reviewGetStatus.mockReset()
  mocks.reviewGetDiff.mockReset()

  const workspaceMetaPayload = {
    state: 'ok' as const,
    workDir: '/giant-repo',
    repoName: 'giant-repo',
    branch: 'main',
    isGitRepo: true,
    changedFiles: [],
  }
  mocks.getWorkspaceMeta.mockResolvedValue(workspaceMetaPayload)
  mocks.getWorkspaceStatus.mockResolvedValue(workspaceMetaPayload)
  mocks.getWorkspaceTree.mockResolvedValue({
    state: 'ok',
    path: '',
    entries: [{ name: 'README.md', path: 'README.md', isDirectory: false }],
  })
  mocks.getWorkspaceFile.mockResolvedValue({
    state: 'ok',
    path: 'README.md',
    previewType: 'text',
    content: '# Giant Repo\n',
    language: 'markdown',
    size: 13,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Issue #1989 frontend bottlenecks (repro)', () => {
  it('Bottleneck 1a: opening WorkspaceFileTab should load lightweight metadata without calling heavy getWorkspaceStatus', async () => {
    render(<WorkspaceFileTab sessionId={SESSION} tab={createFileTab('')} />)
    await act(async () => { await Promise.resolve() })

    const statusCalls = mocks.getWorkspaceStatus.mock.calls.length
    const metaCalls = mocks.getWorkspaceMeta.mock.calls.length
    const treeCalls = mocks.getWorkspaceTree.mock.calls.length
    console.info(`[repro-1989][1a] WorkspaceFileTab mount: getWorkspaceStatusCalls=${statusCalls} getWorkspaceMetaCalls=${metaCalls} getWorkspaceTreeCalls=${treeCalls}`)

    // Expected healthy behavior: opening the file reader loads lightweight metadata
    // (`workDir`, `repoName`, `isGitRepo`) and never triggers full git status/untracked scan.
    expect(statusCalls).toBe(0)
    expect(metaCalls).toBe(1)
    expect(useWorkspaceContentStore.getState().statusBySession[SESSION]).toMatchObject({
      workDir: '/giant-repo',
      repoName: 'giant-repo',
      isGitRepo: true,
    })
  })

  it('Bottleneck 1b: watch refreshWatchedPaths should not force-refetch heavy getWorkspaceStatus on every ready/change event', async () => {
    useWorkspaceContentStore.setState({
      statusBySession: {
        [SESSION]: {
          state: 'ok',
          workDir: '/giant-repo',
          repoName: 'giant-repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      treeByKey: {
        [`${SESSION}::`]: {
          state: 'ok',
          path: '',
          entries: [{ name: 'README.md', path: 'README.md', isDirectory: false }],
        },
      },
    })

    await useWorkspaceContentStore
      .getState()
      .refreshWatchedPaths(SESSION, [], [''], new AbortController().signal)

    const statusCalls = mocks.getWorkspaceStatus.mock.calls.length
    const metaCalls = mocks.getWorkspaceMeta.mock.calls.length
    console.info(`[repro-1989][1b] refreshWatchedPaths: forcedGetWorkspaceStatusCalls=${statusCalls} forcedGetWorkspaceMetaCalls=${metaCalls}`)

    // Expected healthy behavior: file-watch ready/change in the file reader must not force full git status.
    expect(statusCalls).toBe(0)
    expect(metaCalls).toBe(0)
  })

  it('Bottleneck 3b: WorkspaceFileTreePane should virtualize large directory listings instead of mounting every row in DOM', async () => {
    const entryCount = 2_000
    mocks.getWorkspaceTree.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: Array.from({ length: entryCount }, (_, index) => ({
        name: `file-${String(index).padStart(4, '0')}.ts`,
        path: `file-${String(index).padStart(4, '0')}.ts`,
        isDirectory: false,
      })),
    })

    const startedAt = performance.now()
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath={null} onOpen={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0)
    })
    const elapsedMs = Math.round(performance.now() - startedAt)
    const mountedTreeItems = screen.getAllByRole('treeitem').length

    console.info(
      `[repro-1989][3b] WorkspaceFileTreePane: entries=${entryCount} mountedTreeItems=${mountedTreeItems} renderMs=${elapsedMs}`,
    )

    // Expected healthy behavior: virtualized tree mounts only viewport + overscan rows, not all 2,000.
    expect(mountedTreeItems).toBeLessThan(200)
  }, 20_000)

  it('Bottleneck 3c: WorkspaceReviewTab should virtualize large change sets instead of mounting every section, observer, and tree row', async () => {
    let observerCount = 0
    class StubIntersectionObserver {
      constructor() {
        observerCount++
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)

    const fileCount = 1_000
    const files: ReviewFile[] = Array.from({ length: fileCount }, (_, index) => {
      const dir = `dir-${String(Math.floor(index / 50)).padStart(2, '0')}`
      return {
        path: `${dir}/changed-${String(index).padStart(4, '0')}.ts`,
        status: 'modified',
        additions: 2,
        deletions: 1,
        binary: false,
        staged: false,
        unstaged: true,
        conflicted: false,
      }
    })
    const statusResult: ReviewStatusResult = {
      state: 'ok',
      source: { kind: 'unstaged' },
      snapshot: 'snap-large',
      files,
      untracked: [],
      totals: { additions: fileCount * 2, deletions: fileCount, files: fileCount },
    }
    mocks.reviewGetStatus.mockResolvedValue(statusResult)

    const startedAt = performance.now()
    const view = render(<WorkspaceReviewTab sessionId={SESSION} tab={createReviewTab()} />)
    await waitFor(() => {
      expect(mocks.reviewGetStatus).toHaveBeenCalledTimes(1)
      expect(view.container.querySelectorAll('section[data-testid^="workspace-review-section-"]').length).toBeGreaterThan(0)
    })
    const elapsedMs = Math.round(performance.now() - startedAt)

    const mountedSections = view.container.querySelectorAll('section[data-testid^="workspace-review-section-"]').length
    const mountedTreeItems = screen.getAllByRole('treeitem').length

    console.info(
      `[repro-1989][3c] WorkspaceReviewTab: changedFiles=${fileCount} mountedSections=${mountedSections} ` +
      `mountedTreeItems=${mountedTreeItems} intersectionObservers=${observerCount} renderMs=${elapsedMs}`,
    )

    // Expected healthy behavior: large review lists must be virtualized with a single shared observer
    // instead of mounting all sections, observers & tree rows.
    expect(mountedSections).toBeLessThan(200)
    expect(mountedTreeItems).toBeLessThan(200)
    expect(observerCount).toBe(1)
  }, 20_000)
})
