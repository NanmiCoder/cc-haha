import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
})

const { bridge } = vi.hoisted(() => ({
  bridge: { open: vi.fn(), navigate: vi.fn(), setBounds: vi.fn(), setVisible: vi.fn(), close: vi.fn(), message: vi.fn() },
}))
vi.mock('../../lib/previewBridge', () => ({ previewBridge: bridge }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

import { BrowserSurface } from './BrowserSurface'
import { getDefaultBaseUrl, setBaseUrl } from '../../api/client'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useOverlayStore } from '../../stores/overlayStore'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.values(bridge).forEach((f) => f.mockReset())
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  // browserPanelStore.open() now also opens the unified workbench; keep it isolated.
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useOverlayStore.setState(useOverlayStore.getInitialState(), true)
  setBaseUrl(getDefaultBaseUrl())
})

describe('BrowserSurface', () => {
  it('opens the preview at the session url on mount when surface is open', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    expect(bridge.open).toHaveBeenCalledWith('http://localhost:5173/', expect.objectContaining({ width: expect.any(Number) }))
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

  it('first navigation from a blank session opens the native preview', () => {
    useBrowserPanelStore.getState().ensureBlank('s1')
    render(<BrowserSurface sessionId="s1" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'localhost:3000' } })
    fireEvent.submit(input.closest('form')!)
    expect(bridge.open).toHaveBeenCalledWith('http://localhost:3000', expect.objectContaining({ width: expect.any(Number) }))
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

  it('navigating via address bar calls store + bridge', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'http://localhost:3000/' } })
    fireEvent.submit(input.closest('form')!)
    expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:3000/')
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe('http://localhost:3000/')
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

  it('选择元素 button toggles pickerActive and signals the bridge', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('选择元素'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(true)
    expect(bridge.message).toHaveBeenCalledWith({ v: 1, type: 'enter-picker' })
    fireEvent.click(screen.getByLabelText('选择元素'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
    expect(bridge.message).toHaveBeenLastCalledWith({ v: 1, type: 'exit-picker' })
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

  it('reload flips the session back into loading and shows the indicator', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setReady('s1')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.queryByTestId('browser-loading-bar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('刷新'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
    expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:5173/')
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
})
