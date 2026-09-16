import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDiffSurfaceProps } from '../workspace/WorkspaceDiffSurface'

const reviewApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getDiff: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  revert: vi.fn(),
  stageHunk: vi.fn(),
  unstageHunk: vi.fn(),
}))

vi.mock('../../api/review', () => ({ reviewApi }))

/** The diff renderer has its own suite; here only its presence is the signal. */
vi.mock('../workspace/WorkspaceDiffSurface', () => ({
  WorkspaceDiffSurface: ({ value, path, mode, wrapLines, hunkAction, onAddComment }: WorkspaceDiffSurfaceProps) => (
    <div data-testid={`diff-surface-${path}`} data-mode={mode} data-wrap={wrapLines}>{value}
      {hunkAction && [...value.matchAll(/^@@/gm)].map((_, index) => <button key={index} disabled={hunkAction.disabled} onClick={() => hunkAction.onApply(index)}>{hunkAction.label}</button>)}
      <button onClick={() => onAddComment?.({ side: 'old', lineStart: 4, lineEnd: 5, hunkId: 'hunk-0', quote: 'old code' }, 'Review note')}>Submit fixture comment</button></div>
  ),
}))

import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { sessionsApi } from '../../api/sessions'
import { WorkspaceReviewTab } from './WorkspaceReviewTab'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type {
  ReviewDiffResult,
  ReviewFile,
  ReviewStatusResult,
  ReviewWriteResult,
} from '../../api/review'
import type {
  WorkspaceReviewSource,
  WorkspaceReviewTab as WorkspaceReviewTabModel,
} from '../../lib/workspace/types'

const SESSION = 'session-a'
const MODIFIED = 'src/a.ts'
const STAGED_FILE = 'src/b.ts'
const UNTRACKED = 'src/new.ts'

function file(path: string, overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    staged: false,
    unstaged: true,
    conflicted: false,
    ...overrides,
  }
}

function status(overrides: Partial<ReviewStatusResult> = {}): ReviewStatusResult {
  const files = overrides.files ?? [
    file(MODIFIED),
    file(STAGED_FILE, { staged: true, unstaged: false }),
    file(UNTRACKED, { status: 'untracked' }),
  ]
  return {
    state: 'ok',
    source: { kind: 'unstaged' },
    snapshot: 'snap-1',
    files,
    untracked: overrides.untracked ?? [UNTRACKED],
    totals: { additions: 9, deletions: 3, files: files.length },
    ...overrides,
  }
}

function diffFor(path: string): ReviewDiffResult {
  return {
    state: 'ok',
    source: { kind: 'unstaged' },
    snapshot: 'snap-1',
    path,
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  }
}

function writeResult(overrides: Partial<ReviewWriteResult> = {}): ReviewWriteResult {
  return { state: 'ok', snapshot: 'snap-2', results: [], ...overrides }
}

function openReviewTab(source?: WorkspaceReviewSource, path?: string) {
  const tabId = useWorkspaceStore.getState().openTarget(SESSION, {
    kind: 'review',
    ...(source ? { source } : {}),
    ...(path ? { path } : {}),
  })!
  return tabId
}

function currentTab(tabId: string) {
  return useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceReviewTabModel
}

async function renderReview(options: {
  source?: WorkspaceReviewSource
  path?: string
  defaultBranchRef?: string
} = {}) {
  const tabId = openReviewTab(options.source, options.path)
  const view = render(
    <WorkspaceReviewTab
      sessionId={SESSION}
      tab={currentTab(tabId)}
      defaultBranchRef={options.defaultBranchRef ?? null}
    />,
  )
  await waitFor(() => expect(reviewApi.getStatus).toHaveBeenCalled())
  await settle()
  const rerender = () => view.rerender(
    <WorkspaceReviewTab
      sessionId={SESSION}
      tab={currentTab(tabId)}
      defaultBranchRef={options.defaultBranchRef ?? null}
    />,
  )
  return { ...view, tabId, rerender }
}

/**
 * Drain the status read and the per-file diff reads it triggers, so every case
 * asserts on a finished panel rather than on a half-applied one.
 */
