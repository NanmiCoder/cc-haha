import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act, useState, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const viewportMocks = vi.hoisted(() => ({
  isMobile: false,
  isTauri: false,
}))

const apiMocks = vi.hoisted(() => ({
  getRepositoryContext: vi.fn(),
  createRepositoryBranch: vi.fn(),
}))

const uiMocks = vi.hoisted(() => ({
  addToast: vi.fn(),
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => viewportMocks.isMobile,
}))

vi.mock('../../lib/desktopRuntime', () => ({
  isTauriRuntime: () => viewportMocks.isTauri,
  isDesktopRuntime: () => viewportMocks.isTauri,
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getRepositoryContext: apiMocks.getRepositoryContext,
    createRepositoryBranch: apiMocks.createRepositoryBranch,
  },
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: { addToast: typeof uiMocks.addToast }) => unknown) => (
    selector({ addToast: uiMocks.addToast })
  ),
}))

// Must match the component's own import specifier, or the mock silently does
// nothing and the real panel renders. It moved to composite/ in the directory
// reshuffle and this path was left behind.
vi.mock('@/components/composite/DirectoryPicker', () => ({
  RecentProjectsPanel: ({ value, onSelect }: { value: string; onSelect: (path: string) => void }) => (
    <div data-testid="recent-projects-panel">
      <span>Current {value || 'none'}</span>
      <button type="button" onClick={() => onSelect('/repo')}>Pick /repo</button>
      <button type="button" onClick={() => onSelect('/tmp/plain')}>Pick /tmp/plain</button>
    </div>
  ),
}))

// Project creation is covered by the picker's own tests; here the editor would
// only pull the mocked picker module back in through its folder field.
vi.mock('@/components/layout/ProjectEditorModal', () => ({
  ProjectEditorModal: () => null,
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const text = {
    'common.cancel': 'Cancel',
    'common.loading': 'Loading',
    'dirPicker.directory': 'Directory',
    'dirPicker.selectProject': 'Select a project',
    'repoLaunch.branch': 'Branch',
    'repoLaunch.checkedOut': 'Checked out',
    'repoLaunch.checkedOutWarning': 'Branch is checked out elsewhere',
    'repoLaunch.checkedOutWarningCompact': 'Branch already checked out',
    'repoLaunch.currentBranch': 'Current branch',
    'repoLaunch.dirtyWarning': 'Dirty worktree',
    'repoLaunch.dirtyWarningCompact': 'Uncommitted changes',
    'repoLaunch.launchLocation': 'Location',
    'repoLaunch.localBranch': 'Local branch',
    'repoLaunch.missingWorkdir': 'Missing working directory',
    'repoLaunch.newBranch': 'Create branch…',
    'repoLaunch.newBranchErrorNoCommits': 'This repository has no commits yet.',
    'repoLaunch.newBranchErrorExists': 'A branch with this name already exists.',
    'repoLaunch.newBranchErrorFailed': 'Could not create the branch.',
    'repoLaunch.newBranchErrorInvalid': 'Git will not accept this branch name.',
    'repoLaunch.newBranchFrom': 'Starts from {branch}',
    'repoLaunch.newBranchNameLabel': 'Branch name',
    'repoLaunch.newBranchPlaceholder': 'feature/my-change',
    'repoLaunch.newBranchSubmit': 'Create',
    'repoLaunch.newBranchSuccessCurrent': 'Created and selected “{branch}”. It will be checked out when the session starts.',
    'repoLaunch.newBranchSuccessIsolated': 'Created and selected “{branch}”. An isolated worktree will be created from it when the session starts.',
    'repoLaunch.newBranchTitle': 'New branch',
    'repoLaunch.noBranch': 'No branch',
    'repoLaunch.noBranchMatch': 'No matching branches',
    'repoLaunch.remoteBranch': 'Remote branch',
    'repoLaunch.searchBranch': 'Search branches',
    'repoLaunch.selectBranch': 'Select branch',
    'repoLaunch.selectWorktree': 'Select worktree mode',
    'repoLaunch.worktreeBadge': 'Isolated',
    'repoLaunch.worktreeCurrent': 'Current worktree',
    'repoLaunch.worktreeCurrentHint': 'Work in this folder',
    'repoLaunch.worktreeIsolated': 'Isolated worktree',
    'repoLaunch.worktreeIsolatedHint': 'New isolated copy',
    'tabs.close': 'Close',
    }[key] ?? key
    return params
      ? Object.entries(params).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), text)
      : text
  },
}))

import { RepositoryLaunchControls } from './RepositoryLaunchControls'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
} from '../../stores/projectDisplayNameStore'

const HEAD_COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(40)

