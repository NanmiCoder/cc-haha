import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
})

const { host, isAvailable, releaseTab, openExternal, openPath } = vi.hoisted(() => {
  const resolved = () => vi.fn().mockResolvedValue({ ok: true })
  return {
    host: {
      create: resolved(),
      navigate: resolved(),
      goBack: resolved(),
      goForward: resolved(),
      reload: resolved(),
      stop: resolved(),
      setBounds: resolved(),
      setVisible: resolved(),
      setZoom: resolved(),
      find: resolved(),
      stopFind: resolved(),
      capture: resolved(),
      snapshot: vi.fn().mockResolvedValue('data:image/png;base64,BACKDROP'),
      message: resolved(),
      close: resolved(),
      printToPdf: resolved(),
      showMenu: vi.fn().mockResolvedValue(null),
    },
    isAvailable: vi.fn(() => true),
    releaseTab: vi.fn(),
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('../../lib/workspace/browserHost', () => ({
  workspaceBrowserHost: host,
  isWorkspaceBrowserAvailable: isAvailable,
  releaseWorkspaceBrowserTab: releaseTab,
  subscribeWorkspaceBrowserEvents: vi.fn(async () => () => {}),
}))

vi.mock('../../lib/desktopHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktopHost')>()
  return {
    ...actual,
    getDesktopHost: () => {
      const real = actual.getDesktopHost()
      return { ...real, shell: { ...real.shell, open: openExternal, openPath } }
    },
  }
})

import { WorkspaceBrowserTab } from './WorkspaceBrowserTab'
import { useOverlayStore } from '../../stores/overlayStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspaceBrowserStore } from '../../stores/workspaceBrowserStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useChatStore } from '@/stores/chatStore'
import { usePreviewSelectionStore } from '@/stores/previewSelectionStore'
import { handleBrowserSelectionEvent } from '@/lib/workspace/browserSelections'
import type { WorkspaceBrowserDownload, WorkspaceBrowserEvent, WorkspaceBrowserMenuAction } from '../../lib/desktopHost/types'
import type { WorkspaceBrowserTab as WorkspaceBrowserTabModel } from '../../lib/workspace/types'

const SESSION = 'session-a'

/**
 * Tabs come from the real controller rather than a literal, so the identities
 * the component hands to the host (`browserTabId`, `storageId`) are the ones
 * the controller actually mints, and writes back through `updateBrowserTab`
 * land where the controller would read them.
 */
function openBrowserTab(url: string | null = 'https://example.test/') {
  const tabId = useWorkspaceStore
    .getState()
    .openTarget(SESSION, { kind: 'browser', ...(url ? { url } : {}) })!
  return currentTab(tabId)
}

function currentTab(tabId: string) {
  return useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceBrowserTabModel
}

function emit(event: WorkspaceBrowserEvent) {
  act(() => { useWorkspaceBrowserStore.getState().applyEvent(event) })
}

function pageState(tabId: string, overrides: Partial<{
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}> = {}): WorkspaceBrowserEvent {
  return {
    type: 'state',
    tabId,
    url: overrides.url ?? 'https://example.test/',
    title: overrides.title ?? 'Example',
    canGoBack: overrides.canGoBack ?? false,
    canGoForward: overrides.canGoForward ?? false,
    loading: overrides.loading ?? false,
  }
}

function download(overrides: Partial<WorkspaceBrowserDownload> = {}): WorkspaceBrowserDownload {
  return {
    id: 'dl-1',
    filename: 'report.pdf',
    savePath: '/tmp/report.pdf',
    receivedBytes: 1024,
    totalBytes: 1024,
    state: 'completed',
    ...overrides,
  }
}