async function settle() {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

function pathsOf(call: unknown[] | undefined): string[] {
  return ((call?.[1] as { paths?: string[] } | undefined)?.paths ?? [])
}

/** jsdom implements no scrolling; the component calls it optionally. */
const scrollIntoView = vi.fn()

it.each(['git', 'turn'] as const)('locates the requested second file once after delayed %s status', async (kind) => {
  let resolveStatus!: () => void
  const pending = new Promise<void>(resolve => { resolveStatus = resolve })
  const source: WorkspaceReviewSource = kind === 'turn' ? { kind: 'turn', turnKey: 'message-1', userMessageIndex: 0 } : { kind: 'unstaged' }
  const checkpointSpy = vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockImplementation(async () => {
    await pending
    return { checkpoints: [{ target: { targetUserMessageId: 'message-1', userMessageIndex: 0 }, code: { available: true, filesChanged: [MODIFIED, STAGED_FILE], insertions: 2, deletions: 1 } }] } as Awaited<ReturnType<typeof sessionsApi.getTurnCheckpoints>>
  })
  const diffSpy = vi.spyOn(sessionsApi, 'getTurnCheckpointDiff').mockImplementation(async (_session, _turn, path) => ({ state: 'ok', path, diff: diffFor(path).diff } as Awaited<ReturnType<typeof sessionsApi.getTurnCheckpointDiff>>))
  reviewApi.getStatus.mockImplementation(async () => { await pending; return status({ files: [file(MODIFIED), file(STAGED_FILE)] }) })
  try {
    const tabId = openReviewTab(source, STAGED_FILE)
    const view = render(<WorkspaceReviewTab sessionId={SESSION} tab={currentTab(tabId)} />)
    expect(scrollIntoView).not.toHaveBeenCalled()
    await act(async () => { resolveStatus(); await pending })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId(`workspace-review-section-${STAGED_FILE}`))
    view.rerender(<WorkspaceReviewTab sessionId={SESSION} tab={currentTab(tabId)} />)
    await act(async () => useWorkspaceReviewStore.getState().load(SESSION, source, { force: true }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  } finally {
    checkpointSpy.mockRestore()
    diffSpy.mockRestore()
  }
})

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
  useSettingsStore.setState({ locale: 'en' })
  useWorkspaceStore.setState({ bySession: {}, sideWidth: 860, bottomHeight: 420 })
  useWorkspaceReviewStore.setState({ byKey: {} })
  for (const mock of Object.values(reviewApi)) mock.mockReset()
  reviewApi.getStatus.mockResolvedValue(status())
  reviewApi.getDiff.mockImplementation((_session: string, _source: unknown, path: string) =>
    Promise.resolve(diffFor(path)))
})

afterEach(() => {
  cleanup()
})

