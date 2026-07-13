// @vitest-environment jsdom

// @ts-expect-error jsdom is installed in this workspace without local type declarations
import { JSDOM } from 'jsdom'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

if (typeof document === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  })
  const { window } = dom

  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
}

type WorkspaceApiMocks = {
  getWorkspaceStatusMock: ReturnType<typeof vi.fn>
  getWorkspaceTreeMock: ReturnType<typeof vi.fn>
  getWorkspaceFileMock: ReturnType<typeof vi.fn>
  getWorkspaceDiffMock: ReturnType<typeof vi.fn>
}

var mocks: WorkspaceApiMocks | undefined

function getMocks() {
  if (!mocks) {
    throw new Error('Workspace API mocks were not initialized')
  }
  return mocks
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function setWorkspaceState(
  updater:
    | ReturnType<typeof useWorkspacePanelStore.getInitialState>
    | Parameters<typeof useWorkspacePanelStore.setState>[0],
) {
  await act(() => {
    useWorkspacePanelStore.setState(updater as Parameters<typeof useWorkspacePanelStore.setState>[0], true)
  })
}

async function setSettingsState(
  updater:
    | ReturnType<typeof useSettingsStore.getInitialState>
    | Parameters<typeof useSettingsStore.setState>[0],
) {
  await act(() => {
    useSettingsStore.setState(updater as Parameters<typeof useSettingsStore.setState>[0], true)
  })
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderPanel(
  sessionId: string,
  props: { embedded?: boolean; forceVisible?: boolean } = {},
) {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<WorkspacePanel sessionId={sessionId} {...props} />)
    await Promise.resolve()
  })
  return view
}

async function clickElement(element: Element) {
  await act(async () => {
    fireEvent.click(element)
    await Promise.resolve()
  })
  await flushReactWork()
}

function findTextNodeContaining(container: Element, text: string) {
  const walker = document.createTreeWalker(container, 4)
  let current = walker.nextNode()
  while (current) {
    if (current.textContent?.includes(text)) return current
    current = walker.nextNode()
  }
  throw new Error(`Unable to find text node containing ${text}`)
}

async function selectWorkspaceCodeText(
  view: Awaited<ReturnType<typeof renderPanel>>,
  startLine: number,
  startText: string,
  endLine: number,
  endText: string,
) {
  const code = view.getByTestId('workspace-code')
  const startRow = code.querySelector(`[data-workspace-line-number="${startLine}"]`)
  const endRow = code.querySelector(`[data-workspace-line-number="${endLine}"]`)
  if (!startRow || !endRow) throw new Error('Selection rows were not rendered')

  Object.assign(code.parentElement?.parentElement ?? code, {
    getBoundingClientRect: () => ({
      left: 100,
      top: 24,
      right: 520,
      bottom: 420,
      width: 420,
      height: 396,
      x: 100,
      y: 24,
      toJSON: () => ({}),
    }),
  })

  const startNode = findTextNodeContaining(startRow, startText)
  const endNode = findTextNodeContaining(endRow, endText)
  const startOffset = startNode.textContent?.indexOf(startText) ?? -1
  const endOffset = (endNode.textContent?.indexOf(endText) ?? -1) + endText.length
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  Object.assign(range, {
    getBoundingClientRect: () => ({
      left: 120,
      top: 100,
      right: 240,
      bottom: 118,
      width: 120,
      height: 18,
      x: 120,
      y: 100,
      toJSON: () => ({}),
    }),
  })

  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  await act(async () => {
    fireEvent.mouseUp(code, { clientX: 180, clientY: 122 })
    await Promise.resolve()
  })
  await flushReactWork()
}

async function selectRenderedText(container: Element, text: string, target?: Element) {
  const textNode = findTextNodeContaining(container, text)
  const startOffset = textNode.textContent?.indexOf(text) ?? -1
  const range = document.createRange()
  range.setStart(textNode, startOffset)
  range.setEnd(textNode, startOffset + text.length)
  Object.assign(range, {
    getBoundingClientRect: () => ({
      left: 130,
      top: 60,
      right: 260,
      bottom: 78,
      width: 130,
      height: 18,
      x: 130,
      y: 60,
      toJSON: () => ({}),
    }),
  })
  Object.assign(target ?? container, {
    getBoundingClientRect: () => ({
      left: 100,
      top: 24,
      right: 520,
      bottom: 420,
      width: 420,
      height: 396,
      x: 100,
      y: 24,
      toJSON: () => ({}),
    }),
  })

  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  await act(async () => {
    fireEvent.mouseUp(target ?? container, { clientX: 190, clientY: 80 })
    await Promise.resolve()
  })
  await flushReactWork()
}

function classNameContains(element: Element | null, needle: string) {
  let current = element
  while (current) {
    if (typeof current.className === 'string' && current.className.includes(needle)) {
      return true
    }
    current = current.parentElement
  }
  return false
}

type SvgMeasurementPrototype = SVGElement & {
  getBBox?: () => { x: number; y: number; width: number; height: number }
  getComputedTextLength?: () => number
}

function ensureMermaidSvgMeasurementStubs() {
  const svgPrototype = SVGElement.prototype as SvgMeasurementPrototype

  if (!svgPrototype.getBBox) {
    Object.defineProperty(svgPrototype, 'getBBox', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 120,
        height: 24,
      }),
    })
  }

  if (!svgPrototype.getComputedTextLength) {
    Object.defineProperty(svgPrototype, 'getComputedTextLength', {
      configurable: true,
      value: () => 96,
    })
  }
}

vi.mock('../../api/sessions', () => ({
  sessionsApi: (() => {
    if (!mocks) {
      mocks = {
        getWorkspaceStatusMock: vi.fn(),
        getWorkspaceTreeMock: vi.fn(),
        getWorkspaceFileMock: vi.fn(),
        getWorkspaceDiffMock: vi.fn(),
      }
    }

    return {
      getWorkspaceStatus: mocks.getWorkspaceStatusMock,
      getWorkspaceTree: mocks.getWorkspaceTreeMock,
      getWorkspaceFile: mocks.getWorkspaceFileMock,
      getWorkspaceDiff: mocks.getWorkspaceDiffMock,
    }
  })(),
}))

vi.mock('../../api/openTargets', () => ({
  openTargetsApi: {
    list: vi.fn().mockResolvedValue({ platform: 'darwin', targets: [], primaryTargetId: null, cachedAt: 0, ttlMs: 60000 }),
    open: vi.fn().mockResolvedValue({ ok: true, targetId: '', path: '' }),
  },
}))

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }))

import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useUIStore } from '../../stores/uiStore'
import { WorkspacePanel } from './WorkspacePanel'

