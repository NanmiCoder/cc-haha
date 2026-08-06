import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
})

const { bridge, openExternal, sendMessage } = vi.hoisted(() => ({
  bridge: {
    open: vi.fn(),
    navigate: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setZoom: vi.fn(),
    close: vi.fn(),
    message: vi.fn(),
  },
  openExternal: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
}))
vi.mock('../../lib/previewBridge', () => ({ previewBridge: bridge }))
vi.mock('../../lib/desktopHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktopHost')>()
  return {
    ...actual,
    getDesktopHost: () => {
      const host = actual.getDesktopHost()
      return { ...host, shell: { ...host.shell, open: openExternal } }
    },
  }
})
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ sendMessage }) },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

import { BrowserSurface } from './BrowserSurface'
import { getDefaultBaseUrl, setBaseUrl } from '../../api/client'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useOverlayStore } from '../../stores/overlayStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePreviewSelectionStore } from '../../stores/previewSelectionStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.values(bridge).forEach((f) => f.mockReset())
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  // browserPanelStore.open() now also opens the unified workbench; keep it isolated.
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useOverlayStore.setState(useOverlayStore.getInitialState(), true)
  usePreviewSelectionStore.setState({ bySession: {} })
  useSettingsStore.setState({ uiZoom: 1 })
  openExternal.mockClear()
  sendMessage.mockReset()
  setBaseUrl(getDefaultBaseUrl())
})

