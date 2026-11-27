import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { browserHost } from '@/lib/desktopHost/browserHost'
import {
  ensureWorkspaceBrowserGuest,
  placeWorkspaceBrowserGuest,
  setWorkspaceBrowserGuestLayer,
} from '@/lib/workspace/browserGuests'
import { useBrowserUseStore } from '@/stores/browserUseStore'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  WorkspaceBrowserAgentOverlay,
  computeCursorDurationMs,
  interpolateCursorPosition,
} from './WorkspaceBrowserAgentOverlay'

function mockRect(element: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
  element.getBoundingClientRect = () => ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  }) as DOMRect
}

describe('WorkspaceBrowserAgentOverlay', () => {
  let layer: HTMLDivElement
  let stage: HTMLDivElement
  let reportCursorArrived: ReturnType<typeof vi.fn>
  let sendUserAction: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    useSettingsStore.setState({ locale: 'en' })
    useBrowserUseStore.getState().reset()
    reportCursorArrived = vi.fn().mockResolvedValue(undefined)
    sendUserAction = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      browserUse: {
        ...browserHost.browserUse,
        reportCursorArrived,
        sendUserAction,
      },
    }
    layer = document.createElement('div')
    stage = document.createElement('div')
    document.body.append(layer, stage)
    mockRect(layer, { left: 0, top: 0, width: 1000, height: 800 })
    mockRect(stage, { left: 0, top: 0, width: 800, height: 600 })
    setWorkspaceBrowserGuestLayer(layer)

    const ready = ensureWorkspaceBrowserGuest('tab-agent', async () => {})
    await Promise.resolve()
    const webview = layer.querySelector('webview') as HTMLElement & { getWebContentsId?: () => number }
    webview.getWebContentsId = () => 101
    webview.dispatchEvent(new Event('dom-ready'))
    await ready
  })

  afterEach(() => {
    setWorkspaceBrowserGuestLayer(null)
    document.body.innerHTML = ''
    Reflect.deleteProperty(window, 'desktopHost')
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('portals INSIDE record.slot AFTER <webview>, never inside stageRef', () => {
    placeWorkspaceBrowserGuest('tab-agent', stage, true)
    useBrowserUseStore.getState().applyHostEvent({
      type: 'control-state',
      tabId: 'tab-agent',
      state: 'active',
      actionLabel: 'Click "Submit order"',
    })

    render(<WorkspaceBrowserAgentOverlay tabId="tab-agent" />)

    const slot = layer.querySelector('[data-workspace-browser-slot="tab-agent"]')!
    const overlay = screen.getByTestId('workspace-browser-agent-overlay')
    const webview = slot.querySelector('webview')!
    const overlayHost = slot.querySelector('[data-workspace-browser-overlay="tab-agent"]')!

    expect(slot.contains(overlay)).toBe(true)
    expect(stage.contains(overlay)).toBe(false)
    expect(Array.from(slot.children)).toEqual([webview, overlayHost])
    expect(screen.getByTestId('browser-agent-control-pill')).toHaveTextContent('Click "Submit order"')
  })

  it('intercepts human pointerdown/wheel/Escape on active shield and removes shield on takeover', () => {
    placeWorkspaceBrowserGuest('tab-agent', stage, true)
    useBrowserUseStore.getState().applyHostEvent({
      type: 'control-state',
      tabId: 'tab-agent',
      state: 'active',
      actionLabel: 'Click "Checkout"',
    })

    render(<WorkspaceBrowserAgentOverlay tabId="tab-agent" />)

    const shield = screen.getByTestId('browser-agent-takeover-shield')
    fireEvent.pointerDown(shield)
    expect(sendUserAction).toHaveBeenCalledWith({
      tabId: 'tab-agent',
      action: 'takeover',
      reason: 'user_requested',
    })

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(sendUserAction).toHaveBeenCalledTimes(2)

    // Switch to takeover state: shield disappears so user can click <webview>.
    act(() => {
      useBrowserUseStore.getState().applyHostEvent({
        type: 'control-state',
        tabId: 'tab-agent',
        state: 'takeover',
        takeoverReason: 'Complete CAPTCHA',
      })
    })
    expect(screen.queryByTestId('browser-agent-takeover-shield')).not.toBeInTheDocument()
    expect(screen.getByTestId('browser-agent-control-pill')).toHaveTextContent('Complete CAPTCHA')

    fireEvent.click(screen.getByRole('button', { name: 'Done, continue' }))
    expect(sendUserAction).toHaveBeenLastCalledWith({
      tabId: 'tab-agent',
      action: 'resume',
    })
  })

  it('dispatches resume/cancel via canonical REST store only when sessionId is present (no duplicate IPC)', () => {
    const resumeSpy = vi.spyOn(useBrowserUseStore.getState(), 'resumeTakeover').mockResolvedValue(true)
    const abortSpy = vi.spyOn(useBrowserUseStore.getState(), 'abortTakeover').mockResolvedValue(true)
    placeWorkspaceBrowserGuest('tab-agent', stage, true)
    useBrowserUseStore.getState().applyHostEvent({
      type: 'control-state',
      tabId: 'tab-agent',
      state: 'takeover',
      sessionId: 'sess-9',
      takeoverReason: '2FA required',
    })

    render(<WorkspaceBrowserAgentOverlay tabId="tab-agent" />)

    fireEvent.click(screen.getByRole('button', { name: 'Done, continue' }))
    expect(resumeSpy).toHaveBeenCalledWith('sess-9')
    expect(sendUserAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(abortSpy).toHaveBeenCalledWith('sess-9', undefined, 'user_cancelled')
    expect(sendUserAction).not.toHaveBeenCalled()
  })

  it('formats raw user_requested takeover code and yields pointer-events during app drag gestures', () => {
    placeWorkspaceBrowserGuest('tab-agent', stage, true)
    useBrowserUseStore.getState().applyHostEvent({
      type: 'control-state',
      tabId: 'tab-agent',
      state: 'active',
      actionLabel: 'Click "Next"',
    })

    render(<WorkspaceBrowserAgentOverlay tabId="tab-agent" />)

    const shield = screen.getByTestId('browser-agent-takeover-shield')
    const pill = screen.getByTestId('browser-agent-control-pill')
    expect(shield.className).toContain('pointer-events-auto')
    expect(pill.className).toContain('pointer-events-auto')

    // Start an app drag outside the guest layer (e.g. split-pane resize handle).
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(shield.className).toContain('pointer-events-none')
    expect(pill.className).toContain('pointer-events-none')

    act(() => {
      window.dispatchEvent(new Event('pointerup'))
    })
    expect(shield.className).toContain('pointer-events-auto')
    expect(pill.className).toContain('pointer-events-auto')

    // Raw internal code 'user_requested' renders localized copy instead of literal code.
    act(() => {
      useBrowserUseStore.getState().applyHostEvent({
        type: 'control-state',
        tabId: 'tab-agent',
        state: 'takeover',
        takeoverReason: 'user_requested',
      })
    })
    expect(pill).toHaveTextContent('You took over browser control')
    expect(pill).not.toHaveTextContent('user_requested')
  })

  it('acknowledges cursor-arrived synchronously (skipped: true) when slot is hidden', () => {
    // Tab is NOT shown (slot.dataset.shown === 'false').
    placeWorkspaceBrowserGuest('tab-agent', stage, false)
    useBrowserUseStore.getState().applyHostEvent({
      type: 'control-state',
      tabId: 'tab-agent',
      state: 'active',
    })

    render(<WorkspaceBrowserAgentOverlay tabId="tab-agent" />)

    act(() => {
      useBrowserUseStore.getState().applyHostEvent({
        type: 'move-cursor',
        tabId: 'tab-agent',
        moveId: 'move-hidden-1',
        x: 320,
        y: 180,
        durationMs: 260,
      })
    })

    expect(reportCursorArrived).toHaveBeenCalledWith({
      moveId: 'move-hidden-1',
      tabId: 'tab-agent',
      skipped: true,
    })
  })

  it('clamps duration to 160-380ms and curves long trajectories with bezier', () => {
    expect(computeCursorDurationMs(50)).toBeGreaterThanOrEqual(160)
    expect(computeCursorDurationMs(2000)).toBeLessThanOrEqual(380)

    const shortMid = interpolateCursorPosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5)
    expect(shortMid.y).toBe(0) // straight scoot for <= 196px

    const longMid = interpolateCursorPosition({ x: 0, y: 0 }, { x: 400, y: 0 }, 0.5)
    expect(longMid.y).not.toBe(0) // curved bezier arc for > 196px
  })
})