describe('WorkspacePanel', () => {
  const workspaceInitialState = useWorkspacePanelStore.getInitialState()
  const workspaceChatInitialState = useWorkspaceChatContextStore.getInitialState()
  const settingsInitialState = useSettingsStore.getInitialState()
  const chatInitialState = useChatStore.getInitialState()

  beforeEach(async () => {
    vi.clearAllMocks()
    ensureMermaidSvgMeasurementStubs()
    await setWorkspaceState(workspaceInitialState)
    useChatStore.setState(chatInitialState, true)
    useWorkspaceChatContextStore.setState(workspaceChatInitialState, true)
    await setSettingsState({ ...settingsInitialState, locale: 'en' })

    getMocks().getWorkspaceStatusMock.mockImplementation(async (sessionId: string) =>
      useWorkspacePanelStore.getState().statusBySession[sessionId] ?? {
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      },
    )
    getMocks().getWorkspaceTreeMock.mockImplementation(async (sessionId: string, path = '') =>
      useWorkspacePanelStore.getState().treeBySessionPath[sessionId]?.[path] ?? {
        state: 'ok',
        path,
        entries: [],
      },
    )
  })

  afterEach(async () => {
    cleanup()
    await setWorkspaceState(workspaceInitialState)
    useChatStore.setState(chatInitialState, true)
    useWorkspaceChatContextStore.setState(workspaceChatInitialState, true)
    await setSettingsState(settingsInitialState)
    vi.restoreAllMocks()
  })

  it('stays hidden when the panel is closed', async () => {
    const view = await renderPanel('session-hidden')

    expect(view.queryByTestId('workspace-panel')).toBeNull()
  })

  it('loads changed status on open and opens a diff preview from the changed view', async () => {
    const statusRequest = deferred<{
      state: 'ok'
      workDir: string
      repoName: string
      branch: string
      isGitRepo: true
      changedFiles: Array<{
        path: string
        status: 'modified'
        additions: number
        deletions: number
      }>
    }>()
    const diffRequest = deferred<{
      state: 'ok'
      path: string
      diff: string
    }>()

    getMocks().getWorkspaceStatusMock.mockReturnValue(statusRequest.promise)
    getMocks().getWorkspaceDiffMock.mockReturnValue(diffRequest.promise)

    await act(() => {
      useWorkspacePanelStore.getState().openPanel('session-changed')
    })

    const view = await renderPanel('session-changed')

    const compactPanel = view.getByTestId('workspace-panel')
    expect(compactPanel.style.width).toBe('520px')
    expect(compactPanel.style.maxWidth).toBe('36%')
    expect(compactPanel.style.minWidth).toBe('min(340px, 40%)')

    await waitFor(() => {
      expect(getMocks().getWorkspaceStatusMock).toHaveBeenCalledWith('session-changed')
    })

    await act(async () => {
      statusRequest.resolve({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 4,
            deletions: 1,
          },
        ],
      })
      await statusRequest.promise
    })

    expect(view.getByPlaceholderText('Filter files...')).toBeTruthy()

    await waitFor(() => {
      expect(view.container.querySelector('[data-workspace-file-path="src/app.ts"]')).toBeTruthy()
    })
    await clickElement(view.container.querySelector('[data-workspace-file-path="src/app.ts"]')!)

    await waitFor(() => {
      expect(getMocks().getWorkspaceDiffMock).toHaveBeenCalledWith('session-changed', 'src/app.ts')
    })

    await act(async () => {
      diffRequest.resolve({
        state: 'ok',
        path: 'src/app.ts',
        diff: '@@ -1 +1 @@\n-console.log("old")\n+console.log("new")',
      })
      await diffRequest.promise
    })

    await waitFor(() => {
      expect(view.getByTestId('workspace-code').textContent).toContain('console.log("new")')
    })
    expect(view.queryByRole('tablist', { name: 'Preview tabs' })).toBeNull()
    const previewHeader = view.getByTestId('workspace-preview-header')
    expect(previewHeader.textContent).toContain('src/app.ts')
    expect(previewHeader.textContent).toContain('+4')
    expect(previewHeader.textContent).toContain('-1')
    expect(view.queryByTestId('workspace-review-toolbar')).toBeNull()
    expect(view.getByTestId('workspace-review-layout').className).toContain('grid-cols-1')
    expect(view.getByTestId('workspace-review-layout').className).toContain('overflow-hidden')
    expect(view.getByTestId('workspace-preview-column').className).toContain('min-h-0')
    expect(view.getByTestId('workspace-preview-column').className).toContain('overflow-hidden')
    expect(previewHeader.textContent).not.toContain('DIFF')
    expect(view.queryByTestId('workspace-file-navigator')).toBeNull()
    await clickElement(view.getByRole('button', { name: 'Show file navigator' }))
    expect(view.getByTestId('workspace-file-navigator').className).toContain('absolute')
    expect(view.queryByTestId('workspace-file-navigator-header')).toBeNull()
    expect(view.queryByText('1 file')).toBeNull()
    expect(view.getByTestId('workspace-file-navigator').className).toContain('w-[min(280px,100%)]')
    expect(view.getByTestId('workspace-review-layout').className).toContain('grid-cols-1')
    const expandedPanel = view.getByTestId('workspace-panel')
    expect(expandedPanel.style.width).toBe('860px')
    expect(expandedPanel.style.maxWidth).toBe('min(62%, calc(100% - 328px))')
    expect(expandedPanel.style.minWidth).toBe('min(420px, 54%)')
  })

  it.each([
    ['diff:src/app.ts', 'modified', 'Modified'],
    ['file:src/app.ts', 'added', 'Added'],
  ] as const)('marks the changed row active for %s and localizes its %s status', async (activeTabId, status, statusLabel) => {
    const sessionId = `session-active-${status}`
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: { isOpen: true, activeView: 'changed', hasUserSelectedView: true },
      },
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [{ path: 'src/app.ts', status, additions: 2, deletions: 1 }],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        [sessionId]: [{
          id: activeTabId,
          path: 'src/app.ts',
          kind: activeTabId.startsWith('diff:') ? 'diff' : 'file',
          title: 'app.ts',
          state: 'ok',
          ...(activeTabId.startsWith('diff:')
            ? { diff: '@@ -1 +1 @@\n-old\n+new' }
            : { content: 'const app = true', language: 'typescript', size: 16 }),
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        [sessionId]: activeTabId,
      },
    }))

    const view = await renderPanel(sessionId)
    await clickElement(view.getByRole('button', { name: 'Show file navigator' }))

    const row = view.container.querySelector('[data-workspace-file-path="src/app.ts"]')
    if (!row) throw new Error('Changed file row was not rendered')
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.className).toContain('bg-[var(--color-info-container)]')
    expect(view.getByLabelText(statusLabel).textContent).toBe(status === 'modified' ? 'M' : 'A')
  })

  it('keeps navigator controls and filter feedback in one header when no file is open', async () => {
    const sessionId = 'session-review-toolbar'
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: { isOpen: true, activeView: 'changed', hasUserSelectedView: true },
      },
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: {
          state: 'ok',
          workDir: '/repo',
          repoName: 'claude-code-haha',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [
            { path: 'desktop/src/App.tsx', status: 'modified', additions: 7, deletions: 2 },
            { path: 'desktop/src/theme.css', status: 'modified', additions: 3, deletions: 1 },
            { path: 'docs/review.md', status: 'added', additions: 5, deletions: 0 },
          ],
        },
      },
    }))

    const view = await renderPanel(sessionId)

    expect(view.queryByTestId('workspace-review-toolbar')).toBeNull()
    const navigatorHeader = view.getByTestId('workspace-file-navigator-header')
    expect(navigatorHeader.tagName).toBe('HEADER')
    expect(navigatorHeader.textContent).toContain('Changed files')
    expect(view.getByRole('button', { name: /Refresh/ })).toBeTruthy()
    expect(view.queryByText('claude-code-haha')).toBeNull()
    expect(view.queryByText('main')).toBeNull()

    const filter = view.getByPlaceholderText('Filter files...')
    expect(view.queryByText('3 files')).toBeNull()
    fireEvent.change(filter, { target: { value: 'theme' } })

    expect(view.getByText('1 of 3 files')).toBeTruthy()
    expect(view.container.querySelector('[data-workspace-file-path="desktop/src/theme.css"]')).toBeTruthy()
    expect(view.container.querySelector('[data-workspace-file-path="desktop/src/App.tsx"]')).toBeNull()
    expect(view.container.querySelector('[data-workspace-file-path="docs/review.md"]')).toBeNull()
  })

  it('keeps the full workbench tab in a stable diff and 280px navigator split', async () => {
    const sessionId = 'session-full-review-workbench'
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: { isOpen: true, activeView: 'changed', hasUserSelectedView: true },
      },
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 }],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        [sessionId]: [{
          id: 'diff:src/app.ts',
          path: 'src/app.ts',
          kind: 'diff',
          title: 'app.ts',
          diff: '@@ -1 +1 @@\n-old\n+new',
          state: 'ok',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        [sessionId]: 'diff:src/app.ts',
      },
    }))

    const view = await renderPanel(sessionId, { embedded: true, forceVisible: true })

    expect(view.getByTestId('workspace-review-layout').className).toContain('grid-cols-[minmax(0,1fr)_280px]')
    expect(view.getByTestId('workspace-review-layout').className).toContain('overflow-hidden')
    expect(view.getByTestId('workspace-preview-column').className).toContain('min-h-0')
    expect(view.getByTestId('workspace-preview-column').className).toContain('overflow-hidden')
    expect(view.getByTestId('workspace-file-navigator').className).not.toContain('absolute')
    expect(view.getByRole('button', { name: 'Hide file navigator' })).toBeTruthy()
  })

  it('groups changed files by directory without weakening file filtering', async () => {
    const sessionId = 'session-grouped-changes'
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: { isOpen: true, activeView: 'changed', hasUserSelectedView: true },
      },
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [
            { path: 'desktop/src/App.tsx', status: 'modified', additions: 7, deletions: 2 },
            { path: 'desktop/src/theme.css', status: 'modified', additions: 3, deletions: 1 },
            { path: 'docs/review.md', status: 'added', additions: 5, deletions: 0 },
          ],
        },
      },
    }))

    const view = await renderPanel(sessionId)

    expect(view.getByText('desktop/src')).toBeTruthy()
    expect(view.getByText('docs')).toBeTruthy()
    expect(view.getByText('App.tsx')).toBeTruthy()
    expect(view.getByText('theme.css')).toBeTruthy()

    fireEvent.change(view.getByPlaceholderText('Filter files...'), { target: { value: 'theme' } })

    expect(view.getByText('desktop/src')).toBeTruthy()
    expect(view.queryByText('docs')).toBeNull()
    expect(view.getByText('theme.css')).toBeTruthy()
    expect(view.queryByText('App.tsx')).toBeNull()
  })

  it('gives renamed files enough height to show the old path without overlapping the next row', async () => {
    const sessionId = 'session-renamed-file-height'
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: { isOpen: true, activeView: 'changed', hasUserSelectedView: true },
      },
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [
            {
              path: 'desktop/src/components/workspace/NewWorkspacePanel.tsx',
              oldPath: 'desktop/src/components/workspace/LegacyWorkspacePanelWithALongName.tsx',
              status: 'renamed',
              additions: 2,
              deletions: 2,
            },
            { path: 'desktop/src/components/workspace/next.ts', status: 'modified', additions: 1, deletions: 0 },
          ],
        },
      },
    }))

    const view = await renderPanel(sessionId)
    const oldPath = view.getByText('desktop/src/components/workspace/LegacyWorkspacePanelWithALongName.tsx')
    const renamedRow = oldPath.closest('button')

    expect(renamedRow?.className).toContain('min-h-11')
    expect(renamedRow?.className).not.toContain('h-9')
    expect(view.getByText('next.ts')).toBeTruthy()
  })

  it('refreshes status on open and switches back to changed files when new changes exist', async () => {
    getMocks().getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/Fresh.ts',
          status: 'modified',
          additions: 4,
          deletions: 1,
        },
      ],
    })
    getMocks().getWorkspaceTreeMock.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: [{ name: 'src', path: 'src', isDirectory: true }],
    })

    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-stale-all': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-stale-all': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
    }))

    const view = await renderPanel('session-stale-all')

    await waitFor(() => {
      expect(getMocks().getWorkspaceStatusMock).toHaveBeenCalledWith('session-stale-all')
    })
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Changed files' })).toBeTruthy()
    })
    expect(view.container.querySelector('[data-workspace-file-path="src/Fresh.ts"]')).toBeTruthy()
  })

  it('loads workspace status when opened while the chat is running', async () => {
    getMocks().getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/running.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        'session-running-open': {
          chatState: 'thinking',
        } as never,
      },
    })

    await act(() => {
      useWorkspacePanelStore.getState().openPanel('session-running-open')
    })

    const view = await renderPanel('session-running-open')

    await waitFor(() => {
      expect(getMocks().getWorkspaceStatusMock).toHaveBeenCalledWith('session-running-open')
    })
    await waitFor(() => {
      expect(view.container.querySelector('[data-workspace-file-path="src/running.ts"]')).toBeTruthy()
    })
    expect(view.queryByText('Loading...')).toBeNull()
  })

  it('renders transcript-derived changed files for non-git sessions', async () => {
    getMocks().getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/tmp/non-git-session',
      repoName: 'non-git-session',
      branch: null,
      isGitRepo: false,
      changedFiles: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
        },
      ],
    })
    getMocks().getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/app.ts',
      diff: 'diff --session a/src/app.ts b/src/app.ts\n-export const answer = 1\n+export const answer = 2',
    })

    await act(() => {
      useWorkspacePanelStore.getState().openPanel('session-non-git')
    })

    const view = await renderPanel('session-non-git')

    await waitFor(() => {
      expect(view.container.querySelector('[data-workspace-file-path="src/app.ts"]')).toBeTruthy()
    })
    expect(view.queryByText('No matching files')).toBeNull()

    await clickElement(view.container.querySelector('[data-workspace-file-path="src/app.ts"]')!)

    await waitFor(() => {
      expect(getMocks().getWorkspaceDiffMock).toHaveBeenCalledWith('session-non-git', 'src/app.ts')
    })
    await waitFor(() => {
      expect(view.getByTestId('workspace-code').textContent).toContain('export const answer = 2')
    })
  })

  it('opens to all files when the current turn has no changed files', async () => {
    const statusRequest = deferred<{
      state: 'ok'
      workDir: string
      repoName: string
      branch: string
      isGitRepo: true
      changedFiles: []
    }>()
    const rootTreeRequest = deferred<{
      state: 'ok'
      path: ''
      entries: Array<{ name: string; path: string; isDirectory: boolean }>
    }>()

    getMocks().getWorkspaceStatusMock.mockReturnValue(statusRequest.promise)
    getMocks().getWorkspaceTreeMock.mockReturnValue(rootTreeRequest.promise)

    await act(() => {
      useWorkspacePanelStore.getState().openPanel('session-empty-tree')
    })

    const view = await renderPanel('session-empty-tree')
    expect(view.getByRole('button', { name: 'Changed files' })).toBeTruthy()

    await act(async () => {
      statusRequest.resolve({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      })
      await statusRequest.promise
    })

    await waitFor(() => {
      expect(useWorkspacePanelStore.getState().getActiveView('session-empty-tree')).toBe('all')
      expect(getMocks().getWorkspaceTreeMock).toHaveBeenCalledWith('session-empty-tree', '')
    })

    await act(async () => {
      rootTreeRequest.resolve({
        state: 'ok',
        path: '',
        entries: [
          { name: 'src', path: 'src', isDirectory: true },
          { name: 'README.md', path: 'README.md', isDirectory: false },
        ],
      })
      await rootTreeRequest.promise
    })

    expect(view.getByRole('button', { name: 'All files' })).toBeTruthy()
    expect(await view.findByText('src')).toBeTruthy()
    expect(await view.findByText('README.md')).toBeTruthy()
    expect(view.queryByRole('status')).toBeNull()
    expect(view.queryByText('No changes')).toBeNull()

    fireEvent.change(view.getByPlaceholderText('Filter files...'), { target: { value: 'readme' } })

    expect(view.getByRole('status').textContent).toBe('1 of 2 items')
    expect(view.queryByText('src')).toBeNull()
    expect(view.getByText('README.md')).toBeTruthy()
  })

  it('lazy loads the root tree, expands directories, and opens file previews from the all-files view', async () => {
    const statusRequest = deferred<{
      state: 'ok'
      workDir: string
      repoName: string
      branch: string
      isGitRepo: true
      changedFiles: []
    }>()
    const rootTreeRequest = deferred<{
      state: 'ok'
      path: ''
      entries: Array<{ name: string; path: string; isDirectory: boolean }>
    }>()
    const childTreeRequest = deferred<{
      state: 'ok'
      path: 'src'
      entries: Array<{ name: string; path: string; isDirectory: boolean }>
    }>()
    const fileRequest = deferred<{
      state: 'ok'
      path: string
      content: string
      language: string
      size: number
    }>()

    getMocks().getWorkspaceStatusMock.mockReturnValue(statusRequest.promise)
    getMocks().getWorkspaceTreeMock
      .mockReturnValueOnce(rootTreeRequest.promise)
      .mockReturnValueOnce(childTreeRequest.promise)
    getMocks().getWorkspaceFileMock.mockReturnValue(fileRequest.promise)

    await act(() => {
      useWorkspacePanelStore.getState().openPanel('session-tree')
    })

    const view = await renderPanel('session-tree')

    expect(view.getByRole('button', { name: 'Changed files' })).toBeTruthy()

    await clickElement(view.getByRole('button', { name: 'Changed files' }))
    await clickElement(view.getByRole('menuitem', { name: 'All files' }))

    await waitFor(() => {
      expect(getMocks().getWorkspaceTreeMock).toHaveBeenCalledWith('session-tree', '')
    })

    await act(async () => {
      statusRequest.resolve({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      })
      rootTreeRequest.resolve({
        state: 'ok',
        path: '',
        entries: [
          { name: 'src', path: 'src', isDirectory: true },
          { name: 'README.md', path: 'README.md', isDirectory: false },
        ],
      })
      await Promise.all([statusRequest.promise, rootTreeRequest.promise])
    })

    const folderLabel = await view.findByText('src')
    const folderButton = folderLabel.closest('button')
    if (!folderButton) {
      throw new Error('Expected src label to be rendered inside a folder button')
    }
    expect(folderButton.getAttribute('aria-expanded')).toBe('false')

    await clickElement(folderButton)

    await waitFor(() => {
      expect(getMocks().getWorkspaceTreeMock).toHaveBeenCalledWith('session-tree', 'src')
    })
    await act(async () => {
      childTreeRequest.resolve({
        state: 'ok',
        path: 'src',
        entries: [{ name: 'index.ts', path: 'src/index.ts', isDirectory: false }],
      })
      await childTreeRequest.promise
    })
    await waitFor(() => {
      expect(folderButton.getAttribute('aria-expanded')).toBe('true')
    })

    await clickElement(await view.findByText('index.ts'))

    await waitFor(() => {
      expect(getMocks().getWorkspaceFileMock).toHaveBeenCalledWith('session-tree', 'src/index.ts')
    })
    await act(async () => {
      fileRequest.resolve({
        state: 'ok',
        path: 'src/index.ts',
        content: 'export const ready = true',
        language: 'typescript',
        size: 25,
      })
      await fileRequest.promise
    })

    await waitFor(() => {
      expect(view.getByTestId('workspace-code').textContent).toContain('export const ready = true')
    })
  })

  it('renders multiple preview tabs and closes only the exact requested tab', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-tabs': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-tabs': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-tabs': [
          {
            id: 'file:src/a.ts',
            path: 'src/a.ts',
            kind: 'file',
            title: 'a.ts',
            language: 'typescript',
            content: 'export const a = 1',
            state: 'ok',
            size: 18,
          },
          {
            id: 'diff:src/a.ts',
            path: 'src/a.ts',
            kind: 'diff',
            title: 'a.ts',
            diff: '@@ -1 +1 @@',
            state: 'ok',
          },
          {
            id: 'file:src/b.ts',
            path: 'src/b.ts',
            kind: 'file',
            title: 'b.ts',
            language: 'typescript',
            content: 'export const b = 1',
            state: 'ok',
            size: 18,
          },
        ],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-tabs': 'diff:src/a.ts',
      },
    }))

    const view = await renderPanel('session-tabs')

    expect(view.getByRole('tablist', { name: 'Preview tabs' })).toBeTruthy()
    expect(view.getAllByRole('tab', { name: /a\.ts/ })).toHaveLength(2)
    expect(view.getAllByText('a.ts').length).toBeGreaterThanOrEqual(2)
    expect(view.getAllByText('b.ts').length).toBeGreaterThanOrEqual(1)

    await clickElement(view.getByLabelText('Close tab a.ts Diff'))

    expect(view.queryByLabelText('Close tab a.ts Diff')).toBeNull()
    expect(view.getByLabelText('Close tab a.ts File')).toBeTruthy()
    expect(view.getAllByText('b.ts').length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the file navigator hidden while previewing until explicitly opened', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-preview-focused': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-preview-focused': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [
            {
              path: 'src/app.ts',
              status: 'modified',
              additions: 4,
              deletions: 1,
            },
          ],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-preview-focused': [{
          id: 'diff:src/app.ts',
          path: 'src/app.ts',
          kind: 'diff',
          title: 'app.ts',
          diff: '@@ -1 +1 @@\n-old\n+new',
          state: 'ok',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-preview-focused': 'diff:src/app.ts',
      },
    }))

    const view = await renderPanel('session-preview-focused')

    expect(view.getByTestId('workspace-code').textContent).toContain('+new')
    expect(view.queryByRole('button', { name: 'Changed files' })).toBeNull()
    expect(view.queryByPlaceholderText('Filter files...')).toBeNull()

    await clickElement(view.getByRole('button', { name: 'Show file navigator' }))

    expect(view.queryByRole('button', { name: 'Changed files' })).toBeNull()
    expect(view.getByPlaceholderText('Filter files...')).toBeTruthy()
    expect(view.container.querySelector('[data-workspace-file-path="src/app.ts"]')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Hide file navigator' })).toBeTruthy()
  })

  it('keeps a preview navigator scoped to changed files when the previous view was all files', async () => {
    getMocks().getWorkspaceTreeMock.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: [{ name: 'src', path: 'src', isDirectory: true }],
    })

    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-preview-hidden-tree': {
          isOpen: true,
          activeView: 'all',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-preview-hidden-tree': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [{
            path: 'src/app.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
          }],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-preview-hidden-tree': [{
          id: 'file:src/app.ts',
          path: 'src/app.ts',
          kind: 'file',
          title: 'app.ts',
          content: 'export const ready = true',
          language: 'typescript',
          state: 'ok',
          size: 25,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-preview-hidden-tree': 'file:src/app.ts',
      },
    }))

    const view = await renderPanel('session-preview-hidden-tree')
    await flushReactWork()

    expect(getMocks().getWorkspaceTreeMock).not.toHaveBeenCalled()

    await clickElement(view.getByRole('button', { name: 'Show file navigator' }))
    await flushReactWork()

    expect(getMocks().getWorkspaceTreeMock).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-workspace-file-path="src/app.ts"]')).toBeTruthy()
  })

  it('uses theme tokens for the panel, preview header, and code surface in dark mode', async () => {
    await setSettingsState({ ...settingsInitialState, locale: 'en', theme: 'dark' })
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-dark-theme': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-dark-theme': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-dark-theme': [{
          id: 'file:src/theme.ts',
          path: 'src/theme.ts',
          kind: 'file',
          title: 'theme.ts',
          language: 'typescript',
          content: 'export const theme = "dark"',
          state: 'ok',
          size: 27,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-dark-theme': 'file:src/theme.ts',
      },
    }))

    const view = await renderPanel('session-dark-theme')
    const panel = view.getByTestId('workspace-panel')
    const previewHeader = view.getByTestId('workspace-preview-header')
    const codeSurface = view.getByTestId('workspace-code')

    expect(panel.className).toContain('bg-[var(--color-surface)]')
    expect(panel.className).not.toContain('bg-white')
    expect(view.queryByRole('tablist', { name: 'Preview tabs' })).toBeNull()
    expect(previewHeader.className).toContain('bg-[var(--color-surface)]')
    expect(previewHeader.className).not.toContain('bg-white')
    const addToChatLabel = Array.from(previewHeader.querySelectorAll('span'))
      .find((element) => element.textContent === 'Add to chat')
    expect(addToChatLabel?.className).toContain('hidden min-[960px]:inline')
    expect(classNameContains(codeSurface, 'bg-[var(--color-code-bg)]')).toBe(true)
    expect(classNameContains(codeSurface, 'bg-white')).toBe(false)
  })

  it('can expand long diff previews beyond the default rendered line cap', async () => {
    const longDiff = Array.from({ length: 2300 }, (_, index) => `+line ${index + 1}`).join('\n')

    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-large-preview': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-large-preview': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-large-preview': [{
          id: 'diff:large.ts',
          path: 'large.ts',
          kind: 'diff',
          title: 'large.ts',
          diff: longDiff,
          state: 'ok',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-large-preview': 'diff:large.ts',
      },
    }))

    const view = await renderPanel('session-large-preview')
    const highlightedCode = view.getByTestId('workspace-code').textContent ?? ''

    expect(highlightedCode).toContain('+line 1')
    expect(highlightedCode).toContain('+line 1999')
    expect(highlightedCode).toContain('+line 2000')
    expect(highlightedCode).not.toContain('+line 2001')
    await clickElement(view.getByRole('button', { name: 'Show all loaded lines' }))

    await waitFor(() => {
      expect(view.getByTestId('workspace-code').textContent).toContain('+line 2001')
      expect(view.getByTestId('workspace-code').textContent).toContain('+line 2300')
    })
    expect(view.getByRole('button', { name: 'Collapse preview' })).toBeTruthy()
  })

  it('keeps diff rows intrinsically wide so H5 users can scroll sideways', async () => {
    const longDiffLine = '+const label = "this is a very long generated line that should not be compressed into the phone viewport";'

    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-wide-diff': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-wide-diff': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-wide-diff': [{
          id: 'diff:wide.ts',
          path: 'wide.ts',
          kind: 'diff',
          title: 'wide.ts',
          diff: longDiffLine,
          state: 'ok',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-wide-diff': 'diff:wide.ts',
      },
    }))

    const view = await renderPanel('session-wide-diff')
    const diffSurface = view.getByTestId('workspace-code')
    const firstRow = diffSurface.querySelector('[data-diff-row-id]')

    expect(firstRow?.className).toContain('w-max')
    expect(firstRow?.className).toContain('min-w-full')
    expect((firstRow as HTMLElement | null)?.style.gridTemplateColumns).toBe(
      'var(--workspace-diff-gutter-width) minmax(max-content, 1fr)',
    )
    expect(firstRow?.querySelector('[data-diff-number-gutter]')).toBeTruthy()
    expect(diffSurface.textContent).toContain(longDiffLine)
  })

  it('can expand long file previews beyond the default rendered line cap', async () => {
    const longFile = Array.from({ length: 2300 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n')

    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-large-file-preview': {
          isOpen: true,
          activeView: 'all',
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-large-file-preview': [{
          id: 'file:large-file.ts',
          path: 'large-file.ts',
          kind: 'file',
          title: 'large-file.ts',
          content: longFile,
          language: 'typescript',
          previewType: 'text',
          state: 'ok',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-large-file-preview': 'file:large-file.ts',
      },
    }))

    const view = await renderPanel('session-large-file-preview')
    const highlightedCode = view.getByTestId('workspace-code').textContent ?? ''

    expect(highlightedCode).toContain('const line1 = 1')
    expect(highlightedCode).toContain('const line2000 = 2000')
    expect(highlightedCode).not.toContain('const line2001 = 2001')
    await clickElement(view.getByRole('button', { name: 'Show all loaded lines' }))

    await waitFor(() => {
      expect(view.getByTestId('workspace-code').textContent).toContain('const line2300 = 2300')
    })
    expect(view.getByRole('button', { name: 'Collapse preview' })).toBeTruthy()
  }, 20_000)

  it('renders image previews from workspace files', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-image-preview': {
          isOpen: true,
          activeView: 'all',
        },
      },
      treeBySessionPath: {
        ...state.treeBySessionPath,
        'session-image-preview': {
          '': {
            state: 'ok',
            path: '',
            entries: [{ name: 'logo.png', path: 'logo.png', isDirectory: false }],
          },
        },
      },
    }))

    getMocks().getWorkspaceFileMock.mockResolvedValue({
      state: 'ok',
      path: 'logo.png',
      previewType: 'image',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mimeType: 'image/png',
      language: 'image',
      size: 8,
    })

    const view = await renderPanel('session-image-preview')

    await clickElement(await view.findByText('logo.png'))

    const image = await view.findByRole('img', { name: 'logo.png' })
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('renders markdown file previews as formatted documents', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-markdown-preview': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-markdown-preview': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-markdown-preview': [{
          id: 'file:README.md',
          path: 'README.md',
          kind: 'file',
          title: 'README.md',
          language: 'markdown',
          content: '# Project Notes\n\n- **Done** item\n\n```ts\nexport const ok = true\n```',
          state: 'ok',
          size: 70,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-markdown-preview': 'file:README.md',
      },
    }))

    const view = await renderPanel('session-markdown-preview')

    expect(view.getByRole('heading', { name: 'Project Notes', level: 1 })).toBeTruthy()
    expect(view.getByText('Done')).toBeTruthy()
    expect(view.container.textContent).toContain('export const ok = true')
    expect(view.queryByTestId('workspace-code')).toBeNull()
  })

  it('renders Mermaid diagrams in markdown file previews when labels contain HTML breaks and braces', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-markdown-mermaid-preview': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-markdown-mermaid-preview': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-markdown-mermaid-preview': [{
          id: 'file:architecture.md',
          path: 'architecture.md',
          kind: 'file',
          title: 'architecture.md',
          language: 'markdown',
          content: [
            '# Architecture',
            '',
            '```mermaid',
            'graph LR',
            '    subgraph "Yjs CRDT 核心"',
            '        Y[Yjs Document]',
            '        A[嵌入类型<br/>Text / Map / Array]',
            '        I[插入操作<br/>{content, position, clock, clientID}]',
            '        D[删除操作<br/>{position, length, clock, clientID}]',
            '        RM[Room Manager<br/>map[string]*Room]',
            '    end',
            '    I --> Y',
            '    D --> Y',
            '    RM --> Y',
            '```',
          ].join('\n'),
          state: 'ok',
          size: 256,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-markdown-mermaid-preview': 'file:architecture.md',
      },
    }))

    const view = await renderPanel('session-markdown-mermaid-preview')

    const surface = await view.findByTestId('mermaid-diagram-surface')
    expect(surface.textContent).toContain('插入操作')
    expect(surface.textContent).toContain('{content, position, clock, clientID}')
    expect(surface.textContent).toContain('map[string]*Room')
    expect(view.queryByText('Mermaid Error')).toBeNull()
    expect(view.queryByTestId('workspace-code')).toBeNull()
  })

  it('opens a context menu for preview tabs and closes tabs to the right', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-preview-menu': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-preview-menu': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-preview-menu': [
          {
            id: 'file:src/App.jsx',
            path: 'src/App.jsx',
            kind: 'file',
            title: 'App.jsx',
            language: 'jsx',
            content: 'app',
            state: 'ok',
            size: 3,
          },
          {
            id: 'diff:vite.config.js',
            path: 'vite.config.js',
            kind: 'diff',
            title: 'vite.config.js',
            diff: '@@ -1 +1 @@',
            state: 'ok',
            size: 12,
          },
          {
            id: 'file:src/index.css',
            path: 'src/index.css',
            kind: 'file',
            title: 'index.css',
            language: 'css',
            content: 'body{}',
            state: 'ok',
            size: 6,
          },
        ],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-preview-menu': 'diff:vite.config.js',
      },
    }))

    const view = await renderPanel('session-preview-menu')

    await act(() => {
      fireEvent.contextMenu(view.getByRole('tab', { name: /vite\.config\.js/i }), {
        clientX: 320,
        clientY: 42,
      })
    })

    await clickElement(view.getByRole('menuitem', { name: 'Close to the Right' }))

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-menu']).toMatchObject([
      { id: 'file:src/App.jsx' },
      { id: 'diff:vite.config.js' },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-menu']).toBe('diff:vite.config.js')
    expect(view.queryByRole('tab', { name: /index\.css/i })).toBeNull()
  })

  it('adds a workspace file to the chat context from the file tree menu', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-add-file': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-add-file': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      treeBySessionPath: {
        ...state.treeBySessionPath,
        'session-add-file': {
          '': {
            state: 'ok',
            path: '',
            entries: [{ name: 'App.tsx', path: 'src/App.tsx', isDirectory: false }],
          },
        },
      },
    }))

    const view = await renderPanel('session-add-file')

    await act(() => {
      fireEvent.contextMenu(view.getByRole('button', { name: /App\.tsx/i }), {
        clientX: 260,
        clientY: 80,
      })
    })

    await clickElement(view.getByRole('menuitem', { name: 'Add to chat' }))

    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-add-file']).toMatchObject([
      {
        kind: 'file',
        path: 'src/App.tsx',
        absolutePath: '/repo/src/App.tsx',
        name: 'App.tsx',
      },
    ])
  })

  it('adds a workspace directory to the chat context from the file tree menu', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-add-directory': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-add-directory': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      treeBySessionPath: {
        ...state.treeBySessionPath,
        'session-add-directory': {
          '': {
            state: 'ok',
            path: '',
            entries: [{ name: 'src', path: 'src', isDirectory: true }],
          },
        },
      },
    }))

    const view = await renderPanel('session-add-directory')

    await act(() => {
      fireEvent.contextMenu(view.getByRole('button', { name: /src/i }), {
        clientX: 260,
        clientY: 80,
      })
    })

    await clickElement(view.getByRole('menuitem', { name: 'Add to chat' }))

    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-add-directory']).toMatchObject([
      {
        kind: 'file',
        path: 'src',
        absolutePath: '/repo/src',
        name: 'src/',
        isDirectory: true,
      },
    ])
  })

  it('does not show duplicate inline citation actions in the file tree menu', async () => {
    useChatStore.setState({
      sessions: {
        'session-cite-file': {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-cite-file': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-cite-file': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      treeBySessionPath: {
        ...state.treeBySessionPath,
        'session-cite-file': {
          '': {
            state: 'ok',
            path: '',
            entries: [{ name: 'App.tsx', path: 'src/App.tsx', isDirectory: false }],
          },
        },
      },
    }))

    const view = await renderPanel('session-cite-file')

    await act(() => {
      fireEvent.contextMenu(view.getByRole('button', { name: /App\.tsx/i }), {
        clientX: 260,
        clientY: 80,
      })
    })

    expect(view.queryByRole('menuitem', { name: 'Cite in message' })).toBeNull()
  })

  it('copies relative and absolute file paths from the file tree menu with the legacy clipboard fallback', async () => {
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })
    const execCommand = vi.mocked(document.execCommand)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('clipboard blocked')),
      },
    })
    const writeText = vi.mocked(navigator.clipboard.writeText)

    try {
      await setWorkspaceState((state) => ({
        ...state,
        panelBySession: {
          ...state.panelBySession,
          'session-copy-file': {
            isOpen: true,
            activeView: 'all',
          },
        },
        statusBySession: {
          ...state.statusBySession,
          'session-copy-file': {
            state: 'ok',
            workDir: '/repo',
            repoName: 'repo',
            branch: 'main',
            isGitRepo: true,
            changedFiles: [],
          },
        },
        treeBySessionPath: {
          ...state.treeBySessionPath,
          'session-copy-file': {
            '': {
              state: 'ok',
              path: '',
              entries: [{ name: 'App.tsx', path: 'src/App.tsx', isDirectory: false }],
            },
          },
        },
      }))

      const view = await renderPanel('session-copy-file')

      await act(() => {
        fireEvent.contextMenu(view.getByRole('button', { name: /App\.tsx/i }), {
          clientX: 260,
          clientY: 80,
        })
      })

      await clickElement(view.getByRole('menuitem', { name: 'Copy path' }))

      await waitFor(() => {
        expect(execCommand).toHaveBeenCalledWith('copy')
      })
      expect(writeText).toHaveBeenCalledWith('src/App.tsx')
      expect(useUIStore.getState().toasts[useUIStore.getState().toasts.length - 1]).toMatchObject({
        type: 'success',
        message: 'Path copied.',
      })

      await act(() => {
        fireEvent.contextMenu(view.getByRole('button', { name: /App\.tsx/i }), {
          clientX: 260,
          clientY: 80,
        })
      })

      await clickElement(view.getByRole('menuitem', { name: 'Copy absolute path' }))

      expect(writeText).toHaveBeenLastCalledWith('/repo/src/App.tsx')
    } finally {
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: originalExecCommand,
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it('adds a line comment from a code preview to the chat context', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-line-comment': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-line-comment': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-line-comment': [{
          id: 'file:src/App.tsx',
          path: 'src/App.tsx',
          kind: 'file',
          title: 'App.tsx',
          language: 'tsx',
          content: 'const title = "Todo"\nexport default title',
          state: 'ok',
          size: 42,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-line-comment': 'file:src/App.tsx',
      },
    }))

    const view = await renderPanel('session-line-comment')

    await clickElement(view.getByRole('button', { name: 'Comment line 1' }))
    const textarea = view.getByPlaceholderText('Describe what should change here...')
    await act(() => {
      fireEvent.change(textarea, { target: { value: 'Rename this title' } })
    })
    await clickElement(view.getByRole('button', { name: 'Add comment' }))

    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-line-comment']).toMatchObject([
      {
        kind: 'code-comment',
        path: 'src/App.tsx',
        absolutePath: '/repo/src/App.tsx',
        name: 'App.tsx',
        lineStart: 1,
        lineEnd: 1,
        note: 'Rename this title',
        quote: 'const title = "Todo"',
      },
    ])
  })

  it('adds a side-aware diff comment, keeps the diff open, and focuses the composer', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-diff-comment': {
          isOpen: true,
          activeView: 'changed',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-diff-comment': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-diff-comment': [{
          id: 'diff:src/a.ts',
          path: 'src/a.ts',
          kind: 'diff',
          title: 'a.ts',
          diff: '@@ -10,2 +11,2 @@\n-const result = makeResult()\n-return result\n+const result = buildResult()\n+return result',
          state: 'ok',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-diff-comment': 'diff:src/a.ts',
      },
    }))

    const otherComposerShell = document.createElement('div')
    otherComposerShell.dataset.testid = 'chat-input-shell'
    otherComposerShell.dataset.sessionId = 'another-session'
    otherComposerShell.append(document.createElement('textarea'))
    document.body.append(otherComposerShell)

    const composerShell = document.createElement('div')
    composerShell.dataset.testid = 'chat-input-shell'
    composerShell.dataset.sessionId = 'session-diff-comment'
    const composer = document.createElement('textarea')
    composerShell.append(composer)
    document.body.append(composerShell)

    const view = await renderPanel('session-diff-comment')

    await clickElement(view.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    const editor = view.getByRole('textbox', { name: 'Review comment' })
    await act(() => {
      fireEvent.change(editor, { target: { value: 'Use a shared helper' } })
    })
    await clickElement(view.getByRole('button', { name: 'Submit review comment' }))

    await waitFor(() => expect(document.activeElement).toBe(composer))
    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-diff-comment']).toMatchObject([
      {
        kind: 'code-comment',
        path: 'src/a.ts',
        absolutePath: '/repo/src/a.ts',
        name: 'a.ts',
        lineStart: 11,
        lineEnd: 11,
        diffSide: 'new',
        hunkId: expect.any(String),
        note: 'Use a shared helper',
        quote: 'const result = buildResult()',
      },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-diff-comment']).toBe('diff:src/a.ts')
    expect(view.getByTestId('workspace-code')).toBeTruthy()
    composerShell.remove()
    otherComposerShell.remove()
  })

  it('adds selected code from a preview to the chat context without requiring a note', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-code-selection': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-code-selection': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-code-selection': [{
          id: 'file:src/App.ts',
          path: 'src/App.ts',
          kind: 'file',
          title: 'App.ts',
          language: 'text',
          content: 'const title = "Todo"\nexport default title',
          state: 'ok',
          size: 42,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-code-selection': 'file:src/App.ts',
      },
    }))

    const view = await renderPanel('session-code-selection')

    await selectWorkspaceCodeText(view, 1, 'const title = "Todo"', 2, 'export default title')
    const addButtons = view.getAllByRole('button', { name: 'Add to chat' })
    await clickElement(addButtons[addButtons.length - 1]!)

    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-code-selection']).toMatchObject([
      {
        kind: 'code-selection',
        path: 'src/App.ts',
        absolutePath: '/repo/src/App.ts',
        name: 'App.ts',
        lineStart: 1,
        lineEnd: 2,
        quote: 'const title = "Todo"\nexport default title',
      },
    ])
    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-code-selection']?.[0]?.note).toBeUndefined()
  })

  it('keeps the selected-code action near the preview instead of the file tree', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-selection-position': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-selection-position': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-selection-position': [{
          id: 'file:src/App.ts',
          path: 'src/App.ts',
          kind: 'file',
          title: 'App.ts',
          language: 'text',
          content: 'const title = "Todo"\nexport default title',
          state: 'ok',
          size: 42,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-selection-position': 'file:src/App.ts',
      },
    }))

    const view = await renderPanel('session-selection-position')

    await selectWorkspaceCodeText(view, 1, 'const title = "Todo"', 1, 'const title = "Todo"')
    const addButtons = view.getAllByRole('button', { name: 'Add to chat' })
    const floatingAddButton = addButtons[addButtons.length - 1]!

    expect(floatingAddButton.style.left).toBe('101px')
    expect(floatingAddButton.style.top).toBe('46px')

    fireEvent.keyDown(view.getByTestId('workspace-code').parentElement?.parentElement ?? view.getByTestId('workspace-code'), {
      key: 'Escape',
    })
    await flushReactWork()
    expect(view.queryAllByRole('button', { name: 'Add to chat' })).toHaveLength(1)
  })

  it('dismisses the selected-code action when clicking outside the popover', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-selection-dismiss': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-selection-dismiss': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-selection-dismiss': [{
          id: 'file:src/App.ts',
          path: 'src/App.ts',
          kind: 'file',
          title: 'App.ts',
          language: 'text',
          content: 'const title = "Todo"\nexport default title',
          state: 'ok',
          size: 42,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-selection-dismiss': 'file:src/App.ts',
      },
    }))

    const view = await renderPanel('session-selection-dismiss')

    await selectWorkspaceCodeText(view, 1, 'const title = "Todo"', 1, 'const title = "Todo"')
    expect(view.getAllByRole('button', { name: 'Add to chat' })).toHaveLength(2)

    await act(async () => {
      fireEvent.pointerDown(document.body)
      await Promise.resolve()
    })
    await flushReactWork()

    expect(view.queryAllByRole('button', { name: 'Add to chat' })).toHaveLength(1)
    expect(window.getSelection()?.toString()).toBe('')
  })

  it('adds selected markdown text from a preview to the chat context', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-markdown-selection': {
          isOpen: true,
          activeView: 'all',
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-markdown-selection': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-markdown-selection': [{
          id: 'file:docs/guide.md',
          path: 'docs/guide.md',
          kind: 'file',
          title: 'guide.md',
          language: 'markdown',
          content: '# Guide\nAlpha note and Beta note',
          state: 'ok',
          size: 33,
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-markdown-selection': 'file:docs/guide.md',
      },
    }))

    const view = await renderPanel('session-markdown-selection')
    const paragraph = view.getByText('Alpha note and Beta note')
    const markdownSurface = paragraph.closest('.min-h-0') ?? paragraph

    await selectRenderedText(paragraph, 'Alpha note and Beta note', markdownSurface)
    const addButtons = view.getAllByRole('button', { name: 'Add to chat' })
    const floatingAddButton = addButtons[addButtons.length - 1]!
    await clickElement(floatingAddButton)

    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-markdown-selection']).toMatchObject([
      {
        kind: 'code-selection',
        path: 'docs/guide.md',
        absolutePath: '/repo/docs/guide.md',
        name: 'guide.md',
        lineStart: 2,
        lineEnd: 2,
        quote: 'Alpha note and Beta note',
      },
    ])
  })

  it('uses the localized view menu label', async () => {
    await setSettingsState({ ...settingsInitialState, locale: 'zh' })
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-zh': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-zh': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
    }))

    const view = await renderPanel('session-zh')

    expect(view.getByRole('button', { name: '已更改文件' })).toBeTruthy()
  })

  it('keeps the workspace header controls compact', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-compact-header': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-compact-header': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
    }))

    const view = await renderPanel('session-compact-header')
    const viewMenuButton = view.getByRole('button', { name: 'Changed files' })
    const refreshButton = view.getByRole('button', { name: 'Refresh workspace' })
    const closeButton = view.getByRole('button', { name: 'Close workspace panel' })

    expect(viewMenuButton.className).toContain('text-[14px]')
    expect(viewMenuButton.className).not.toContain('text-[18px]')
    expect(viewMenuButton.querySelector('.material-symbols-outlined')?.className).toContain('text-[15px]')
    expect(refreshButton.className).toContain('h-8 w-8')
    expect(closeButton.className).toContain('h-8 w-8')
    expect(refreshButton.querySelector('.lucide-refresh-cw')).toBeTruthy()
    expect(closeButton.querySelector('.lucide-x')).toBeTruthy()
  })

  it('shows explicit empty and error states in the changed view', async () => {
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-empty': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      statusBySession: {
        ...state.statusBySession,
        'session-empty': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
    }))

    const view = await renderPanel('session-empty')

    expect(view.getByText('No changes')).toBeTruthy()

    getMocks().getWorkspaceStatusMock.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'session-error') {
        throw new Error('status failed')
      }
      return useWorkspacePanelStore.getState().statusBySession[sessionId] ?? {
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      }
    })

    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-error': {
          isOpen: true,
          activeView: 'changed',
          hasUserSelectedView: true,
        },
      },
      errors: {
        ...state.errors,
        statusBySession: {
          ...state.errors.statusBySession,
          'session-error': 'status failed',
        },
      },
    }))

    await act(async () => {
      view.rerender(<WorkspacePanel sessionId="session-error" />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(view.getByText('status failed')).toBeTruthy()
    })
  })

  it('keeps a loaded diff visible and marks the preview busy while it refreshes', async () => {
    const refresh = deferred<{ state: 'ok'; path: string; diff: string }>()
    getMocks().getWorkspaceDiffMock.mockReturnValue(refresh.promise)
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-preview-refresh': { isOpen: true, activeView: 'changed' },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-preview-refresh': [{
          id: 'diff:src/a.ts',
          path: 'src/a.ts',
          kind: 'diff',
          title: 'a.ts',
          state: 'ok',
          diff: '@@ -1 +1 @@\n-old\n+cached',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-preview-refresh': 'diff:src/a.ts',
      },
    }))

    const view = await renderPanel('session-preview-refresh')
    expect(view.getByText('cached')).toBeTruthy()

    await clickElement(view.getByRole('button', { name: 'Refresh workspace' }))

    expect(view.getByText('cached')).toBeTruthy()
    expect(view.getByTestId('workspace-preview-content').getAttribute('aria-busy')).toBe('true')

    refresh.resolve({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@\n-old\n+latest',
    })
    await flushReactWork()

    expect(view.getByText('latest')).toBeTruthy()
    expect(view.queryByText('cached')).toBeNull()
    expect(view.getByTestId('workspace-preview-content').getAttribute('aria-busy')).toBe('false')
  })

  it('localizes an initial missing preview without describing it as a refresh failure', async () => {
    await setSettingsState({ ...settingsInitialState, locale: 'zh' })
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-initial-missing-zh': { isOpen: true, activeView: 'changed' },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-initial-missing-zh': [{
          id: 'diff:src/missing.ts',
          path: 'src/missing.ts',
          kind: 'diff',
          title: 'missing.ts',
          state: 'missing',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-initial-missing-zh': 'diff:src/missing.ts',
      },
    }))

    const view = await renderPanel('session-initial-missing-zh')

    expect(view.getByText('文件不存在。')).toBeTruthy()
    expect(view.queryByText(/refresh/i)).toBeNull()
    expect(view.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('localizes stale diff state and completes retry after a non-ok refresh omits an error', async () => {
    const refresh = deferred<{ state: 'missing'; path: string }>()
    const retry = deferred<{ state: 'ok'; path: string; diff: string }>()
    getMocks().getWorkspaceDiffMock
      .mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(retry.promise)
    await setSettingsState({ ...settingsInitialState, locale: 'zh' })
    await setWorkspaceState((state) => ({
      ...state,
      panelBySession: {
        ...state.panelBySession,
        'session-preview-refresh-error': { isOpen: true, activeView: 'changed' },
      },
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-preview-refresh-error': [{
          id: 'diff:src/a.ts',
          path: 'src/a.ts',
          kind: 'diff',
          title: 'a.ts',
          state: 'ok',
          diff: '@@ -1 +1 @@\n-old\n+cached',
        }],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-preview-refresh-error': 'diff:src/a.ts',
      },
    }))

    const view = await renderPanel('session-preview-refresh-error')
    await clickElement(view.getByRole('button', { name: '刷新工作区' }))
    refresh.resolve({ state: 'missing', path: 'src/a.ts' })
    await flushReactWork()

    expect(view.getByText('cached')).toBeTruthy()
    expect(view.getByRole('alert').textContent).toContain('文件不存在。')
    expect(view.getByRole('alert').textContent).not.toMatch(/refresh/i)
    await clickElement(view.getByRole('button', { name: '重试' }))

    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByText('cached')).toBeTruthy()
    expect(view.getByTestId('workspace-preview-content').getAttribute('aria-busy')).toBe('true')

    retry.resolve({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@\n-old\n+recovered',
    })
    await flushReactWork()

    expect(view.getByText('recovered')).toBeTruthy()
    expect(view.queryByText('cached')).toBeNull()
    expect(view.getByTestId('workspace-preview-content').getAttribute('aria-busy')).toBe('false')
  })
})