async function openMenuItem(action: WorkspaceBrowserMenuAction) {
  host.showMenu.mockResolvedValueOnce(action)
  await act(async () => { fireEvent.click(screen.getByTestId('workspace-browser-menu-trigger')) })
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en', uiZoom: 1 })
  useWorkspaceStore.setState({ bySession: {}, sideWidth: 860, bottomHeight: 420 })
  useWorkspaceBrowserStore.setState({ pageByTabId: {}, historyByTabId: {}, downloads: [] })
  useOverlayStore.setState({ count: 0, snapshotCount: 0 })
  usePreviewSelectionStore.setState({ bySession: {} })
  isAvailable.mockReturnValue(true)
  for (const mock of Object.values(host)) mock.mockReset().mockResolvedValue({ ok: true })
  host.snapshot.mockResolvedValue('data:image/png;base64,BACKDROP')
  host.showMenu.mockResolvedValue(null)
  releaseTab.mockClear()
  openExternal.mockClear()
  openPath.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function deferredCreate() {
  let resolve!: (result: { ok: true }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ ok: true }>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('lifecycle readiness', () => {
  it('focuses a newly created empty address bar once its native page is ready', async () => {
    const tab = openBrowserTab(null)
    const create = deferredCreate()
    host.create.mockReturnValueOnce(create.promise)
    render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const address = screen.getByTestId('workspace-browser-address')
    expect(address).toBeDisabled()
    await act(async () => { create.resolve({ ok: true }) })
    expect(address).toBeEnabled()
    expect(address).toHaveFocus()
  })

  it('does not steal focus if the user has moved to chat while an empty browser is registering', async () => {
    const tab = openBrowserTab(null)
    const create = deferredCreate()
    host.create.mockReturnValueOnce(create.promise)
    render(<><input aria-label="Chat composer" /><WorkspaceBrowserTab sessionId={SESSION} tab={tab} active /></>)
    const composer = screen.getByRole('textbox', { name: 'Chat composer' })
    act(() => { composer.focus() })
    await act(async () => { create.resolve({ ok: true }) })
    expect(composer).toHaveFocus()
  })

  it('does not focus an existing loaded page address bar when snapshots open and close', async () => {
    const tab = openBrowserTab()
    await renderReady(<><input aria-label="Chat composer" /><WorkspaceBrowserTab sessionId={SESSION} tab={tab} active /></>)
    const composer = screen.getByRole('textbox', { name: 'Chat composer' })
    act(() => { composer.focus() })
    await act(async () => { useOverlayStore.getState().push(true) })
    act(() => { useOverlayStore.getState().pop(true) })
    expect(composer).toHaveFocus()
  })

  it('waits for registration before bounds, visibility or user commands', async () => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const tab = openBrowserTab()
    render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(host.setBounds).not.toHaveBeenCalled()
    expect(host.setVisible).not.toHaveBeenCalled()
    expect(host.reload).not.toHaveBeenCalled()

    await act(async () => creation.resolve({ ok: true }))
    expect(host.setBounds).toHaveBeenCalledWith(tab.browserTabId, expect.any(Object))
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
  })

  it('uses registered state before a slow initial navigation finishes', async () => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const tab = openBrowserTab()
    render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    expect(host.setVisible).not.toHaveBeenCalled()
    emit(pageState(tab.browserTabId, { loading: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop loading' }))
    expect(host.stop).toHaveBeenCalledWith(tab.browserTabId)
    await act(async () => creation.resolve({ ok: true }))
  })

  it('surfaces failed creation and retries create before accepting navigation', async () => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const tab = openBrowserTab()
    const view = render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    await act(async () => creation.reject(new Error('native creation denied')))
    view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={currentTab(tab.id)} active />)
    expect(screen.getByRole('alert')).toHaveTextContent('native creation denied')
    expect(host.setBounds).not.toHaveBeenCalled()
    expect(host.setVisible).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(host.create).toHaveBeenCalledTimes(2))
    expect(host.reload).not.toHaveBeenCalled()
    await act(async () => {})
    const address = screen.getByTestId('workspace-browser-address')
    fireEvent.change(address, { target: { value: 'https://retry.test/' } })
    fireEvent.submit(address.closest('form')!)
    expect(host.navigate).toHaveBeenCalledWith(tab.browserTabId, 'https://retry.test/')
  })

  it.each(['resolve', 'reject'] as const)('drops stale create %s after ownership is gone', async (result) => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const tab = openBrowserTab()
    const view = render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    host.setBounds.mockClear()
    host.setVisible.mockClear()
    act(() => useWorkspaceStore.getState().closeTab(SESSION, tab.id))
    await act(async () => {
      if (result === 'resolve') creation.resolve({ ok: true })
      else creation.reject(new Error('closed while loading'))
    })
    expect(host.setBounds).not.toHaveBeenCalled()
    expect(host.setVisible).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().findBrowserTabOwner(tab.browserTabId)).toBeNull()
    view.unmount()
    expect(host.setVisible).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('ignores old-page create %s after switching to another owned page', async (result) => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const first = openBrowserTab()
    const second = openBrowserTab('https://second.test/')
    const view = render(<WorkspaceBrowserTab sessionId={SESSION} tab={first} active />)
    view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={second} active />)
    await act(async () => {})
    host.setBounds.mockClear()
    host.setVisible.mockClear()
    await act(async () => {
      if (result === 'resolve') creation.resolve({ ok: true })
      else creation.reject(new Error('old page failed'))
    })
    expect(host.setBounds).not.toHaveBeenCalled()
    expect(host.setVisible).not.toHaveBeenCalled()
    expect(currentTab(first.id).loadError).toBeNull()
    expect(currentTab(second.id).loadError).toBeNull()
  })

  it('keeps pending creation hidden after unmount while its tab remains owned', async () => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const tab = openBrowserTab()
    const view = render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    expect(host.create).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({ visible: false }))
    view.unmount()
    await act(async () => creation.resolve({ ok: true }))
    expect(host.setBounds).not.toHaveBeenCalled()
    expect(host.setVisible).not.toHaveBeenCalled()
    expect(host.close).not.toHaveBeenCalled()
  })

  it('does not replay old resize callbacks into the next page identity', async () => {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback) }
      observe() {}
      disconnect() {}
    })
    const first = openBrowserTab()
    const second = openBrowserTab('https://second.test/')
    const view = render(<WorkspaceBrowserTab sessionId={SESSION} tab={first} active />)
    await act(async () => {})
    const oldCallback = callbacks[0]!
    view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={second} active />)
    await act(async () => {})
    host.setBounds.mockClear()
    act(() => oldCallback([], {} as ResizeObserver))
    expect(host.setBounds).not.toHaveBeenCalled()
  })

  it('keeps an initial navigation failure retryable after registration', async () => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const tab = openBrowserTab()
    const view = render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    emit(pageState(tab.browserTabId))
    await act(async () => creation.reject(new Error('ERR_CONNECTION_REFUSED')))
    view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={currentTab(tab.id)} active />)
    expect(screen.getByRole('alert')).toHaveTextContent('ERR_CONNECTION_REFUSED')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(host.reload).toHaveBeenCalledWith(tab.browserTabId, { ignoreCache: true })
    expect(host.create).toHaveBeenCalledTimes(1)
  })

  it('does not replace a completed initial navigation with its late promise rejection', async () => {
    const creation = deferredCreate()
    host.create.mockReturnValueOnce(creation.promise)
    const tab = openBrowserTab()
    render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    emit({ ...pageState(tab.browserTabId), navigationId: 1, navigationOutcome: 'succeeded' } as WorkspaceBrowserEvent)
    await act(async () => creation.reject(new Error('late initial load rejection')))
    expect(currentTab(tab.id).loadError).toBeNull()
  })

  it('does not replace successful navigation B with late rejected navigation A', async () => {
    const navigation = deferredCreate()
    host.navigate.mockReturnValueOnce(navigation.promise)
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const address = screen.getByTestId('workspace-browser-address')
    fireEvent.change(address, { target: { value: 'https://a.test/' } })
    fireEvent.submit(address.closest('form')!)
    emit({ ...pageState(tab.browserTabId), navigationId: 1, navigationOutcome: 'pending' } as WorkspaceBrowserEvent)
    fireEvent.change(address, { target: { value: 'https://b.test/' } })
    fireEvent.submit(address.closest('form')!)
    emit({ ...pageState(tab.browserTabId, { url: 'https://b.test/' }), navigationId: 2, navigationOutcome: 'succeeded' } as WorkspaceBrowserEvent)
    await act(async () => navigation.reject(new Error('late A rejection')))
    expect(currentTab(tab.id).loadError).toBeNull()
  })

  it('reports real navigation and geometry errors for a live page', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    host.navigate.mockRejectedValueOnce(new Error('navigation denied'))
    const address = screen.getByTestId('workspace-browser-address')
    fireEvent.change(address, { target: { value: 'https://denied.test/' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect(currentTab(tab.id).loadError).toBe('navigation denied'))
    host.setBounds.mockRejectedValueOnce(new Error('native geometry failed'))
    act(() => window.dispatchEvent(new Event('resize')))
    await waitFor(() => expect(currentTab(tab.id).loadError).toBe('native geometry failed'))
  })
})

