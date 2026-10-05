import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DesktopSettings as Settings } from './Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

/**
 * The rail is a scroll container taller than its viewport, and Settings
 * remounts every time the tab is re-entered — notably when another surface
 * sends the user to a specific section. These cover the two halves of landing
 * correctly: the right section is shown, and its rail entry is in view.
 */
describe('Settings section navigation', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  })

  afterEach(() => {
    cleanup()
    scrollIntoView.mockClear()
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  })

  it('opens the section a pending request asked for and clears the request', async () => {
    useUIStore.setState({ pendingSettingsTab: 'diagnostics' })

    render(<Settings />)

    await waitFor(() => {
      expect(useUIStore.getState().activeSettingsTab).toBe('diagnostics')
    })
    expect(useUIStore.getState().pendingSettingsTab).toBeNull()
    expect(screen.getByRole('button', { name: 'Diagnostics', current: 'page' })).toBeInTheDocument()
  })

  it('brings the selected rail entry into view on mount', async () => {
    useUIStore.setState({ activeSettingsTab: 'diagnostics' })

    render(<Settings />)

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    })
    const railEntry = screen.getByRole('button', { name: 'Diagnostics', current: 'page' })
    expect(railEntry).toBeInTheDocument()
  })

  it('no longer offers a Trace section; per-session traces live in the chat', () => {
    render(<Settings />)

    expect(screen.queryByRole('button', { name: 'Trace' })).not.toBeInTheDocument()
  })

  it('follows the selection when another section is picked', () => {
    render(<Settings />)
    scrollIntoView.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(useUIStore.getState().activeSettingsTab).toBe('diagnostics')
  })

  it('keeps the rail on paper so the Settings tab meets its own content', () => {
    render(<Settings />)

    const rail = screen.getByRole('button', { name: 'Model Settings' })
      .closest('[data-testid="settings-navigation"]')

    // This rail is what sits directly under the Settings tab, and the tab is
    // filled with paper precisely so its bottom edge runs unbroken into the
    // view it opens onto. The rail used to be
    // `--color-surface-container-low`, which resolves to the same value as the
    // strip's trough — making Settings the one tab in the app whose paper met
    // a different colour at its own bottom edge, a white card stranded on a
    // grey panel. Paper plus the rule, the way the workbench and the diff
    // split already do it.
    expect(rail?.className).toContain('bg-[var(--color-surface)]')
    expect(rail?.className).not.toContain('bg-[var(--color-surface-container-low)]')
    // The rule is what separates the rail from the section beside it now, so
    // it is load-bearing rather than trim.
    expect(rail?.className).toContain('border-r')
    // Page chrome stays left-pinned. Chasing the settings tab's strip offset used
    // to shove this rail mid-panel whenever the tab was not leading.
    expect((rail as HTMLElement).style.marginLeft).toBe('')
  })

  it('gives every pane the same wide, fluid page frame', () => {
    render(<Settings />)

    const frameFor = () => screen.getByTestId('settings-page-frame')
    // The old 700px cap left explorer-style panes (memory, skills) squeezed
    // into the middle of an empty page. The frame now fills the column up to
    // 1120px and is the only place a pane's width is set.
    expect(frameFor()).toHaveClass('w-full', 'max-w-[1120px]')
    expect(frameFor().className).not.toContain('max-w-[700px]')

    // Switching panes must not move the header, so the frame is shared.
    const providersClass = frameFor().className
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    expect(frameFor().className).toBe(providersClass)
  })
})