describe('BrowserSurface', () => {
  it('opens the preview at the session url on mount when surface is open', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    return waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith('http://localhost:5173/', expect.objectContaining({ width: expect.any(Number) }))
    })
  })

  it('rescales native preview bounds when app zoom changes', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 180,
      top: 150,
      width: 420,
      height: 300,
    } as DOMRect)
    useSettingsStore.setState({ uiZoom: 1.25 })
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)

    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith('http://localhost:5173/', {
        x: 225,
        y: 187.5,
        width: 525,
        height: 375,
      })
    })

    act(() => {
      useSettingsStore.setState({ uiZoom: 1.5 })
    })

    await waitFor(() => {
      expect(bridge.setBounds).toHaveBeenLastCalledWith({
        x: 270,
        y: 225,
        width: 630,
        height: 450,
      })
    })
  })

  it('waits for local preview URLs before opening the native preview', async () => {
    const url = 'http://127.0.0.1:59028/preview-fs/s1/66estmutl_files/index.html'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    useBrowserPanelStore.getState().open('s1', url)
    render(<BrowserSurface sessionId="s1" />)

    expect(within(screen.getByTestId('preview-host')).getByLabelText('加载中')).toBeInTheDocument()
    expect(bridge.open).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(url, expect.objectContaining({
        method: 'HEAD',
        cache: 'no-store',
      }))
    })
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith(url, expect.objectContaining({ width: expect.any(Number) }))
    })

    fetchSpy.mockRestore()
  })

  it('renders an empty address bar without opening a preview for a blank session', () => {
    useBrowserPanelStore.getState().ensureBlank('s1')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('first navigation from a blank session opens the native preview', async () => {
    useBrowserPanelStore.getState().ensureBlank('s1')
    render(<BrowserSurface sessionId="s1" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'localhost:3000' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith('http://localhost:3000', expect.objectContaining({ width: expect.any(Number) }))
    })
    expect(bridge.navigate).not.toHaveBeenCalled()
  })

  it('opens a typed file URL for local html through the local-file preview route', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    setBaseUrl('http://127.0.0.1:8787')
    useBrowserPanelStore.getState().ensureBlank('s1')
    render(<BrowserSurface sessionId="s1" />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'file:///private/tmp/report.html' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/local-file/private/tmp/report.html',
        expect.objectContaining({ width: expect.any(Number) }),
      )
    })
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe(
      'http://127.0.0.1:8787/local-file/private/tmp/report.html',
    )
  })

  it('navigating via address bar calls store + bridge', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'http://localhost:3000/' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => {
      expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:3000/')
    })
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe('http://localhost:3000/')
  })

  it('navigates the mounted native preview when another browser target opens for the same session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    useBrowserPanelStore.getState().open('s1', 'http://127.0.0.1:3456/preview-fs/s1/first.md')
    render(<BrowserSurface sessionId="s1" />)
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith(
        'http://127.0.0.1:3456/preview-fs/s1/first.md',
        expect.objectContaining({ width: expect.any(Number) }),
      )
    })

    act(() => {
      useBrowserPanelStore.getState().open('s1', 'http://127.0.0.1:3456/preview-fs/s1/second.md')
    })

    await waitFor(() => {
      expect(bridge.navigate).toHaveBeenCalledWith('http://127.0.0.1:3456/preview-fs/s1/second.md')
    })
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe(
      'http://127.0.0.1:3456/preview-fs/s1/second.md',
    )
  })

  it('closes the native webview on unmount', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    const { unmount } = render(<BrowserSurface sessionId="s1" />)
    unmount()
    expect(bridge.close).toHaveBeenCalled()
  })

  it('截图 button triggers a structured capture message', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('截图'))
    expect(bridge.message).toHaveBeenCalledWith({ v: 1, type: 'capture', kind: 'full' })
  })

  it('places preview action buttons on the right side of the address toolbar', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setReady('s1')
    render(<BrowserSurface sessionId="s1" />)

    const actions = screen.getByTestId('browser-toolbar-actions')
    expect(actions).toContainElement(screen.getByLabelText('截图'))
    expect(actions).toContainElement(screen.getByLabelText('选择元素'))
    expect(screen.getByRole('textbox').closest('form')!.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens the current preview URL in the system browser', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)

    fireEvent.click(screen.getByLabelText('系统浏览器'))

    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('选择元素 button toggles pickerActive and signals the bridge', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('选择元素'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(true)
    expect(bridge.message).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      type: 'enter-picker',
      mode: 'single',
      label: 1,
    }))
    fireEvent.click(screen.getByLabelText('选择元素'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
    expect(bridge.message).toHaveBeenLastCalledWith({ v: 1, type: 'exit-picker' })
  })

  it('renders floating preview zoom controls that update the native preview zoom', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setReady('s1')
    render(<BrowserSurface sessionId="s1" />)

    const controls = screen.getByTestId('browser-zoom-controls')
    const actions = screen.getByTestId('browser-toolbar-actions')
    const floatingControls = screen.getByTestId('browser-preview-floating-controls')
    expect(controls).toHaveTextContent('100%')
    expect(actions).not.toContainElement(controls)
    expect(floatingControls).toContainElement(controls)
    expect(screen.getByTestId('browser-preview-stage')).toContainElement(floatingControls)
    expect(screen.getByTestId('preview-host').compareDocumentPosition(floatingControls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(screen.getByLabelText('缩小预览'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.zoom).toBe(0.9)
    await waitFor(() => {
      expect(bridge.setZoom).toHaveBeenLastCalledWith(0.9)
    })
    expect(controls).toHaveTextContent('90%')

    fireEvent.click(screen.getByLabelText('重置预览缩放'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.zoom).toBe(1)
    await waitFor(() => {
      expect(bridge.setZoom).toHaveBeenLastCalledWith(1)
    })
  })

  it('applies the session zoom before opening the native preview', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setZoom('s1', 0.8)
    render(<BrowserSurface sessionId="s1" />)

    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalled()
    })
    expect(bridge.setZoom).toHaveBeenCalledWith(0.8)
    expect(bridge.setZoom.mock.invocationCallOrder[0]!).toBeLessThan(
      bridge.open.mock.invocationCallOrder[0]!,
    )
  })

  it('renders the loading indicator while the session is loading (open starts loading)', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.getByTestId('browser-loading-bar')).toBeInTheDocument()
    expect(screen.getByLabelText('刷新')).toHaveAttribute('aria-busy', 'true')
  })

  it('hides the loading indicator once the page is ready', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setReady('s1')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.queryByTestId('browser-loading-bar')).not.toBeInTheDocument()
    expect(screen.getByLabelText('刷新')).toHaveAttribute('aria-busy', 'false')
  })

  it('reload flips the session back into loading and shows the indicator', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setReady('s1')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.queryByTestId('browser-loading-bar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('刷新'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
    await waitFor(() => {
      expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:5173/')
    })
    expect(screen.getByTestId('browser-loading-bar')).toBeInTheDocument()
  })

  it('forces loading off after the timeout fallback elapses', () => {
    vi.useFakeTimers()
    try {
      useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
      render(<BrowserSurface sessionId="s1" />)
      expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
      act(() => {
        vi.advanceTimersByTime(15000)
      })
      expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides the native webview when a fullscreen overlay opens, then re-shows it when the overlay closes', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)

    // Initial mount: visibility-sync effect reveals the webview (count === 0).
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true)

    // Overlay opens → webview must hide.
    act(() => { useOverlayStore.getState().push() })
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)

    // Overlay closes → webview must re-show (panel still mounted in browser mode).
    act(() => { useOverlayStore.getState().pop() })
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('keeps the native webview hidden while multiple overlays stack', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)

    act(() => { useOverlayStore.getState().push() })
    act(() => { useOverlayStore.getState().push() })
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)

    // Popping just one leaves count === 1 → still hidden.
    act(() => { useOverlayStore.getState().pop() })
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)

    // Popping the last one → re-shown.
    act(() => { useOverlayStore.getState().pop() })
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('shows a compact batch rail with stable numbering and undo/clear actions', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    usePreviewSelectionStore.getState().add('s1', {
      pageUrl: 'http://localhost:5173/',
      draftItemId: 'one',
      element: { selector: '#title', tag: 'h1', classes: [] } as never,
    })
    usePreviewSelectionStore.getState().add('s1', {
      pageUrl: 'http://localhost:5173/',
      draftItemId: 'two',
      element: { selector: '#cta', tag: 'button', classes: [] } as never,
    })
    render(<BrowserSurface sessionId="s1" />)

    const rail = screen.getByTestId('browser-selection-draft')
    expect(rail).toHaveTextContent('已选 2 个')
    expect(rail).toHaveTextContent('#2 <button>')

    fireEvent.click(screen.getByLabelText('撤销上一个选择'))
    expect(bridge.message).toHaveBeenCalledWith({ v: 1, type: 'undo-selection', itemId: 'two' })
    await waitFor(() => {
      expect(screen.getByTestId('browser-selection-draft')).toHaveTextContent('#1 <h1>')
    })

    fireEvent.click(screen.getByLabelText('清空选择'))
    await waitFor(() => expect(screen.queryByTestId('browser-selection-draft')).not.toBeInTheDocument())
    expect(bridge.message).toHaveBeenCalledWith({ v: 1, type: 'clear-selection-draft' })
  })

  it('sends all selected screenshots as one numbered chat turn', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    for (const [id, tag, data] of [
      ['one', 'h1', 'data:image/png;base64,AAAA'],
      ['two', 'button', 'data:image/png;base64,BBBB'],
    ] as const) {
      usePreviewSelectionStore.getState().add('s1', {
        pageUrl: 'http://localhost:5173/',
        draftItemId: id,
        element: { selector: `#${id}`, tag, classes: [] } as never,
        change: { description: `${id} note` } as never,
        screenshot: { dataUrl: data, kind: 'region' },
      })
    }
    render(<BrowserSurface sessionId="s1" />)

    fireEvent.click(screen.getByRole('button', { name: '发送 2 个' }))

    expect(sendMessage).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('[元素 2]'),
      [
        expect.objectContaining({ name: '<h1>', selectionNumber: 1, data: 'data:image/png;base64,AAAA' }),
        expect.objectContaining({ name: '<button>', selectionNumber: 2, data: 'data:image/png;base64,BBBB' }),
      ],
      expect.objectContaining({ displayContent: '2 个页面修改' }),
    )
    await waitFor(() => expect(screen.queryByTestId('browser-selection-draft')).not.toBeInTheDocument())
    expect(bridge.message).toHaveBeenCalledWith({ v: 1, type: 'commit-selection-draft' })
  })

  it('protects a selection batch before navigating to another page', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    usePreviewSelectionStore.getState().add('s1', {
      pageUrl: 'http://localhost:5173/',
      draftItemId: 'one',
      element: { selector: '#title', tag: 'h1', classes: [] } as never,
    })
    render(<BrowserSurface sessionId="s1" />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'http://localhost:3000/' } })
    fireEvent.submit(input.closest('form')!)

    expect(screen.getByText('离开本次批量选择？')).toBeInTheDocument()
    expect(bridge.navigate).not.toHaveBeenCalledWith('http://localhost:3000/')
    fireEvent.click(screen.getByRole('button', { name: '丢弃并继续' }))

    await waitFor(() => expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:3000/'))
    expect(bridge.message).toHaveBeenCalledWith({ v: 1, type: 'clear-selection-draft' })
  })
})