async function renderReady(ui: Parameters<typeof render>[0]) {
  const view = render(ui)
  await act(async () => {})
  return view
}

it('offers element annotation directly beside the address and arms the addressed page', async () => {
  const tab = openBrowserTab()
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  const toolbar = within(screen.getByTestId('workspace-browser-toolbar'))
  fireEvent.click(toolbar.getByRole('button', { name: 'Pick an element' }))
  expect(host.message).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({
    type: 'enter-picker', mode: 'single', label: 1,
  }))
  expect(screen.queryByTestId('workspace-browser-menu')).not.toBeInTheDocument()
  expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
})

it('does not offer annotation against a blank browser page', async () => {
  const tab = openBrowserTab(null)
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  expect(within(screen.getByTestId('workspace-browser-toolbar')).getByRole('button', { name: 'Pick an element' })).toBeDisabled()
})

it('sends an annotated selection from the address toolbar into its owning chat session', async () => {
  const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined)
  const tab = openBrowserTab()
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  fireEvent.click(screen.getByTestId('workspace-browser-annotate'))
  expect(host.message).toHaveBeenLastCalledWith(tab.browserTabId, expect.objectContaining({ type: 'enter-picker' }))
  act(() => handleBrowserSelectionEvent(SESSION, tab.browserTabId, {
    type: 'selection', payload: { pageUrl: 'https://example.test/', delivery: 'send',
      element: { tag: 'h1', selector: '#heading', classes: [] },
      change: { description: 'Tighten this heading' }, screenshot: { dataUrl: 'data:image/png;base64,AAAA' },
    },
  }))
  expect(send).toHaveBeenCalledWith(SESSION, expect.stringContaining('#heading'),
    [expect.objectContaining({ type: 'image', quote: '#heading' })], expect.any(Object))
})

it('configures the native capsule without hiding the page and follows page zoom and app scale', async () => {
  const tab = openBrowserTab()
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  expect(host.message).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({
    type: 'browser-controls', zoomFactor: 1, appZoom: 1,
    copy: expect.objectContaining({ zoomOut: 'Zoom out', zoomIn: 'Zoom in' }),
  }))
  act(() => useSettingsStore.setState({ uiZoom: 1.2 }))
  emit({ ...pageState(tab.browserTabId), zoomFactor: 0.8 } as WorkspaceBrowserEvent)
  expect(host.message).toHaveBeenLastCalledWith(tab.browserTabId, expect.objectContaining({ zoomFactor: 0.8, appZoom: 1.2 }))
  expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
})

it('retains zoom controls across remounts and accepts native zoom changes', async () => {
  const tab = openBrowserTab()
  const first = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  await openMenuItem('zoomIn')
  expect(host.setZoom).toHaveBeenLastCalledWith(tab.browserTabId, 1.1)
  first.unmount()
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  await openMenuItem('zoomOut')
  expect(host.showMenu).toHaveBeenLastCalledWith(tab.browserTabId, expect.objectContaining({ zoomFactor: 1.1 }))
  expect(host.setZoom).toHaveBeenLastCalledWith(tab.browserTabId, 1)
  emit({ ...pageState(tab.browserTabId), zoomFactor: 1.3 } as WorkspaceBrowserEvent)
  await openMenuItem('zoomIn')
  expect(host.setZoom).toHaveBeenLastCalledWith(tab.browserTabId, 1.4)
  await openMenuItem('zoomReset')
  expect(host.setZoom).toHaveBeenLastCalledWith(tab.browserTabId, 1)
})