const okRepositoryContext = {
  state: 'ok' as const,
  workDir: '/repo',
  repoRoot: '/repo',
  repoName: 'cc-haha',
  currentBranch: 'main',
  defaultBranch: 'main',
  headCommit: HEAD_COMMIT,
  dirty: false,
  worktrees: [],
  branches: [
    {
      name: 'main',
      current: true,
      local: true,
      remote: false,
      checkedOut: false,
      remoteRef: null,
      worktreePath: null,
      commit: HEAD_COMMIT,
    },
    {
      name: 'feature/h5',
      current: false,
      local: true,
      remote: false,
      checkedOut: false,
      remoteRef: null,
      worktreePath: null,
      commit: OTHER_COMMIT,
    },
  ],
}

/** `okRepositoryContext` plus a branch created off `main`, so still at HEAD. */
const contextWithCreatedBranch = {
  ...okRepositoryContext,
  branches: [
    ...okRepositoryContext.branches,
    {
      name: 'feature/new',
      current: false,
      local: true,
      remote: false,
      checkedOut: false,
      remoteRef: null,
      worktreePath: null,
      commit: HEAD_COMMIT,
    },
  ],
}

/** Rejection shaped like the API client's `ApiError`, which carries the body. */
function apiError(code: string, message = 'boom') {
  return Object.assign(new Error(message), { body: { error: code, message } })
}

function notGitContext(workDir: string) {
  return {
    state: 'not_git_repo' as const,
    workDir,
    repoRoot: null,
    repoName: null,
    currentBranch: null,
    defaultBranch: null,
    dirty: false,
    branches: [],
    worktrees: [],
  }
}

function renderControls(props: Partial<ComponentProps<typeof RepositoryLaunchControls>> = {}) {
  const defaultProps: ComponentProps<typeof RepositoryLaunchControls> = {
    workDir: '/repo',
    onWorkDirChange: vi.fn(),
    branch: 'main',
    onBranchChange: vi.fn(),
    useWorktree: false,
    onUseWorktreeChange: vi.fn(),
  }

  return render(<RepositoryLaunchControls {...defaultProps} {...props} />)
}

/**
 * The pill drives `workDir` through its parent, so anything that asserts what
 * happens *after* a directory is picked needs the prop to actually come back
 * down changed.
 */
function ControlledHarness({
  initialWorkDir = '',
  initialUseWorktree = false,
}: {
  initialWorkDir?: string
  initialUseWorktree?: boolean
}) {
  const [workDir, setWorkDir] = useState(initialWorkDir)
  const [branch, setBranch] = useState<string | null>(null)
  const [useWorktree, setUseWorktree] = useState(initialUseWorktree)

  return (
    <RepositoryLaunchControls
      workDir={workDir}
      onWorkDirChange={setWorkDir}
      branch={branch}
      onBranchChange={setBranch}
      useWorktree={useWorktree}
      onUseWorktreeChange={setUseWorktree}
    />
  )
}

/** Opens the pill's root menu. */
async function openPill() {
  const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
  fireEvent.click(pill)
  return pill
}

/** Opens the pill on a fresh session, where it lands on the directory list. */
async function openEmptyPill() {
  const pill = await screen.findByRole('button', { name: 'Location: Select a project' })
  fireEvent.click(pill)
  return pill
}

/** Opens the pill, then drills into the branch view. */
async function openBranchView() {
  await openPill()
  fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
  return screen.findByRole('listbox', { name: 'Select branch' })
}