describe('comparison picker', () => {
  it.each([
    ['Compare branch…', 'Branch reference', 'feature/base', { kind: 'branch', baseRef: 'feature/base' }],
    ['View commit…', 'Commit reference', 'a1b2c3d4', { kind: 'commit', commit: 'a1b2c3d4' }],
  ] as const)('opens a user-specified comparison from %s with Enter', async (label, fieldLabel, value, expectedSource) => {
    const { tabId, rerender } = await renderReview()
    fireEvent.click(screen.getByTestId('workspace-review-source'))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    const field = screen.getByRole('textbox', { name: fieldLabel })
    fireEvent.change(field, { target: { value } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(reviewApi.getStatus).toHaveBeenCalledWith(SESSION, expectedSource))
    await waitFor(() => expect(currentTab(tabId).source).toEqual(expectedSource))
    rerender()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-review-stage-all')).not.toBeInTheDocument()
  })

  it('keeps invalid refs editable and reports the server validation error', async () => {
    const { tabId } = await renderReview()
    reviewApi.getStatus.mockRejectedValueOnce(new Error('Unknown ref: feature/missing'))
    fireEvent.click(screen.getByTestId('workspace-review-source'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compare branch…' }))
    const field = screen.getByRole('textbox', { name: 'Branch reference' })
    fireEvent.change(field, { target: { value: 'feature/missing' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown ref: feature/missing')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(currentTab(tabId).source).toEqual({ kind: 'unstaged' })
    fireEvent.change(field, { target: { value: 'feature/base' } })
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    await waitFor(() => expect(currentTab(tabId).source).toEqual({ kind: 'branch', baseRef: 'feature/base' }))
  })

  it('rejects blank refs without a request and restores focus on Escape', async () => {
    await renderReview()
    const trigger = screen.getByTestId('workspace-review-source')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'View commit…' }))
    const field = screen.getByRole('textbox', { name: 'Commit reference' })
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a reference.')
    expect(reviewApi.getStatus).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('reads the comparison the tab names', async () => {
    await renderReview({ source: { kind: 'staged' } })
    expect(reviewApi.getStatus).toHaveBeenCalledWith(SESSION, { kind: 'staged' })
    expect(screen.getByTestId('workspace-review-source')).toHaveTextContent('Staged')
  })

  it('re-reads and clears the file selection when the comparison changes', async () => {
    // The previously selected file may not even exist in the new comparison,
    // so keeping the selection would show an empty content area with no
    // explanation of why.
    const { tabId, rerender } = await renderReview({ path: MODIFIED })
    expect(currentTab(tabId).selectedPath).toBe(MODIFIED)

    fireEvent.click(screen.getByTestId('workspace-review-source'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'All uncommitted' }))

    expect(currentTab(tabId).source).toEqual({ kind: 'uncommitted' })
    expect(currentTab(tabId).selectedPath).toBeNull()

    rerender()
    await waitFor(() =>
      expect(reviewApi.getStatus).toHaveBeenCalledWith(SESSION, { kind: 'uncommitted' }))
  })

  it('offers the repository branch only when one was reported', async () => {
    const { unmount } = await renderReview({ defaultBranchRef: 'origin/main' })
    fireEvent.click(screen.getByTestId('workspace-review-source'))
    expect(screen.getByRole('menuitem', { name: 'Branch: origin/main' })).toBeInTheDocument()
    unmount()

    await renderReview()
    fireEvent.click(screen.getByTestId('workspace-review-source'))
    expect(screen.queryByRole('menuitem', { name: /^Branch:/ })).toBeNull()
  })

  it('shows the base the comparison actually resolved to', async () => {
    reviewApi.getStatus.mockResolvedValue(status({
      source: { kind: 'branch', baseRef: 'origin/main', resolvedBase: 'abc1234567def' },
    }))
    await renderReview({ source: { kind: 'branch', baseRef: 'origin/main' } })

    expect(await screen.findByText('Base: abc1234567')).toBeInTheDocument()
  })
})

describe('bulk actions', () => {
  it('stages every changed file, untracked ones included', async () => {
    // Staging an untracked file is additive and reversible — it is exactly what
    // "stage all" means in every Git client.
    await renderReview()
    reviewApi.stage.mockResolvedValue(writeResult())

    fireEvent.click(await screen.findByTestId('workspace-review-stage-all'))

    await waitFor(() => expect(reviewApi.stage).toHaveBeenCalled())
    expect(pathsOf(reviewApi.stage.mock.calls[0])).toEqual([MODIFIED, STAGED_FILE, UNTRACKED])
  })

  it('never discards untracked files in a bulk discard', async () => {
    // Data-loss guard. A tracked file can be recovered from the index or from
    // HEAD; an untracked one exists only in the working tree, so sweeping it
    // into "discard all" destroys the only copy. It has to be named explicitly.
    await renderReview()
    reviewApi.revert.mockResolvedValue(writeResult())

    fireEvent.click(await screen.findByTestId('workspace-review-revert-all'))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }))

    await waitFor(() => expect(reviewApi.revert).toHaveBeenCalled())
    const paths = pathsOf(reviewApi.revert.mock.calls[0])
    expect(paths).not.toContain(UNTRACKED)
    expect(paths).toEqual([MODIFIED, STAGED_FILE])
  })

  it('says out loud that untracked files are left alone before discarding', async () => {
    await renderReview()

    fireEvent.click(await screen.findByTestId('workspace-review-revert-all'))

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Untracked files are listed separately and are never discarded in bulk.',
    )
  })

  it('discards nothing when the confirmation is dismissed', async () => {
    await renderReview()

    fireEvent.click(await screen.findByTestId('workspace-review-revert-all'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    expect(reviewApi.revert).not.toHaveBeenCalled()
  })
})

describe('per-file actions', () => {
  it('stages a single file and unstages one that is already staged in all uncommitted', async () => {
    await renderReview({ source: { kind: 'uncommitted' } })
    reviewApi.stage.mockResolvedValue(writeResult())
    reviewApi.unstage.mockResolvedValue(writeResult())

    const modified = within(await screen.findByTestId(`workspace-review-section-${MODIFIED}`))
    fireEvent.click(modified.getByRole('button', { name: 'Stage file' }))
    await waitFor(() => expect(reviewApi.stage).toHaveBeenCalled())
    expect(pathsOf(reviewApi.stage.mock.calls[0])).toEqual([MODIFIED])

    const staged = within(screen.getByTestId(`workspace-review-section-${STAGED_FILE}`))
    fireEvent.click(staged.getByRole('button', { name: 'Unstage file' }))
    await waitFor(() => expect(reviewApi.unstage).toHaveBeenCalled())
    expect(pathsOf(reviewApi.unstage.mock.calls[0])).toEqual([STAGED_FILE])
  })

  it('discards a single untracked file when it is named on its own', async () => {
    // The bulk guard is about defaults, not about forbidding the operation:
    // picking one untracked file is an explicit instruction.
    await renderReview()
    reviewApi.revert.mockResolvedValue(writeResult())

    const untracked = within(await screen.findByTestId(`workspace-review-section-${UNTRACKED}`))
    fireEvent.click(untracked.getByRole('button', { name: 'Discard changes' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }),
    )

    await waitFor(() => expect(reviewApi.revert).toHaveBeenCalled())
    expect(pathsOf(reviewApi.revert.mock.calls[0])).toEqual([UNTRACKED])
  })

  it('marks a file viewed without touching the working tree', async () => {
    await renderReview()

    const section = within(await screen.findByTestId(`workspace-review-section-${MODIFIED}`))
    fireEvent.click(section.getByRole('button', { name: 'Mark as viewed' }))

    expect(section.getByRole('button', { name: 'Viewed' })).toHaveAttribute('aria-pressed', 'true')
    expect(reviewApi.stage).not.toHaveBeenCalled()
  })

  it('reports which paths a partly failed write could not apply', async () => {
    await renderReview()
    reviewApi.stage.mockResolvedValue(writeResult({
      state: 'partial',
      results: [
        { path: MODIFIED, ok: true },
        { path: STAGED_FILE, ok: false, error: 'locked' },
      ],
    }))

    fireEvent.click(await screen.findByTestId('workspace-review-stage-all'))

    expect(await screen.findByText(/locked/)).toBeInTheDocument()
  })
})

describe('stale writes', () => {
  it('shows the refresh banner and does not retry when a write comes back stale', async () => {
    // `stale` means the server applied nothing because the tree moved. Retrying
    // would re-run the same write against content nobody has looked at.
    await renderReview()
    reviewApi.stage.mockResolvedValue(writeResult({ state: 'stale' }))

    fireEvent.click(await screen.findByTestId('workspace-review-stage-all'))

    expect(await screen.findByTestId('workspace-review-stale')).toHaveTextContent(
      'The working tree changed since this was loaded. Refresh and try again.',
    )
    expect(reviewApi.stage).toHaveBeenCalledTimes(1)
    // No automatic re-read either: refreshing is the user's call.
    expect(reviewApi.getStatus).toHaveBeenCalledTimes(1)
  })

  it('re-reads only when the user asks', async () => {
    await renderReview()

    fireEvent.click(screen.getByTestId('workspace-review-refresh'))

    await waitFor(() => expect(reviewApi.getStatus).toHaveBeenCalledTimes(2))
  })

  it('points at the recoverable copy a discard left behind', async () => {
    await renderReview()
    reviewApi.revert.mockResolvedValue(writeResult({ backupDir: '/tmp/cc-haha-backup-1' }))

    fireEvent.click(await screen.findByTestId('workspace-review-revert-all'))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }),
    )

    expect(await screen.findByText(/\/tmp\/cc-haha-backup-1/)).toBeInTheDocument()
  })
})