describe('native toolbar menu', () => {
  it('anchors localized actions to the trigger in CSS coordinates', async () => {
    useSettingsStore.setState({ locale: 'zh', uiZoom: 1.5 })
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const trigger = screen.getByTestId('workspace-browser-menu-trigger')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 750, bottom: 80 } as DOMRect)
    await act(async () => { fireEvent.click(trigger) })
    expect(host.showMenu).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({
      x: 750,
      y: 80,
      canOpenExternal: true,
      labels: expect.objectContaining({ find: '在页面中查找', history: '历史记录' }),
    }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('waits for registration and ignores repeated clicks while a popup is pending', async () => {
    const create = deferredCreate()
    host.create.mockReturnValueOnce(create.promise)
    const tab = openBrowserTab()
    render(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const trigger = screen.getByTestId('workspace-browser-menu-trigger')
    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)
    expect(host.showMenu).not.toHaveBeenCalled()
    await act(async () => { create.resolve({ ok: true }) })
    let dismiss!: (action: null) => void
    host.showMenu.mockReturnValueOnce(new Promise((resolve) => { dismiss = resolve }))
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(host.showMenu).toHaveBeenCalledTimes(1)
    await act(async () => { dismiss(null) })
    await openMenuItem('find')
    expect(screen.getByTestId('workspace-browser-find')).toBeInTheDocument()
  })

  it.each(['unmount', 'inactive', 'reactivate', 'close', 'replace', 'overlay'] as const)(
    'ignores a late menu action after %s', async (transition) => {
      const tab = openBrowserTab()
      const view = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
      let select!: (action: WorkspaceBrowserMenuAction) => void
      host.showMenu.mockReturnValueOnce(new Promise((resolve) => { select = resolve }))
      fireEvent.click(screen.getByTestId('workspace-browser-menu-trigger'))
      if (transition === 'unmount') view.unmount()
      if (transition === 'inactive') view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active={false} />)
      if (transition === 'reactivate') {
        view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active={false} />)
        view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
      }
      if (transition === 'close') act(() => { useWorkspaceStore.getState().closeTab(SESSION, tab.id) })
      if (transition === 'replace') {
        const next = openBrowserTab('https://replacement.test/')
        view.rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={next} active />)
      }
      if (transition === 'overlay') act(() => { useOverlayStore.getState().push() })
      await act(async () => { select('print') })
      expect(host.printToPdf).not.toHaveBeenCalled()
      if (transition === 'replace' || transition === 'reactivate') {
        expect(screen.getByTestId('workspace-browser-menu-trigger')).toHaveAttribute('aria-expanded', 'false')
        await openMenuItem('find')
        expect(screen.getByTestId('workspace-browser-find')).toBeInTheDocument()
      }
    },
  )

  it('shows a popup failure without turning it into a page load failure, and can retry', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    host.showMenu.mockRejectedValueOnce(new Error('Popup unavailable'))
    host.setVisible.mockClear()
    await act(async () => { fireEvent.click(screen.getByTestId('workspace-browser-menu-trigger')) })
    expect(screen.getByRole('alert')).toHaveTextContent('Popup unavailable')
    expect(currentTab(tab.id).loadError).toBeFalsy()
    expect(host.setVisible).not.toHaveBeenCalledWith(tab.browserTabId, false)
    expect(screen.getByTestId('workspace-browser-menu-trigger')).toHaveAttribute('aria-expanded', 'false')
    await openMenuItem('find')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('workspace-browser-find')).toBeInTheDocument()
  })

  it('targets PDF, capture, picker and external actions at the originating tab', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    await openMenuItem('print')
    expect(host.printToPdf).toHaveBeenCalledWith(tab.browserTabId)
    await openMenuItem('capture')
    expect(host.capture).toHaveBeenCalledWith(tab.browserTabId, 'full')
    await openMenuItem('pickElement')
    expect(host.message).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({ type: 'enter-picker' }))
    emit(pageState(tab.browserTabId, { url: 'https://redirected.test/' }))
    await openMenuItem('openExternal')
    expect(openExternal).toHaveBeenCalledWith('https://redirected.test/')
  })

  it('keeps the guest visible if opening the system browser fails', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    openExternal.mockRejectedValueOnce(new Error('External browser unavailable'))
    host.setVisible.mockClear()
    await openMenuItem('openExternal')
    expect(screen.getByRole('alert')).toHaveTextContent('External browser unavailable')
    expect(currentTab(tab.id).loadError).toBeFalsy()
    expect(host.setVisible).not.toHaveBeenCalledWith(tab.browserTabId, false)
  })

  it('uses the latest guest zoom when it changes during the menu', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    let select!: (action: WorkspaceBrowserMenuAction) => void
    host.showMenu.mockReturnValueOnce(new Promise((resolve) => { select = resolve }))
    fireEvent.click(screen.getByTestId('workspace-browser-menu-trigger'))
    emit({ ...pageState(tab.browserTabId), zoomFactor: 1.7 } as WorkspaceBrowserEvent)
    await act(async () => { select('zoomIn') })
    expect(host.setZoom).toHaveBeenLastCalledWith(tab.browserTabId, 1.8)
  })
})