describe('RepositoryLaunchControls', () => {
  beforeEach(() => {
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
    viewportMocks.isMobile = false
    viewportMocks.isTauri = false
    apiMocks.getRepositoryContext.mockReset()
    apiMocks.getRepositoryContext.mockResolvedValue(okRepositoryContext)
    apiMocks.createRepositoryBranch.mockReset()
    uiMocks.addToast.mockReset()
    apiMocks.createRepositoryBranch.mockResolvedValue({
      branch: 'feature/new',
      baseRef: 'main',
      context: contextWithCreatedBranch,
    })
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
  })

  it('collapses directory, branch and worktree into a single pill', async () => {
    renderControls()

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    expect(pill).toHaveAttribute('aria-haspopup', 'menu')
    expect(within(pill).getByText('cc-haha')).toBeInTheDocument()
    expect(within(pill).getByText('main')).toBeInTheDocument()

    // The three separate triggers are gone — that was the point of the change.
    expect(screen.queryByRole('button', { name: /Select branch:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Select worktree mode:/ })).not.toBeInTheDocument()
  })

  it('uses the repository-root display name when repository context canonicalizes the requested path', async () => {
    const workDir = '/repo/subdirectory'
    apiMocks.getRepositoryContext.mockResolvedValue({
      ...okRepositoryContext,
      workDir: '/repo',
      repoRoot: '/repo',
    })
    renderControls({ workDir })
    await screen.findByRole('button', { name: 'Location: cc-haha / main' })

    act(() => {
      hydrateProjectDisplayNames(
        { '/repo': 'Custom repository' },
        captureProjectDisplayNameHydrationRevision(),
      )
    })

    const pill = await screen.findByRole('button', { name: 'Location: Custom repository / main' })
    expect(pill).toHaveAttribute('title', `${workDir}\nBranch: main`)
    expect(within(pill).getByText('main')).toBeInTheDocument()
  })

  it('truncates the branch from the start so its tail survives', async () => {
    renderControls()

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    // `dir="rtl"` is what moves the ellipsis to the front; without it a long
    // `feature/...` name would truncate down to its meaningless prefix.
    expect(within(pill).getByText('main').closest('[dir="rtl"]')).not.toBeNull()
  })

  it('marks the isolated worktree on the pill itself', async () => {
    renderControls({ useWorktree: true })

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    expect(within(pill).getByText('Isolated')).toBeInTheDocument()
  })

  it('offers directory, branch and both worktree modes in the root menu', async () => {
    renderControls()
    await openPill()

    const menu = await screen.findByRole('menu', { name: 'Location' })
    expect(within(menu).getByRole('menuitem', { name: /Directory/ })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /Branch/ })).toBeInTheDocument()

    const current = within(menu).getByRole('menuitemradio', { name: /Current worktree/ })
    const isolated = within(menu).getByRole('menuitemradio', { name: /Isolated worktree/ })
    expect(current).toHaveAttribute('aria-checked', 'true')
    expect(isolated).toHaveAttribute('aria-checked', 'false')
  })

  it('switches worktree mode straight from the root menu', async () => {
    const onUseWorktreeChange = vi.fn()
    renderControls({ onUseWorktreeChange })
    await openPill()

    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Isolated worktree/ }))

    expect(onUseWorktreeChange).toHaveBeenCalledWith(true)
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })
  })

  it('drills into the branch list and back out again', async () => {
    renderControls()
    await openBranchView()

    expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Select branch/ }))

    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'Select branch' })).not.toBeInTheDocument()
  })

  it('returns to the root view after picking a branch', async () => {
    const onBranchChange = vi.fn()
    renderControls({ onBranchChange })
    await openBranchView()

    fireEvent.click(screen.getByRole('option', { name: /feature\/h5/ }))

    expect(onBranchChange).toHaveBeenCalledWith('feature/h5')
    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
  })

  it('keeps keyboard branch selection working from the search field', async () => {
    const onBranchChange = vi.fn()
    renderControls({ onBranchChange })
    await openBranchView()

    const input = await screen.findByPlaceholderText('Search branches')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onBranchChange).toHaveBeenCalledWith('feature/h5')
    })
  })

  it('uses the desktop dropdown, not the mobile sheet, on a wide viewport', async () => {
    renderControls()
    await openBranchView()

    expect(screen.getByRole('listbox', { name: 'Select branch' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('uses the full-width mobile bottom sheet in H5 mobile browser mode', async () => {
    viewportMocks.isMobile = true
    viewportMocks.isTauri = false

    renderControls()
    await openPill()

    const dialog = await screen.findByRole('dialog', { name: 'Location' })
    expect(dialog).toHaveClass('inset-x-0')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(within(dialog).getByRole('menu', { name: 'Location' })).toBeInTheDocument()
  })

  it('does not use the H5 mobile sheet inside Tauri even on a narrow viewport', async () => {
    viewportMocks.isMobile = true
    viewportMocks.isTauri = true

    renderControls()
    await openPill()

    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sizes the pill for the toolbar row when placed there', async () => {
    renderControls({ placement: 'toolbar' })

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    // 36px matches the other controls in the composer's toolbar; the standalone
    // line uses 40px for touch.
    expect(pill).toHaveClass('h-9')
    expect(pill).not.toHaveClass('h-10')
  })

  it('sizes the pill for touch when it stands on its own line', async () => {
    renderControls({ placement: 'outside' })

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    expect(pill).toHaveClass('h-10')
  })

  it('keeps a dirty-branch warning compact and inline in the toolbar', async () => {
    apiMocks.getRepositoryContext.mockResolvedValue({
      ...okRepositoryContext,
      dirty: true,
    })

    renderControls({ branch: 'feature/h5', placement: 'toolbar' })

    const warning = await screen.findByRole('status', { name: 'Dirty worktree' })
    expect(warning).toHaveTextContent('Uncommitted changes')
    expect(warning).toHaveAttribute('title', 'Dirty worktree')
    expect(within(warning).getByText('Uncommitted changes')).toHaveClass('hidden', '2xl:inline')
    expect(warning.parentElement).toHaveClass('flex-row')
    expect(screen.queryByText('Dirty worktree')).not.toBeInTheDocument()
  })

  it('keeps the complete dirty-branch explanation outside the toolbar', async () => {
    apiMocks.getRepositoryContext.mockResolvedValue({
      ...okRepositoryContext,
      dirty: true,
    })

    renderControls({ branch: 'feature/h5', placement: 'outside' })

    expect(await screen.findByRole('status', { name: 'Dirty worktree' }))
      .toHaveTextContent('Dirty worktree')
    expect(screen.queryByText('Uncommitted changes')).not.toBeInTheDocument()
  })

  // The dropdown used to close on its own `mousedown` listener, which does not
  // fire reliably for touch input — the "tapping outside doesn't close the
  // menu" shape of bug on the H5 build. `useDismissable` listens on
  // `pointerdown` instead, so this asserts the pointer event, not the mouse one.
  it('closes the menu on an outside pointerdown', async () => {
    renderControls()
    await openPill()
    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)

    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })
  })

  it('keeps the menu open when the pointer goes down inside it', async () => {
    renderControls()
    await openPill()
    const menu = await screen.findByRole('menu', { name: 'Location' })

    fireEvent.pointerDown(menu)

    expect(screen.getByRole('menu', { name: 'Location' })).toBeInTheDocument()
  })

  // The directory list used to be a nested picker that portalled its own
  // dropdown to the body, so a pointer down inside it read as "outside" this
  // menu and needed an `isExempt` escape hatch to avoid tearing down the
  // trigger that opened it. It is one of this menu's own views now.
  it('stays open while the directory view is being used', async () => {
    renderControls()
    await openPill()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Directory/ }))

    const panel = await screen.findByTestId('recent-projects-panel')
    fireEvent.pointerDown(panel)

    expect(screen.getByTestId('recent-projects-panel')).toBeInTheDocument()
  })

  it('closes the menu on Escape', async () => {
    renderControls()
    await openPill()
    await screen.findByRole('menu', { name: 'Location' })

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })
  })

  it('falls back to the folder name when the directory is not a git repo', async () => {
    apiMocks.getRepositoryContext.mockResolvedValue({
      state: 'not_git_repo',
      workDir: '/tmp/scratch',
      repoRoot: null,
      repoName: null,
      currentBranch: null,
      defaultBranch: null,
      dirty: false,
      branches: [],
      worktrees: [],
    })

    renderControls({ workDir: '/tmp/scratch', branch: null })

    const pill = await screen.findByRole('button', { name: 'Location: scratch' })
    expect(within(pill).getByText('scratch')).toBeInTheDocument()

    fireEvent.click(pill)
    // No branch or worktree rows without a repo, so the root view would hold a
    // lone directory row — the menu opens on the directory list instead.
    expect(await screen.findByTestId('recent-projects-panel')).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
  })

  /**
   * Switching branches has always been possible here; creating one meant
   * leaving for a terminal (#1190). The entry lives at the foot of the branch
   * list, and the branch it creates is selected but — like every other pick in
   * this menu — only checked out when the session launches.
   */
  describe('new branch', () => {
    async function openNewBranchForm() {
      await openBranchView()
      fireEvent.click(screen.getByRole('button', { name: 'Create branch…' }))
      return screen.findByLabelText('Branch name')
    }

    it('offers the entry under the branch list without putting it in the listbox', async () => {
      renderControls()
      const listbox = await openBranchView()

      const entry = screen.getByRole('button', { name: 'Create branch…' })
      expect(entry).toBeInTheDocument()
      // An action among the `option`s would be announced as a branch you could
      // pick, and Enter on the search field could land on it.
      expect(listbox).not.toContainElement(entry)
      expect(within(listbox).queryByRole('option', { name: /New branch/ })).not.toBeInTheDocument()
    })

    it('seeds the name with whatever was typed into the branch filter', async () => {
      renderControls()
      await openBranchView()
      fireEvent.change(await screen.findByPlaceholderText('Search branches'), {
        target: { value: '  feature/new  ' },
      })

      fireEvent.click(screen.getByRole('button', { name: 'Create branch…' }))

      expect(await screen.findByLabelText('Branch name')).toHaveValue('feature/new')
    })

    it('creates the branch from the selected one and adopts the returned context', async () => {
      render(<ControlledHarness initialWorkDir="/repo" />)
      const input = await openNewBranchForm()
      expect(screen.getByText('Starts from main')).toBeInTheDocument()

      fireEvent.change(input, { target: { value: 'feature/new' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await waitFor(() => {
        expect(apiMocks.createRepositoryBranch).toHaveBeenCalledWith({
          workDir: '/repo',
          name: 'feature/new',
          from: 'main',
        })
      })

      // Success closes the menu so the selected branch is immediately visible
      // on the pill instead of leaving the user inside an apparently unchanged
      // menu. The returned list is adopted without a second request.
      const pill = await screen.findByRole('button', { name: 'Location: cc-haha / feature/new' })
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
      expect(apiMocks.getRepositoryContext).toHaveBeenCalledTimes(1)
      expect(uiMocks.addToast).toHaveBeenCalledWith({
        type: 'success',
        message: 'Created and selected “feature/new”. It will be checked out when the session starts.',
      })

      fireEvent.click(pill)
      fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
      const listbox = await screen.findByRole('listbox', { name: 'Select branch' })
      expect(within(listbox).getByRole('option', { name: /feature\/new/ })).toBeInTheDocument()
    })

    it('keeps a created branch selected across the external launch-store boundary', async () => {
      const launch = vi.fn()
      const useLaunchTarget = create<{
        branch: string | null
        setBranch: (branch: string | null) => void
      }>((set) => ({
        branch: 'main',
        setBranch: (branch) => set({ branch }),
      }))
      const setLaunchBranch = (branch: string | null) => {
        if (branch === 'qa/launch-picker') {
          // Production React publishes the external-store selection before
          // this component's local context update. Vitest's development build
          // batches them, so force that real ordering at the store boundary.
          flushSync(() => useLaunchTarget.getState().setBranch(branch))
          return
        }
        useLaunchTarget.getState().setBranch(branch)
      }
      const createdContext = {
        ...contextWithCreatedBranch,
        branches: contextWithCreatedBranch.branches.map((candidate) => (
          candidate.name === 'feature/new'
            ? { ...candidate, name: 'qa/launch-picker' }
            : candidate
        )),
      }
      apiMocks.createRepositoryBranch.mockImplementation(() => new Promise((resolve) => {
        window.setTimeout(() => resolve({
          branch: 'qa/launch-picker',
          baseRef: 'main',
          context: createdContext,
        }), 0)
      }))

      function ExternalLaunchHarness() {
        const branch = useLaunchTarget((state) => state.branch)
        return (
          <>
            <RepositoryLaunchControls
              workDir="/repo"
              onWorkDirChange={vi.fn()}
              branch={branch}
              onBranchChange={setLaunchBranch}
              useWorktree={false}
              onUseWorktreeChange={vi.fn()}
            />
            <button
              type="button"
              onClick={() => launch({
                workDir: '/repo',
                repository: {
                  branch: useLaunchTarget.getState().branch,
                  worktree: false,
                },
              })}
            >
              Launch
            </button>
          </>
        )
      }

      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
      const actEnvironment = testGlobals.IS_REACT_ACT_ENVIRONMENT
      testGlobals.IS_REACT_ACT_ENVIRONMENT = false
      async function eventually<T>(read: () => T): Promise<T> {
        let lastError: unknown
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            return read()
          } catch (error) {
            lastError = error
            await new Promise((resolve) => window.setTimeout(resolve, 10))
          }
        }
        throw lastError
      }

      try {
        root.render(<ExternalLaunchHarness />)
        const pill = await eventually(() => (
          screen.getByRole('button', { name: 'Location: cc-haha / main' })
        ))
        pill.click()
        const branchEntry = await eventually(() => screen.getByRole('menuitem', { name: /Branch/ }))
        branchEntry.click()
        const createEntry = await eventually(() => screen.getByRole('button', { name: 'Create branch…' }))
        createEntry.click()

        const input = await eventually(() => screen.getByLabelText('Branch name'))
        const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setInputValue?.call(input, 'qa/launch-picker')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
        const createButton = await eventually(() => {
          const button = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
          if (button.disabled) throw new Error('Create branch button is still disabled')
          return button
        })
        createButton.click()

        await eventually(() => (
          screen.getByRole('button', { name: 'Location: cc-haha / qa/launch-picker' })
        ))
        await eventually(() => {
          if (screen.queryByRole('menu', { name: 'Location' })) {
            throw new Error('Location menu is still open')
          }
          return true
        })

        screen.getByRole('button', { name: 'Launch' }).click()

        expect(launch).toHaveBeenCalledWith({
          workDir: '/repo',
          repository: { branch: 'qa/launch-picker', worktree: false },
        })
        expect(useLaunchTarget.getState().branch).toBe('qa/launch-picker')
        expect(screen.getByRole('button', { name: 'Location: cc-haha / qa/launch-picker' }))
          .toBeInTheDocument()
        expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
      } finally {
        root.unmount()
        container.remove()
        testGlobals.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      }
    })

    it('explains that an isolated worktree starts from the new branch', async () => {
      render(<ControlledHarness initialWorkDir="/repo" initialUseWorktree />)
      const input = await openNewBranchForm()

      fireEvent.change(input, { target: { value: 'feature/new' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await waitFor(() => {
        expect(uiMocks.addToast).toHaveBeenCalledWith({
          type: 'success',
          message: 'Created and selected “feature/new”. An isolated worktree will be created from it when the session starts.',
        })
      })
      expect(await screen.findByRole('button', { name: 'Location: cc-haha / feature/new' }))
        .toBeInTheDocument()
      expect(screen.getByText('Isolated')).toBeInTheDocument()
    })

    // Creating off `main` is also what `from: context.currentBranch` would do,
    // so the default-selection test cannot tell the two apart — it stayed green
    // under exactly that mutation. This drives a non-default selection, which is
    // the contract the "Starts from {branch}" hint advertises.
    it('creates from the branch that is actually selected, not the current one', async () => {
      render(<ControlledHarness initialWorkDir="/repo" />)
      await openBranchView()
      fireEvent.click(screen.getByRole('option', { name: /feature\/h5/ }))

      fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Create branch…' }))
      expect(screen.getByText('Starts from feature/h5')).toBeInTheDocument()

      fireEvent.change(await screen.findByLabelText('Branch name'), {
        target: { value: 'feature/new' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await waitFor(() => {
        expect(apiMocks.createRepositoryBranch).toHaveBeenCalledWith(
          expect.objectContaining({ from: 'feature/h5' }),
        )
      })
    })

    it('trims the typed name before sending it', async () => {
      renderControls()
      const input = await openNewBranchForm()

      fireEvent.change(input, { target: { value: '  feature/new  ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await waitFor(() => {
        expect(apiMocks.createRepositoryBranch).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'feature/new' }),
        )
      })
    })

    it('translates a blank name without requesting branch creation', async () => {
      renderControls()
      const input = await openNewBranchForm()

      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      expect(await screen.findByText('Git will not accept this branch name.')).toBeInTheDocument()

      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      expect(await screen.findByText('Git will not accept this branch name.')).toBeInTheDocument()
      expect(apiMocks.createRepositoryBranch).not.toHaveBeenCalled()
    })

    it('translates a rejected name and keeps the form open', async () => {
      apiMocks.createRepositoryBranch.mockRejectedValue(apiError('REPOSITORY_BRANCH_EXISTS'))
      const onBranchChange = vi.fn()
      renderControls({ onBranchChange })
      const input = await openNewBranchForm()

      fireEvent.change(input, { target: { value: 'feature/h5' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      expect(await screen.findByText('A branch with this name already exists.')).toBeInTheDocument()
      expect(screen.getByLabelText('Branch name')).toHaveValue('feature/h5')
      expect(onBranchChange).not.toHaveBeenCalledWith('feature/h5')
    })

    it('translates an invalid git ref and keeps the form open', async () => {
      apiMocks.createRepositoryBranch.mockRejectedValue(apiError('REPOSITORY_BRANCH_NAME_INVALID'))
      renderControls()
      const input = await openNewBranchForm()

      fireEvent.change(input, { target: { value: 'qa invalid' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      expect(await screen.findByText('Git will not accept this branch name.')).toBeInTheDocument()
      expect(screen.getByLabelText('Branch name')).toHaveValue('qa invalid')
    })

    it('explains an empty repository in the user language', async () => {
      apiMocks.createRepositoryBranch.mockRejectedValue(apiError('REPOSITORY_NO_COMMITS'))
      renderControls()
      const input = await openNewBranchForm()

      fireEvent.change(input, { target: { value: 'first' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      expect(await screen.findByText('This repository has no commits yet.')).toBeInTheDocument()
    })

    it('shows the raw git message alone for an unrecognized failure', async () => {
      apiMocks.createRepositoryBranch.mockRejectedValue(
        apiError('REPOSITORY_BRANCH_CREATE_FAILED', 'Failed to create branch: fatal: cannot lock ref'),
      )
      renderControls()
      const input = await openNewBranchForm()

      fireEvent.change(input, { target: { value: 'feature' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      // A translated shrug would hide the one line that says what went wrong —
      // but the server message already opens with "Failed to create branch:",
      // so prefixing the generic line onto it said the same thing twice.
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Failed to create branch: fatal: cannot lock ref')
      expect(alert).not.toHaveTextContent('Could not create the branch.')
    })

    it('falls back to the generic line when the failure carries no message', async () => {
      apiMocks.createRepositoryBranch.mockRejectedValue(new Error(''))
      renderControls()
      const input = await openNewBranchForm()

      fireEvent.change(input, { target: { value: 'feature' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      expect(await screen.findByText('Could not create the branch.')).toBeInTheDocument()
    })

    /**
     * The pill is a per-tab control, so switching tabs swaps `workDir` under an
     * in-flight create. Adopting that response would file one repo's branch list
     * and selection under another repo's path.
     */
    it('discards a response that arrives after the directory changed', async () => {
      let settle: (value: unknown) => void = () => {}
      apiMocks.createRepositoryBranch.mockImplementation(() => new Promise((resolve) => {
        settle = resolve
      }))
      apiMocks.getRepositoryContext.mockImplementation(async (dir: string) => (
        dir === '/repo' ? okRepositoryContext : { ...okRepositoryContext, workDir: dir, repoName: 'other' }
      ))

      const { rerender } = render(
        <RepositoryLaunchControls
          workDir="/repo"
          onWorkDirChange={vi.fn()}
          branch="main"
          onBranchChange={vi.fn()}
          useWorktree={false}
          onUseWorktreeChange={vi.fn()}
        />,
      )
      const input = await openNewBranchForm()
      fireEvent.change(input, { target: { value: 'feature/new' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      const onBranchChange = vi.fn()
      rerender(
        <RepositoryLaunchControls
          workDir="/other"
          onWorkDirChange={vi.fn()}
          branch="main"
          onBranchChange={onBranchChange}
          useWorktree={false}
          onUseWorktreeChange={vi.fn()}
        />,
      )
      settle({ branch: 'feature/new', baseRef: 'main', context: contextWithCreatedBranch })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Location: other/ })).toBeInTheDocument()
      })
      expect(onBranchChange).not.toHaveBeenCalledWith('feature/new')
    })

    it('returns to the branch list on cancel without creating anything', async () => {
      renderControls()
      await openNewBranchForm()

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(await screen.findByRole('listbox', { name: 'Select branch' })).toBeInTheDocument()
      expect(apiMocks.createRepositoryBranch).not.toHaveBeenCalled()
    })

    /**
     * The sheet has no inner scroller of its own — `branchList` drops its
     * `max-h`/`overflow-y-auto` on mobile — so rendering the entry as a sibling
     * of the list in `children` lets it scroll off the bottom with the branches.
     * `MobileBottomSheet`'s `footer` slot is `shrink-0` outside the scrolling
     * body, which is the only place it stays reachable.
     */
    it('pins the entry to the sheet footer, outside the scrolling body, on mobile', async () => {
      viewportMocks.isMobile = true
      renderControls()
      await openPill()
      fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))

      const entry = await screen.findByRole('button', { name: 'Create branch…' })
      const scroller = screen.getByRole('listbox', { name: 'Select branch' }).parentElement
      expect(scroller).toHaveClass('overflow-y-auto')
      expect(scroller).not.toContainElement(entry)
    })

    it('reaches the create form from the mobile sheet and back again', async () => {
      viewportMocks.isMobile = true
      renderControls()
      await openPill()
      fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Create branch…' }))

      expect(await screen.findByLabelText('Branch name')).toBeInTheDocument()
      expect(await screen.findByRole('dialog', { name: 'New branch' })).toBeInTheDocument()
      // The footer belongs to the branch list, not the form under it.
      expect(screen.queryByRole('button', { name: 'Create branch…' })).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /Select branch/ }))
      expect(await screen.findByRole('listbox', { name: 'Select branch' })).toBeInTheDocument()
    })

    /**
     * Creating a branch off the one you are standing on is the whole point of
     * doing it with work in progress, and that switch only moves the ref — git
     * never blocks it. Warning there sent people to an isolated worktree they
     * did not need. Driven through the real create rather than hand-built state,
     * because that transition is the thing being claimed (AGENTS.md).
     */
    it('drops the dirty warning once a branch is created off the current one', async () => {
      apiMocks.getRepositoryContext.mockResolvedValue({ ...okRepositoryContext, dirty: true })
      apiMocks.createRepositoryBranch.mockResolvedValue({
        branch: 'feature/new',
        baseRef: 'main',
        context: { ...contextWithCreatedBranch, dirty: true },
      })

      render(<ControlledHarness initialWorkDir="/repo" />)
      const input = await openNewBranchForm()
      fireEvent.change(input, { target: { value: 'feature/new' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await screen.findByRole('button', { name: 'Location: cc-haha / feature/new' })
      expect(screen.queryByRole('status', { name: 'Dirty worktree' })).not.toBeInTheDocument()
    })

    it('does not warn about uncommitted changes for a branch already at HEAD', async () => {
      apiMocks.getRepositoryContext.mockResolvedValue({
        ...contextWithCreatedBranch,
        dirty: true,
      })

      renderControls({ branch: 'feature/new' })

      await screen.findByRole('button', { name: 'Location: cc-haha / feature/new' })
      expect(screen.queryByRole('status', { name: 'Dirty worktree' })).not.toBeInTheDocument()
    })

    it('still warns when the selected branch would rewrite files', async () => {
      apiMocks.getRepositoryContext.mockResolvedValue({
        ...contextWithCreatedBranch,
        dirty: true,
      })

      renderControls({ branch: 'feature/h5' })

      expect(await screen.findByRole('status', { name: 'Dirty worktree' })).toBeInTheDocument()
    })

    it('keeps warning when the server reports no commits at all', async () => {
      apiMocks.getRepositoryContext.mockResolvedValue({
        ...okRepositoryContext,
        dirty: true,
        headCommit: undefined,
        branches: okRepositoryContext.branches.map(({ commit: _commit, ...rest }) => rest),
      })

      renderControls({ branch: 'feature/h5' })

      expect(await screen.findByRole('status', { name: 'Dirty worktree' })).toBeInTheDocument()
    })
  })

  /**
   * The pill's menu was built around a repo it already had: directory, branch
   * and worktree. In a fresh session `isGitReady` is false, both of the latter
   * are gone, and the root view collapsed to a single "Directory" row that
   * existed only to open a second dropdown. These pin the escape from it.
   */
  describe('directory view', () => {
    it('opens straight on the directory list when no directory is picked yet', async () => {
      renderControls({ workDir: '', branch: null })
      await openEmptyPill()

      expect(await screen.findByTestId('recent-projects-panel')).toBeInTheDocument()
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })

    it('offers no way back to the root view while it would still be empty', async () => {
      renderControls({ workDir: '', branch: null })
      await openEmptyPill()
      await screen.findByTestId('recent-projects-panel')

      // Going back would land on the single-row shell this view exists to skip.
      expect(screen.queryByRole('button', { name: 'Directory' })).not.toBeInTheDocument()
    })

    it('drills into the directory view and back out again once there is a repo', async () => {
      renderControls()
      await openPill()
      fireEvent.click(await screen.findByRole('menuitem', { name: /Directory/ }))

      expect(await screen.findByTestId('recent-projects-panel')).toBeInTheDocument()
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Directory' }))

      expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
      expect(screen.queryByTestId('recent-projects-panel')).not.toBeInTheDocument()
    })

    it('reveals branch and worktree in the root view after a repo is picked', async () => {
      render(<ControlledHarness />)
      await openEmptyPill()
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /repo' }))

      // The menu stays open and swings back to the root view, where the rows
      // that were missing a moment ago are now populated.
      const menu = await screen.findByRole('menu', { name: 'Location' })
      expect(await within(menu).findByRole('menuitem', { name: /Branch/ })).toBeInTheDocument()
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2)
    })

    it('closes the menu when the picked directory turns out not to be a repo', async () => {
      apiMocks.getRepositoryContext.mockResolvedValue({
        state: 'not_git_repo',
        workDir: '/tmp/plain',
        repoRoot: null,
        repoName: null,
        currentBranch: null,
        defaultBranch: null,
        dirty: false,
        branches: [],
        worktrees: [],
      })

      render(<ControlledHarness />)
      await openEmptyPill()
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /tmp/plain' }))

      // Nothing left to reveal, so holding the menu open would just be a shell.
      await waitFor(() => {
        expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
      })
      expect(screen.queryByTestId('recent-projects-panel')).not.toBeInTheDocument()
    })

    /**
     * On the render right after a pick, `context` still describes the *old*
     * directory and `loading` has not flipped to true yet. Resolving the
     * pending pick against it decides on the wrong repo — and because the
     * pending state is cleared at the same time, nothing ever corrects it.
     * Both directions below fail in opposite ways without the identity check.
     */
    it('does not judge a plain folder by the repo it replaced', async () => {
      apiMocks.getRepositoryContext.mockImplementation(async (dir: string) => (
        dir === '/repo' ? okRepositoryContext : notGitContext(dir)
      ))

      render(<ControlledHarness initialWorkDir="/repo" />)
      await openPill()
      fireEvent.click(await screen.findByRole('menuitem', { name: /Directory/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /tmp/plain' }))

      // Reading the stale `ok` context here would hold the menu open on the
      // old repo's branch and worktree rows.
      await waitFor(() => {
        expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
      })
      expect(screen.queryByTestId('recent-projects-panel')).not.toBeInTheDocument()
    })

    it('does not judge a repo by the plain folder it replaced', async () => {
      apiMocks.getRepositoryContext.mockImplementation(async (dir: string) => (
        dir === '/repo' ? okRepositoryContext : notGitContext(dir)
      ))

      render(<ControlledHarness initialWorkDir="/tmp/plain" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Location: plain' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /repo' }))

      // Reading the stale `not_git_repo` context here would close the menu on
      // a repo that does have a branch and worktree modes to offer.
      const menu = await screen.findByRole('menu', { name: 'Location' })
      expect(await within(menu).findByRole('menuitem', { name: /Branch/ })).toBeInTheDocument()
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2)
    })
  })
})