describe('read-only comparisons', () => {
  it.each([
    [{ kind: 'branch', baseRef: 'origin/main' } as WorkspaceReviewSource],
    [{ kind: 'commit', commit: 'abc1234def' } as WorkspaceReviewSource],
  ])('offers no write actions for %o', async (source) => {
    // A branch or commit comparison describes history. There is no working-tree
    // change to stage or discard, so offering the buttons would be an action
    // that cannot mean anything.
    await renderReview({ source })

    const section = within(await screen.findByTestId(`workspace-review-section-${MODIFIED}`))
    expect(screen.queryByTestId('workspace-review-stage-all')).toBeNull()
    expect(screen.queryByTestId('workspace-review-revert-all')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stage file' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull()
    // Reading is still fully available.
    expect(section.getByRole('button', { name: 'Mark as viewed' })).toBeInTheDocument()
  })

  it('keeps the write actions on a working-tree comparison', async () => {
    await renderReview({ source: { kind: 'unstaged' } })
    expect(await screen.findByTestId('workspace-review-stage-all')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-review-revert-all')).toBeInTheDocument()
  })
})

describe('files without a hunk view', () => {
  it('offers whole-file actions only for a conflicted path', async () => {
    // An unmerged path has no single "before" to diff against, so a hunk view
    // would be showing conflict markers as if they were ordinary changes.
    reviewApi.getStatus.mockResolvedValue(status({
      files: [file('src/conflict.ts', { status: 'conflicted', conflicted: true })],
      untracked: [],
    }))
    await renderReview()

    expect(await screen.findByText('Conflicted — whole-file actions only')).toBeInTheDocument()
    expect(screen.queryByTestId('diff-surface-src/conflict.ts')).toBeNull()
    const section = within(screen.getByTestId('workspace-review-section-src/conflict.ts'))
    expect(section.getByRole('button', { name: 'Stage file' })).toBeInTheDocument()
  })

  it('says a binary file is binary and never asks the server for its diff', async () => {
    reviewApi.getStatus.mockResolvedValue(status({
      files: [file('assets/logo.png', { binary: true })],
      untracked: [],
    }))
    await renderReview()

    expect(await screen.findByText('Binary file')).toBeInTheDocument()
    expect(screen.queryByTestId('diff-surface-assets/logo.png')).toBeNull()
    expect(reviewApi.getDiff).not.toHaveBeenCalled()
  })

  it('renders the hunk view for an ordinary text change', async () => {
    await renderReview()
    expect(await screen.findByTestId(`diff-surface-${MODIFIED}`)).toHaveTextContent('+new')
  })
})

describe('change list', () => {
  it('summarises the comparison totals', async () => {
    await renderReview()
    const toolbar = await screen.findByTestId('workspace-review-toolbar')
    expect(toolbar).toHaveTextContent('+9')
    expect(toolbar).toHaveTextContent('-3')
  })

  it('locates the picked file and keeps every other one mounted', async () => {
    // This case used to pin the opposite behaviour: picking a file filtered
    // every other section out of the panel. Spec §4.3 asks for 单文件定位 —
    // locate it, do not hide the review around it. The neighbouring diff is
    // most of what makes a change readable.
    const { tabId, rerender } = await renderReview()

    fireEvent.click(await screen.findByTestId(`workspace-review-file-${MODIFIED}`))
    expect(currentTab(tabId).selectedPath).toBe(MODIFIED)
    rerender()

    expect(screen.getByTestId(`workspace-review-section-${MODIFIED}`)).toBeInTheDocument()
    expect(screen.getByTestId(`workspace-review-section-${STAGED_FILE}`)).toBeInTheDocument()
    expect(screen.getByTestId(`workspace-review-section-${UNTRACKED}`)).toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('marks the located row as the current one', async () => {
    const { rerender } = await renderReview()

    fireEvent.click(await screen.findByTestId(`workspace-review-file-${MODIFIED}`))
    rerender()

    expect(screen.getByTestId(`workspace-review-file-${MODIFIED}`)).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId(`workspace-review-file-${STAGED_FILE}`)).not.toHaveAttribute('aria-current')
  })

  it('scrolls back to the file when its row is clicked again', async () => {
    const { tabId, rerender } = await renderReview({ path: MODIFIED })
    scrollIntoView.mockClear()

    fireEvent.click(await screen.findByTestId(`workspace-review-file-${MODIFIED}`))
    // Selecting is now "take me there", so a second click re-locates rather
    // than clearing the selection and re-rendering the whole panel.
    expect(currentTab(tabId).selectedPath).toBe(MODIFIED)
    rerender()

    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('filters the visible sections by the typed query', async () => {
    await renderReview()

    fireEvent.change(await screen.findByRole('searchbox', { name: 'Filter files…' }), {
      target: { value: 'new' },
    })

    expect(screen.getByTestId(`workspace-review-section-${UNTRACKED}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`workspace-review-section-${MODIFIED}`)).toBeNull()
  })

  it('explains an unreadable repository rather than showing zero changes', async () => {
    reviewApi.getStatus.mockResolvedValue(status({ state: 'not_git_repo', files: [], untracked: [] }))
    await renderReview()

    expect(await screen.findByText('This folder is not a Git repository.')).toBeInTheDocument()
  })

  it('reports a clean tree as clean', async () => {
    reviewApi.getStatus.mockResolvedValue(status({ files: [], untracked: [] }))
    await renderReview()

    expect(await screen.findByText('No changes in this comparison')).toBeInTheDocument()
  })
})

describe('change tree shape', () => {
  const API_INDEX = 'src/api/index.ts'
  const LIB_INDEX = 'src/lib/index.ts'

  async function renderTwoIndexes() {
    reviewApi.getStatus.mockResolvedValue(status({
      files: [file(API_INDEX), file(LIB_INDEX)],
      untracked: [],
    }))
    return renderReview()
  }

  it('groups the changed files by directory', async () => {
    // A flat list of basenames rendered these two as identical rows, which is
    // the common case for a change set, not an edge one.
    await renderTwoIndexes()

    expect(await screen.findByTestId('workspace-review-dir-src')).toHaveAttribute('aria-level', '1')
    expect(screen.getByTestId('workspace-review-dir-src/api')).toHaveAttribute('aria-level', '2')
    expect(screen.getByTestId('workspace-review-dir-src/lib')).toHaveAttribute('aria-level', '2')
    expect(screen.getByTestId(`workspace-review-file-${API_INDEX}`)).toHaveAttribute('aria-level', '3')
    expect(screen.getByTestId(`workspace-review-file-${LIB_INDEX}`)).toHaveAttribute('aria-level', '3')
  })

  it('collapses a directory without touching the content', async () => {
    await renderTwoIndexes()

    fireEvent.click(await screen.findByTestId('workspace-review-dir-src/api'))

    expect(screen.queryByTestId(`workspace-review-file-${API_INDEX}`)).toBeNull()
    expect(screen.getByTestId('workspace-review-dir-src/api')).toHaveAttribute('aria-expanded', 'false')
    // Collapsing a group in the tree is navigation, not a filter.
    expect(screen.getByTestId(`workspace-review-section-${API_INDEX}`)).toBeInTheDocument()
  })

  it('walks the change tree with the keyboard', async () => {
    await renderTwoIndexes()

    const root = await screen.findByTestId('workspace-review-dir-src')
    expect(root).toHaveAttribute('tabindex', '0')

    act(() => { root.focus() })
    fireEvent.keyDown(root, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('workspace-review-dir-src/api'))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId(`workspace-review-file-${API_INDEX}`))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByTestId('workspace-review-dir-src/api'))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByTestId(`workspace-review-file-${LIB_INDEX}`))
  })

  it('selects the focused file with Enter', async () => {
    const { tabId } = await renderTwoIndexes()

    const row = await screen.findByTestId(`workspace-review-file-${API_INDEX}`)
    act(() => { row.focus() })
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(currentTab(tabId).selectedPath).toBe(API_INDEX)
  })
})

describe('per-file header', () => {
  const LONG = '.agent-teams/archive/ui-backend-review/inbox/captain.jsonl'

  it('ellipsises a long path from the front so the filename survives', async () => {
    // Truncating at the end hid the one part that says what is on screen. R4
    // reads "...w/inbox/captain.jsonl".
    reviewApi.getStatus.mockResolvedValue(status({ files: [file(LONG)], untracked: [] }))
    await renderReview()

    const tail = await screen.findByTestId(`workspace-review-path-tail-${LONG}`)
    expect(tail).toHaveTextContent('/captain.jsonl')
    expect(tail.className).toContain('shrink-0')

    const head = screen.getByTestId(`workspace-review-path-head-${LONG}`)
    expect(head).toHaveAttribute('dir', 'rtl')
    expect(head.className).toContain('truncate')
    expect(head).toHaveTextContent('.agent-teams/archive/ui-backend-review/inbox')
    // The RTL box moves the ellipsis; the inner LTR isolate keeps the leading
    // dot of a dotfile directory from being reordered to the far end.
    expect(head.querySelector('[dir="ltr"]')).not.toBeNull()
    expect(screen.getByTestId(`workspace-review-path-${LONG}`)).toHaveAttribute('title', LONG)
  })
})

describe('bulk action bar', () => {
  it('gives the bulk actions labels and a bar of their own', async () => {
    // They were 2xs icon buttons in the top toolbar, visually identical to the
    // per-file revert/stage pair ~30px below: "discard this file" and "discard
    // everything" were the same gesture aimed slightly differently.
    await renderReview()

    const bar = await screen.findByTestId('workspace-review-bulk-bar')
    expect(within(bar).getByRole('button', { name: 'Discard all' })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: 'Stage all' })).toBeInTheDocument()

    const toolbar = screen.getByTestId('workspace-review-toolbar')
    expect(within(toolbar).queryByTestId('workspace-review-revert-all')).toBeNull()
    expect(within(toolbar).queryByTestId('workspace-review-stage-all')).toBeNull()
  })

  it('names the bulk discard differently from the per-file one', async () => {
    await renderReview()

    const section = within(await screen.findByTestId(`workspace-review-section-${MODIFIED}`))
    expect(section.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard all' })).toBeInTheDocument()
  })

  it('hides the bar entirely for a read-only comparison', async () => {
    await renderReview({ source: { kind: 'commit', commit: 'abc1234def' } })
    expect(screen.queryByTestId('workspace-review-bulk-bar')).toBeNull()
  })
})

describe('comparison picker accessibility', () => {
  it('announces the control and the comparison it is showing', async () => {
    // `aria-label` overrode the visible text, so this control announced
    // "Comparison" and never which one.
    await renderReview({ source: { kind: 'staged' } })
    expect(screen.getByRole('button', { name: 'Comparison Staged' })).toBeInTheDocument()
  })

  it('advertises the menu on the trigger', async () => {
    await renderReview()
    const trigger = screen.getByTestId('workspace-review-source')

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('moves focus into the menu, walks it, and hands focus back on Escape', async () => {
    await renderReview()
    const trigger = screen.getByTestId('workspace-review-source')

    fireEvent.click(trigger)
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('change filter field', () => {
  it('clears the query from the field itself', async () => {
    await renderReview()

    const field = await screen.findByRole('searchbox', { name: 'Filter files…' })
    fireEvent.change(field, { target: { value: 'new' } })
    expect(screen.queryByTestId(`workspace-review-section-${MODIFIED}`)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear file filter' }))

    expect(field).toHaveValue('')
    expect(screen.getByTestId(`workspace-review-section-${MODIFIED}`)).toBeInTheDocument()
  })
})

describe('toolbar density', () => {
  it('matches the shared workbench bar height', async () => {
    await renderReview()
    expect((await screen.findByTestId('workspace-review-toolbar')).className).toContain('h-10')
  })
})

describe('destructive confirmation', () => {
  it('names the untracked file it is about to delete, and does not promise recovery', async () => {
    await renderReview()

    fireEvent.click(
      within(screen.getByTestId(`workspace-review-section-${UNTRACKED}`))
        .getByRole('button', { name: 'Discard changes' }),
    )

    const dialog = screen.getByRole('dialog')
    // Deleting a file Git has never seen is the one revert outcome Git cannot
    // undo. Reusing the bulk copy here told the user the opposite of the truth.
    expect(dialog).toHaveTextContent(UNTRACKED)
    expect(dialog).not.toHaveTextContent('never discarded in bulk')
  })

  it('keeps the recoverable wording for a tracked file', async () => {
    await renderReview()

    fireEvent.click(
      within(screen.getByTestId(`workspace-review-section-${MODIFIED}`))
        .getByRole('button', { name: 'Discard changes' }),
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).not.toHaveTextContent(UNTRACKED)
    expect(dialog).toHaveTextContent('recoverable copy')
  })

  it('reports what was destroyed after the write', async () => {
    reviewApi.revert.mockResolvedValue({
      state: 'ok',
      snapshot: 'snap-2',
      results: [{ path: UNTRACKED, ok: true, action: 'deleted' }],
      deletedPaths: [UNTRACKED],
      backupDir: '/backups/run-1',
    })
    await renderReview()

    fireEvent.click(
      within(screen.getByTestId(`workspace-review-section-${UNTRACKED}`))
        .getByRole('button', { name: 'Discard changes' }),
    )
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    await settle()

    // The user has to be told that a file was *deleted*, not merely that a
    // backup exists somewhere — those are different facts.
    const notices = screen.getAllByRole('status').map((node) => node.textContent ?? '')
    expect(notices.some((text) => /deleted/i.test(text) && text.includes('/backups/run-1'))).toBe(true)
  })
})

describe('states the user must be able to tell apart', () => {
  it('does not show a deleted worktree as "no changes"', async () => {
    reviewApi.getStatus.mockResolvedValue(status({
      state: 'missing_workdir',
      files: [],
      untracked: [],
      error: 'The workspace directory no longer exists.',
    }))

    await renderReview()

    expect(screen.queryByText('No changes in this comparison')).toBeNull()
  })

  it('surfaces a refusal instead of doing nothing visible', async () => {
    reviewApi.getStatus.mockRejectedValue(new Error('offline'))
    await renderReview()

    const store = (await import('../../stores/workspaceReviewStore')).useWorkspaceReviewStore
    const outcome = await store.getState().stage(SESSION, { kind: 'unstaged' }, ['a.ts'])

    // A silent `null` meant the button moved and nothing happened, with no way
    // to tell whether it had worked.
    expect(outcome.state).toBe('refused')
  })
})


describe('review safety regressions', () => {
  it('does not refetch a mismatched snapshot without refresh', async () => {
    reviewApi.getStatus.mockResolvedValue(status({ files: [file(MODIFIED)] }))
    let calls = 0
    reviewApi.getDiff.mockImplementation(async () => {
      calls++
      if (calls >= 8) return new Promise(() => {})
      return { ...diffFor(MODIFIED), snapshot: 'new-snapshot' }
    })
    await renderReview()
    expect(calls).toBe(1)
    expect(screen.getByTestId('workspace-review-stale')).toBeInTheDocument()
    reviewApi.getStatus.mockResolvedValue(status({ snapshot: 'new-snapshot', files: [file(MODIFIED)] }))
    fireEvent.click(screen.getByTestId('workspace-review-refresh'))
    await waitFor(() => expect(screen.getByTestId(`diff-surface-${MODIFIED}`)).toHaveTextContent('+new'))
    expect(calls).toBe(2)
  })

  it.each([true, false])('only unstages the displayed index when staged file has unstaged=%s', async (unstaged) => {
    reviewApi.getStatus.mockResolvedValue(status({ source: { kind: 'staged' }, files: [file(MODIFIED, { staged: true, unstaged })] }))
    reviewApi.unstage.mockResolvedValue(writeResult())
    await renderReview({ source: { kind: 'staged' } })
    const section = within(screen.getByTestId(`workspace-review-section-${MODIFIED}`))
    fireEvent.click(section.getByRole('button', { name: 'Unstage file' }))
    await waitFor(() => expect(reviewApi.unstage).toHaveBeenCalledTimes(1))
    expect(section.queryByRole('button', { name: 'Stage file' })).toBeNull()
    expect(section.queryByRole('button', { name: 'Discard changes' })).toBeNull()
    expect(screen.queryByTestId('workspace-review-revert-all')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Unstage all' }))
    await waitFor(() => expect(reviewApi.unstage).toHaveBeenCalledTimes(2))
    expect(reviewApi.stage).not.toHaveBeenCalled()
    expect(reviewApi.revert).not.toHaveBeenCalled()
  })
})


describe('review hunk and restore controls', () => {
  it('stages only the selected hunk with its displayed snapshot', async () => {
    const first = '@@ -1 +1 @@\n-old\n+first\n'
    const second = '@@ -10 +10 @@\n-old last\n+last\n'
    const header = `diff --git a/${MODIFIED} b/${MODIFIED}\n--- a/${MODIFIED}\n+++ b/${MODIFIED}\n`
    reviewApi.getStatus.mockResolvedValue(status({ files: [file(MODIFIED)] }))
    reviewApi.getDiff.mockResolvedValue({ ...diffFor(MODIFIED), diff: header + first + second })
    reviewApi.stageHunk.mockResolvedValue(writeResult())
    await renderReview()
    fireEvent.click(screen.getAllByRole('button', { name: 'Stage hunk' })[1]!)
    await waitFor(() => expect(reviewApi.stageHunk).toHaveBeenCalledWith(SESSION, { source: { kind: 'unstaged' }, snapshot: 'snap-1', patch: header + second }))
    expect(reviewApi.stage).not.toHaveBeenCalled()
  })

  it('restores viewed marks after content memory is discarded', async () => {
    const rendered = await renderReview()
    fireEvent.click(within(screen.getByTestId(`workspace-review-section-${MODIFIED}`)).getByRole('button', { name: 'Mark as viewed' }))
    expect(currentTab(rendered.tabId).viewedPaths).toEqual([MODIFIED])
    rendered.unmount()
    useWorkspaceReviewStore.setState({ byKey: {} })
    render(<WorkspaceReviewTab sessionId={SESSION} tab={currentTab(rendered.tabId)} />)
    expect(await screen.findByRole('button', { name: 'Viewed' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('can hide and restore its tree without changing comparison', async () => {
    await renderReview()
    const toggle = screen.getByRole('button', { name: 'Toggle file tree' })
    fireEvent.click(toggle)
    expect(screen.getByTestId('workspace-tree-sidebar')).not.toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByTestId('workspace-tree-sidebar')).toBeVisible()
    expect(reviewApi.getStatus).toHaveBeenCalledTimes(1)
  })
})


it('routes a review comment to its task with comparison, line and side identity', async () => {
  useWorkspaceChatContextStore.setState({ referencesBySession: {} })
  reviewApi.getStatus.mockResolvedValue(status({ files: [file(MODIFIED)] }))
  await renderReview({ source: { kind: 'commit', commit: 'abc123' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit fixture comment' }))
  expect(useWorkspaceChatContextStore.getState().referencesBySession[SESSION]).toEqual([expect.objectContaining({
    kind: 'code-comment', path: MODIFIED, diffSide: 'old', lineStart: 4, lineEnd: 5,
    hunkId: 'commit:abc123:hunk-0', note: 'Review note', quote: 'old code',
  })])
})

it('switches between unified and split diff without rereading or changing the snapshot', async () => {
  reviewApi.getStatus.mockResolvedValue(status({ files: [file(MODIFIED)] }))
  await renderReview()
  fireEvent.click(screen.getByRole('button', { name: 'Split diff' }))
  expect(screen.getByTestId(`diff-surface-${MODIFIED}`)).toHaveAttribute('data-mode', 'split')
  fireEvent.click(screen.getByRole('button', { name: 'Unified diff' }))
  expect(screen.getByTestId(`diff-surface-${MODIFIED}`)).toHaveAttribute('data-mode', 'unified')
  expect(reviewApi.getStatus).toHaveBeenCalledTimes(1)
})

describe('review content parity', () => {
  it('reopens a viewed file when a newer snapshot invalidates its viewed mark', async () => {
    reviewApi.getStatus.mockResolvedValue(status({ files: [file(MODIFIED)] }))
    await renderReview()
    const section = within(screen.getByTestId(`workspace-review-section-${MODIFIED}`))
    fireEvent.click(section.getByRole('button', { name: 'Mark as viewed' }))
    reviewApi.getStatus.mockResolvedValue(status({ snapshot: 'snap-2', files: [file(MODIFIED)] }))
    reviewApi.getDiff.mockResolvedValue({ ...diffFor(MODIFIED), snapshot: 'snap-2' })
    fireEvent.click(screen.getByTestId('workspace-review-refresh'))
    await waitFor(() => expect(section.getByRole('button', { name: 'Mark as viewed' })).toBeInTheDocument())
    await waitFor(() => expect(section.getByTestId(`diff-surface-${MODIFIED}`)).toBeInTheDocument())
  })

  it('keeps explicit file expansion local to its comparison', async () => {
    const view = await renderReview()
    fireEvent.click(within(screen.getByTestId(`workspace-review-section-${MODIFIED}`)).getByRole('button', { name: 'Collapse file diff' }))
    act(() => useWorkspaceStore.getState().setReviewSource(SESSION, view.tabId, { kind: 'staged' }))
    view.rerender()
    await settle()
    expect(screen.getByTestId(`diff-surface-${MODIFIED}`)).toBeInTheDocument()
    act(() => useWorkspaceStore.getState().setReviewSource(SESSION, view.tabId, { kind: 'unstaged' }))
    view.rerender()
    await settle()
    expect(screen.queryByTestId(`diff-surface-${MODIFIED}`)).not.toBeInTheDocument()
  })

  it('collapses a viewed file and reopens it from the tree without hiding its neighbours', async () => {
    await renderReview()
    const section = within(screen.getByTestId(`workspace-review-section-${MODIFIED}`))
    fireEvent.click(section.getByRole('button', { name: 'Mark as viewed' }))
    expect(section.queryByTestId(`diff-surface-${MODIFIED}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`diff-surface-${STAGED_FILE}`)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`workspace-review-file-${MODIFIED}`))
    expect(section.getByTestId(`diff-surface-${MODIFIED}`)).toBeInTheDocument()
    expect(section.getByRole('button', { name: 'Viewed' })).toHaveAttribute('aria-pressed', 'true')
    expect(reviewApi.stage).not.toHaveBeenCalled()
    expect(reviewApi.getDiff).toHaveBeenCalledTimes(3)
  })

  it('opens the reviewed file at the first changed line and disables deleted file opening', async () => {
    reviewApi.getStatus.mockResolvedValue(status({ files: [file(MODIFIED), file('deleted.ts', { status: 'deleted' })] }))
    reviewApi.getDiff.mockImplementation((_session: string, _source: unknown, path: string) => Promise.resolve({ ...diffFor(path), diff: `--- a/${path}\n+++ b/${path}\n@@ -40,2 +40,2 @@\n unchanged\n-old\n+new\n` }))
    await renderReview()
    fireEvent.click(within(screen.getByTestId(`workspace-review-section-${MODIFIED}`)).getByRole('button', { name: 'Open file in tab' }))
    const workspace = useWorkspaceStore.getState().bySession[SESSION]!
    expect(workspace.tabs).toContainEqual(expect.objectContaining({ kind: 'file', path: MODIFIED, preview: false, reveal: expect.objectContaining({ line: 41 }) }))
    expect(within(screen.getByTestId('workspace-review-section-deleted.ts')).getByRole('button', { name: 'Open file in tab' })).toBeDisabled()
  })

  it('copies the file path without toggling its expanded state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await renderReview()
    const section = within(screen.getByTestId(`workspace-review-section-${MODIFIED}`))
    fireEvent.click(section.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MODIFIED))
    expect(section.getByTestId(`diff-surface-${MODIFIED}`)).toBeInTheDocument()
  })

  it('keeps one surface per file, forwards wrapping and places the toolbar above both panes', async () => {
    reviewApi.getStatus.mockResolvedValue(status({ files: [file(MODIFIED)] }))
    reviewApi.getDiff.mockResolvedValue({ ...diffFor(MODIFIED), diff: `${diffFor(MODIFIED).diff}@@ -40 +40 @@\n-tail\n+next\n` })
    await renderReview()
    expect(screen.getAllByTestId(`diff-surface-${MODIFIED}`)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Enable word wrap' }))
    expect(screen.getByTestId(`diff-surface-${MODIFIED}`)).toHaveAttribute('data-wrap', 'true')
    const toolbar = screen.getByTestId('workspace-review-toolbar')
    expect(toolbar.parentElement).toContainElement(screen.getByTestId('workspace-tree-sidebar'))
    expect(toolbar.nextElementSibling).toContainElement(screen.getByTestId('workspace-tree-sidebar'))
    expect(screen.getByTestId('workspace-review-bulk-bar')).toHaveClass('absolute', 'rounded-full')
  })
})