describe('page lifetime', () => {
  it('hides the page when the component unmounts', async () => {
    const tab = openBrowserTab()
    const { unmount } = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    host.setVisible.mockClear()

    unmount()

    // The surface renders only the active tab, so unmount is how a browser tab
    // normally goes off screen. Leaving it attached floats a live page over the
    // file viewer, the launcher, or the conversation.
    expect(host.setVisible).toHaveBeenCalledWith(expect.any(String), false)
  })

  it('keeps the live page visible while its native menu is open and dismissed', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    let dismiss!: (action: null) => void
    host.showMenu.mockReturnValueOnce(new Promise((resolve) => { dismiss = resolve }))
    host.setVisible.mockClear()

    fireEvent.click(screen.getByTestId('workspace-browser-menu-trigger'))

    // The old DOM dropdown explicitly detached the WebContentsView, blanking
    // the entire page. Native menus can cover the live guest without hiding it.
    expect(host.setVisible).not.toHaveBeenCalledWith(tab.browserTabId, false)
    expect(host.showMenu).toHaveBeenCalledWith(tab.browserTabId, expect.any(Object))
    expect(host.snapshot).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-browser-backdrop')).toBeNull()
    expect(screen.getByTestId('workspace-browser-menu-trigger')).toHaveAttribute('aria-expanded', 'true')
    await act(async () => { dismiss(null) })
    expect(screen.getByTestId('workspace-browser-menu-trigger')).toHaveAttribute('aria-expanded', 'false')
    expect(host.setVisible).not.toHaveBeenCalledWith(tab.browserTabId, false)
    expect(host.create).toHaveBeenCalledTimes(1)
    expect(host.reload).not.toHaveBeenCalled()
    expect(host.close).not.toHaveBeenCalled()
  })

  it('does not close the page when the component unmounts', async () => {
    // The single most important guarantee in this file. Hiding the panel,
    // switching tabs and switching tasks all unmount this component; the page
    // belongs to the tab and only `closeTab` may end it. The previous
    // implementation tore the page down in its cleanup, so coming back showed a
    // blank frame and lost every bit of page state.
    const tab = openBrowserTab()
    const { unmount } = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    unmount()

    expect(host.close).not.toHaveBeenCalled()
    expect(releaseTab).not.toHaveBeenCalled()
  })

  it('leaves closing the page to the controller', async () => {
    const tab = openBrowserTab()
    const { unmount } = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    unmount()

    useWorkspaceStore.getState().closeTab(SESSION, tab.id)

    expect(releaseTab).toHaveBeenCalledWith(tab.browserTabId)
  })

  it('creates the page once, carrying the storage identity a restart reopens', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    expect(host.create).toHaveBeenCalledTimes(1)
    expect(host.create).toHaveBeenCalledWith(
      tab.browserTabId,
      expect.objectContaining({ storageId: tab.storageId, url: 'https://example.test/' }),
    )
  })

  it('does not re-issue create when the tab re-renders', async () => {
    // `create` is keyed on the page identity, not on the props object: a title
    // arriving from the host re-renders this component, and a second `create`
    // for a live page would reset it back to its start URL.
    const tab = openBrowserTab()
    const { rerender } = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    emit(pageState(tab.browserTabId, { title: 'Example Domain' }))
    act(() => {
      useWorkspaceStore
        .getState()
        .updateBrowserTab(SESSION, tab.browserTabId, { title: 'Example Domain' })
    })
    rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={currentTab(tab.id)} active />)
    rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={currentTab(tab.id)} active={false} />)

    expect(host.create).toHaveBeenCalledTimes(1)
  })

  it('opens a blank tab without a start URL instead of navigating somewhere', async () => {
    const tab = openBrowserTab(null)
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    expect(host.create).toHaveBeenCalledWith(
      tab.browserTabId,
      expect.not.objectContaining({ url: expect.anything() }),
    )
  })
})

