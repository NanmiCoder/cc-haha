import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/browser/BrowserSurface', () => ({
  BrowserSurface: ({ sessionId }: { sessionId: string }) => <div data-testid="campus-monitor-browser">{sessionId}</div>,
}))

import { CAMPUS_MONITOR_URL, CampusMonitor } from './CampusMonitor'
import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { CAMPUS_MONITOR_TAB_ID } from '../stores/tabStore'

describe('CampusMonitor', () => {
  afterEach(() => {
    cleanup()
    useBrowserPanelStore.setState({ bySession: {} })
  })

  it('opens the existing campus event-list app in the native browser surface', () => {
    render(<CampusMonitor />)

    expect(screen.getByTestId('campus-monitor-browser')).toHaveTextContent(CAMPUS_MONITOR_TAB_ID)
    expect(useBrowserPanelStore.getState().bySession[CAMPUS_MONITOR_TAB_ID]).toMatchObject({
      isOpen: true,
      url: CAMPUS_MONITOR_URL,
      loading: true,
    })
  })
})