describe('visibility', () => {
  it('captures a presentation backdrop before hiding the native page for a plus menu and restores the same page', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    let finish!: (url: string) => void
    host.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    host.setVisible.mockClear()
    const createCount = host.create.mock.calls.length

    act(() => { useOverlayStore.getState().push(true) })
    expect(host.snapshot).toHaveBeenCalledWith(tab.browserTabId)
    expect(host.setVisible).not.toHaveBeenCalledWith(tab.browserTabId, false)
    await act(async () => { finish('data:image/png;base64,BACKDROP') })
    expect(screen.getByTestId('workspace-browser-backdrop')).toHaveAttribute('src', 'data:image/png;base64,BACKDROP')
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)
    expect(host.capture).not.toHaveBeenCalled()

    act(() => { useOverlayStore.getState().pop(true) })
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
    expect(screen.queryByTestId('workspace-browser-backdrop')).toBeNull()
    expect(host.create).toHaveBeenCalledTimes(createCount)
    expect(host.close).not.toHaveBeenCalled()
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it('does not hide or paint a stale capture after the plus menu has already closed', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    let finish!: (url: string) => void
    host.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    act(() => { useOverlayStore.getState().push(true) })
    act(() => { useOverlayStore.getState().pop(true) })
    host.setVisible.mockClear()
    await act(async () => { finish('data:image/png;base64,STALE') })
    expect(screen.queryByTestId('workspace-browser-backdrop')).toBeNull()
    expect(host.setVisible).not.toHaveBeenCalledWith(tab.browserTabId, false)
  })

  it('keeps menus usable after capture failure without turning it into a page load error', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    host.snapshot.mockRejectedValueOnce(new Error('capture unavailable'))
    await act(async () => { useOverlayStore.getState().push(true) })
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)
    expect(currentTab(tab.id).loadError).toBeFalsy()
    act(() => { useOverlayStore.getState().pop(true) })
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
  })

  it('lets an ordinary modal hide immediately while a snapshot is pending', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    let finish!: (url: string) => void
    host.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    act(() => { useOverlayStore.getState().push(true) })
    act(() => { useOverlayStore.getState().push() })
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)
    await act(async () => { finish('data:image/png;base64,STALE') })
    expect(screen.queryByTestId('workspace-browser-backdrop')).toBeNull()
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)
  })

  it('bounds capture waiting so a stalled native snapshot cannot trap the menu', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    let finish!: (url: string) => void
    host.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    vi.useFakeTimers()
    try {
      act(() => { useOverlayStore.getState().push(true) })
      expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)
      await act(async () => { finish('data:image/png;base64,TOO_LATE') })
      expect(screen.queryByTestId('workspace-browser-backdrop')).toBeNull()
      act(() => { useOverlayStore.getState().pop(true) })
      expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a pending backdrop when the browser tab is deactivated', async () => {
    const tab = openBrowserTab()
    const { rerender } = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    let finish!: (url: string) => void
    host.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    act(() => { useOverlayStore.getState().push(true) })
    rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active={false} />)
    await act(async () => { finish('data:image/png;base64,OTHER_TAB') })
    expect(screen.queryByTestId('workspace-browser-backdrop')).toBeNull()
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)
    expect(host.close).not.toHaveBeenCalled()
  })

  it('clears an already displayed backdrop when the underlying page navigates', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    await act(async () => { useOverlayStore.getState().push(true) })
    expect(screen.getByTestId('workspace-browser-backdrop')).toBeInTheDocument()
    emit({ type: 'state', tabId: tab.browserTabId, navigationId: 2, url: 'https://next.example/', title: '', loading: true, canGoBack: false, canGoForward: false })
    expect(screen.queryByTestId('workspace-browser-backdrop')).toBeNull()
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)
  })

  it('attaches the page only while its tab is the active one', async () => {
    const tab = openBrowserTab()
    const { rerender } = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)

    rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active={false} />)
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)

    rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
  })

  it('hides the page while a fullscreen DOM overlay is up', async () => {
    // A native view always paints above the DOM, so an image modal opened over
    // the workspace would otherwise be covered by the page.
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    act(() => { useOverlayStore.getState().push() })
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)

    act(() => { useOverlayStore.getState().pop() })
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
  })

  it('hides the page while its own downloads overlay is open', async () => {
    // Same reason, for the overlays this component draws itself: the downloads
    // and history sheets are DOM, and the page would paint straight over them.
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    await openMenuItem('downloads')
    expect(screen.getByTestId('workspace-browser-panel-downloads')).toBeInTheDocument()
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
  })
})

describe('navigation controls', () => {
  it('keeps back and forward disabled until the host reports real history', async () => {
    // Native history is the source of truth. The previous implementation kept
    // its own array in the renderer, which disagreed with the page after any
    // redirect or in-page navigation.
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()

    emit(pageState(tab.browserTabId, { canGoBack: true }))

    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
  })

  it('asks the host to go back and forward rather than navigating a remembered URL', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    emit(pageState(tab.browserTabId, { canGoBack: true, canGoForward: true }))

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))

    expect(host.goBack).toHaveBeenCalledWith(tab.browserTabId)
    expect(host.goForward).toHaveBeenCalledWith(tab.browserTabId)
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it('turns reload into stop while the page is loading', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(host.reload).toHaveBeenCalledTimes(1)

    emit(pageState(tab.browserTabId, { loading: true }))

    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop loading' }))
    expect(host.stop).toHaveBeenCalledWith(tab.browserTabId)
    expect(host.reload).toHaveBeenCalledTimes(1)
  })

  it('navigates to the address the user typed', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    const address = screen.getByTestId('workspace-browser-address')
    fireEvent.change(address, { target: { value: 'https://other.test/docs' } })
    fireEvent.submit(address.closest('form')!)

    expect(host.navigate).toHaveBeenCalledWith(tab.browserTabId, 'https://other.test/docs')
  })

  it('ignores an empty address instead of navigating to nothing', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    const address = screen.getByTestId('workspace-browser-address')
    fireEvent.change(address, { target: { value: '   ' } })
    fireEvent.submit(address.closest('form')!)

    expect(host.navigate).not.toHaveBeenCalled()
  })
})

describe('load failures', () => {
  it('offers a retry that clears the error and reloads the page', async () => {
    const tab = openBrowserTab()
    act(() => {
      useWorkspaceStore
        .getState()
        .updateBrowserTab(SESSION, tab.browserTabId, { loadError: 'ERR_CONNECTION_REFUSED' })
    })
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={currentTab(tab.id)} active />)

    const error = screen.getByTestId('workspace-browser-error')
    expect(error).toHaveTextContent('ERR_CONNECTION_REFUSED')
    expect(error).toHaveTextContent('https://example.test/')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    // The error is the tab's, so clearing it has to go through the controller —
    // a local `useState` would leave the tab strip showing a failed tab.
    expect(currentTab(tab.id).loadError).toBeNull()
    expect(host.reload).toHaveBeenCalledWith(tab.browserTabId, { ignoreCache: true })
  })

  it('shows the start-browsing hint only while the tab has neither URL nor error', async () => {
    const tab = openBrowserTab(null)
    const { rerender } = await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    expect(screen.getByText('Start browsing')).toBeInTheDocument()

    act(() => {
      useWorkspaceStore
        .getState()
        .updateBrowserTab(SESSION, tab.browserTabId, { loadError: 'ERR_FAILED' })
    })
    rerender(<WorkspaceBrowserTab sessionId={SESSION} tab={currentTab(tab.id)} active />)

    expect(screen.queryByText('Start browsing')).toBeNull()
    expect(screen.getByTestId('workspace-browser-error')).toBeInTheDocument()
  })
})

describe('find in page', () => {
  it('searches as the user types and shows the host match counter', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    await openMenuItem('find')
    const input = screen.getByRole('textbox', { name: 'Find in page' })
    fireEvent.change(input, { target: { value: 'needle' } })

    expect(host.find).toHaveBeenCalledWith(tab.browserTabId, 'needle', {
      findNext: false,
      forward: true,
    })

    emit({ type: 'found', tabId: tab.browserTabId, activeMatchOrdinal: 2, matches: 7 })
    expect(screen.getByTestId('workspace-browser-find')).toHaveTextContent('2/7')
  })

  it('steps to the next match on Enter', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    await openMenuItem('find')
    const input = screen.getByRole('textbox', { name: 'Find in page' })
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(host.find).toHaveBeenLastCalledWith(tab.browserTabId, 'needle', {
      findNext: true,
      forward: true,
    })
  })

  it('stops the search when the query is emptied', async () => {
    // An empty query is not a search for "": leaving the host's find session
    // open keeps the previous matches highlighted on the page.
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    await openMenuItem('find')
    const input = screen.getByRole('textbox', { name: 'Find in page' })
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.change(input, { target: { value: '' } })

    expect(host.stopFind).toHaveBeenCalledWith(tab.browserTabId)
  })

  it('closes the bar and stops the search on Escape', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    await openMenuItem('find')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find in page' }), { key: 'Escape' })

    expect(screen.queryByTestId('workspace-browser-find')).toBeNull()
    expect(host.stopFind).toHaveBeenCalledWith(tab.browserTabId)
  })
})

describe('overlays', () => {
  it('lists downloads with a route to the saved file', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    emit({ type: 'download', tabId: tab.browserTabId, download: download() })

    await openMenuItem('downloads')
    expect(screen.getByText('report.pdf')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open downloaded file' }))
    expect(openPath).toHaveBeenCalledWith('/tmp/report.pdf')
  })

  it('replays a visit from the history overlay through the address pipeline', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    emit(pageState(tab.browserTabId, { url: 'https://visited.test/', title: 'Visited' }))
    emit(pageState(tab.browserTabId, { url: 'https://current.test/', title: 'Current' }))

    await openMenuItem('history')
    fireEvent.click(screen.getByRole('button', { name: /Visited/ }))

    expect(host.navigate).toHaveBeenCalledWith(tab.browserTabId, 'https://visited.test/')
    expect(screen.queryByTestId('workspace-browser-panel-history')).toBeNull()
  })

  it('says so when there is nothing to show rather than rendering an empty sheet', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    await openMenuItem('history')
    expect(screen.getByText('No pages visited yet')).toBeInTheDocument()
  })
})

describe('hosts without a native browser view', () => {
  it('renders the degraded state instead of chrome around an empty frame', async () => {
    // A plain browser or the H5 build has no `webContents`. Drawing the normal
    // toolbar and stage there would show a permanently blank frame that reads
    // as a page which failed to paint — the host calls themselves resolve to a
    // typed `unsupported` failure, so nothing behind this ever succeeds.
    isAvailable.mockReturnValue(false)
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    expect(screen.getByTestId('workspace-browser-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-browser-toolbar')).toBeNull()
    expect(screen.queryByTestId('workspace-browser-stage')).toBeNull()
    expect(screen.queryByTestId('workspace-browser-address')).toBeNull()
  })

  it('hands the URL to the system browser instead', async () => {
    isAvailable.mockReturnValue(false)
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    fireEvent.click(screen.getByRole('button', { name: 'Open in system browser' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.test/')
  })

  it('offers no external route for a blank tab, which has nothing to open', async () => {
    isAvailable.mockReturnValue(false)
    const tab = openBrowserTab(null)
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)

    expect(screen.getByTestId('workspace-browser-unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open in system browser' })).toBeNull()
  })
})


describe('address viewing and editing', () => {
  it('selects the URL on focus, retains edits through page updates, and Escape restores the latest URL', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const address = screen.getByTestId('workspace-browser-address') as HTMLInputElement
    act(() => address.focus())
    expect(address.selectionStart).toBe(0)
    expect(address.selectionEnd).toBe(address.value.length)
    fireEvent.change(address, { target: { value: 'https://draft.test/' } })
    emit(pageState(tab.browserTabId, { url: 'https://redirect.test/' }))
    expect(address).toHaveValue('https://draft.test/')
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address).toHaveValue('https://redirect.test/')
    expect(address).not.toHaveFocus()
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it('opens the edited address externally and reloads a normalized current URL', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const address = screen.getByTestId('workspace-browser-address') as HTMLInputElement
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'draft.test/page' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open in system browser' }))
    expect(openExternal).toHaveBeenCalledWith('https://draft.test/page')
    fireEvent.change(address, { target: { value: 'https://example.test' } })
    fireEvent.submit(address.closest('form')!)
    expect(host.reload).toHaveBeenCalledWith(tab.browserTabId)
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it('discards an unsubmitted draft when focus leaves the address group', async () => {
    const tab = openBrowserTab()
    await renderReady(<><input aria-label="Other field" /><WorkspaceBrowserTab sessionId={SESSION} tab={tab} active /></>)
    const address = screen.getByTestId('workspace-browser-address') as HTMLInputElement
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'unsubmitted.test' } })
    act(() => screen.getByRole('textbox', { name: 'Other field' }).focus())
    expect(address).toHaveValue(tab.url)
  })
})

it('toggles persistent annotation and reflects host state after Escape in the native page', async () => {
  const tab = openBrowserTab()
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  const annotate = screen.getByTestId('workspace-browser-annotate')
  fireEvent.click(annotate)
  expect(host.message).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({ type: 'enter-picker', persistent: true }))
  emit({ ...pageState(tab.browserTabId), annotationActive: true } as WorkspaceBrowserEvent)
  expect(annotate).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(annotate)
  expect(host.message).toHaveBeenLastCalledWith(tab.browserTabId, { v: 1, type: 'exit-picker' })
  emit({ ...pageState(tab.browserTabId), annotationActive: false } as WorkspaceBrowserEvent)
  expect(annotate).toHaveAttribute('aria-pressed', 'false')
})


describe('browser address suggestions', () => {
  function seedVisits() {
    useWorkspaceBrowserStore.setState({ historyByTabId: {
      'history-a': [
        { url: 'https://fixture.test/older', title: 'Old design', visitedAt: 1 },
        { url: 'https://chain.test/', title: 'Chain Sheet', visitedAt: 2 },
        { url: 'https://chatcut.test/editor', title: 'ChatCut editor', visitedAt: 3 },
      ],
      'history-b': [{ url: 'https://chatcut.test/editor', title: 'ChatCut latest', visitedAt: 4 }],
    } })
  }

  it('shows deduplicated recent visits when a new tab address receives focus', async () => {
    seedVisits()
    const tab = openBrowserTab(null)
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveTextContent('ChatCut latest')
    expect(options[1]).toHaveTextContent('Chain Sheet')
    expect(screen.getByTestId('workspace-browser-address')).toHaveAttribute('aria-expanded', 'true')
    expect(useOverlayStore.getState().snapshotCount).toBe(1)
  })

  it('filters by title and URL, starts with search, and uses ArrowDown plus Enter to open a history item', async () => {
    seedVisits()
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const address = screen.getByTestId('workspace-browser-address')
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'ch' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveTextContent('Search the web')
    expect(screen.queryByRole('option', { name: /Old design/ })).toBeNull()
    fireEvent.keyDown(address, { key: 'ArrowDown' })
    expect(address).toHaveAttribute('aria-activedescendant', options[1]!.id)
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(host.navigate).toHaveBeenCalledWith(tab.browserTabId, 'https://chatcut.test/editor')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens a suggestion by pointer without losing the chosen address to blur cancellation', async () => {
    seedVisits()
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    act(() => screen.getByTestId('workspace-browser-address').focus())
    const option = screen.getByRole('option', { name: /Chain Sheet/ })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    expect(host.navigate).toHaveBeenCalledWith(tab.browserTabId, 'https://chain.test/')
    expect(useOverlayStore.getState().count).toBe(0)
  })

  it('submits the search row but lets IME composition finish first', async () => {
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const address = screen.getByTestId('workspace-browser-address')
    act(() => address.focus())
    fireEvent.change(address, { target: { value: '界面设计' } })
    fireEvent.keyDown(address, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(host.navigate).not.toHaveBeenCalled()
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(host.navigate).toHaveBeenCalledWith(tab.browserTabId, 'https://www.google.com/search?q=%E7%95%8C%E9%9D%A2%E8%AE%BE%E8%AE%A1')
  })

  it('keeps the native page behind a presentation snapshot while suggestions are open and restores it on Escape', async () => {
    seedVisits()
    const tab = openBrowserTab()
    await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
    const address = screen.getByTestId('workspace-browser-address')
    act(() => address.focus())
    await waitFor(() => expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, false))
    expect(host.snapshot).toHaveBeenCalledWith(tab.browserTabId)
    fireEvent.change(address, { target: { value: 'unfinished' } })
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address).toHaveValue(tab.url)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(useOverlayStore.getState().count).toBe(0)
    expect(host.setVisible).toHaveBeenLastCalledWith(tab.browserTabId, true)
  })
})

it('keeps the browser toolbar aligned with file content and ignores page-only menu actions in a blank tab', async () => {
  const tab = openBrowserTab(null)
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  expect(screen.getByTestId('workspace-browser-toolbar')).toHaveClass('h-[52px]')
  act(() => screen.getByTestId('workspace-browser-menu-trigger').focus())
  host.message.mockClear()
  for (const action of ['find', 'print', 'capture', 'pickElement'] as const) await openMenuItem(action)
  expect(host.showMenu).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({ hasPage: false, canOpenExternal: false }))
  expect(screen.queryByTestId('workspace-browser-find')).toBeNull()
  expect(host.printToPdf).not.toHaveBeenCalled()
  expect(host.capture).not.toHaveBeenCalled()
  expect(host.message).not.toHaveBeenCalled()
})

it('uses persistent annotation for a native menu selection and the latest annotation state when the popup resolves', async () => {
  const tab = openBrowserTab()
  await renderReady(<WorkspaceBrowserTab sessionId={SESSION} tab={tab} active />)
  await openMenuItem('pickElement')
  expect(host.message).toHaveBeenLastCalledWith(tab.browserTabId, expect.objectContaining({ type: 'enter-picker', persistent: true }))
  let choose!: (action: WorkspaceBrowserMenuAction) => void
  host.showMenu.mockReturnValueOnce(new Promise(resolve => { choose = resolve }))
  fireEvent.click(screen.getByTestId('workspace-browser-menu-trigger'))
  emit({ ...pageState(tab.browserTabId), annotationActive: true } as WorkspaceBrowserEvent)
  await act(async () => { choose('pickElement') })
  expect(host.message).toHaveBeenLastCalledWith(tab.browserTabId, { v: 1, type: 'exit-picker' })
})
