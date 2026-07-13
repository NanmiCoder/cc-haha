// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../workspace/WorkspacePanel', () => ({
  WorkspacePanel: ({ sessionId, embedded, forceVisible }: { sessionId: string; embedded?: boolean; forceVisible?: boolean }) => (
    <div
      data-testid="workspace-panel"
      data-embedded={embedded ? 'true' : 'false'}
      data-force-visible={forceVisible ? 'true' : 'false'}
    >
      workspace:{sessionId}
    </div>
  ),
}))

vi.mock('../browser/BrowserSurface', () => ({
  BrowserSurface: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="browser-surface">browser:{sessionId}</div>
  ),
}))

import { WorkbenchPanel } from './WorkbenchPanel'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useTabStore } from '../../stores/tabStore'

const SESSION_ID = 'workbench-session'

beforeEach(() => {
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  useTabStore.setState(useTabStore.getInitialState(), true)
  useSettingsStore.setState({ locale: 'en' })
  useWorkspacePanelStore.getState().openPanel(SESSION_ID)
})

afterEach(() => {
  cleanup()
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  useTabStore.setState(useTabStore.getInitialState(), true)
})

describe('WorkbenchPanel', () => {
  it('renders the file workspace (embedded) in the default workspace mode', () => {
    render(<WorkbenchPanel sessionId={SESSION_ID} />)

    const workspace = screen.getByTestId('workspace-panel')
    expect(workspace).toHaveTextContent(`workspace:${SESSION_ID}`)
    expect(workspace).toHaveAttribute('data-embedded', 'true')
    expect(screen.queryByTestId('browser-surface')).not.toBeInTheDocument()
  })

  it('renders the native BrowserSurface in browser mode', () => {
    useWorkspacePanelStore.getState().setMode(SESSION_ID, 'browser')
    render(<WorkbenchPanel sessionId={SESSION_ID} />)

    expect(screen.getByTestId('browser-surface')).toHaveTextContent(`browser:${SESSION_ID}`)
    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument()
  })

  it('reflects the active mode on the segmented control tabs', () => {
    useWorkspacePanelStore.getState().setMode(SESSION_ID, 'browser')
    render(<WorkbenchPanel sessionId={SESSION_ID} />)

    expect(screen.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'false')
  })

  it('exposes a single compact workbench navigation landmark', () => {
    render(<WorkbenchPanel sessionId={SESSION_ID} variant="tab" />)

    const navigation = screen.getByTestId('workbench-navigation')
    expect(navigation).toHaveAttribute('aria-label', 'Workbench navigation')
    expect(navigation).toContainElement(screen.getByRole('button', { name: 'Back to conversation' }))
    expect(navigation).toContainElement(screen.getByRole('tablist', { name: 'Workbench mode' }))
    expect(navigation).toContainElement(screen.getByRole('button', { name: 'Close' }))
    expect(navigation.className).toContain('h-12')
    expect(screen.getByRole('tablist', { name: 'Workbench mode' }).className).not.toContain('border')
  })

  it('switching to the browser tab calls setMode("browser")', () => {
    render(<WorkbenchPanel sessionId={SESSION_ID} />)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')

    fireEvent.click(screen.getByRole('tab', { name: 'Browser' }))

    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('browser')
    expect(useBrowserPanelStore.getState().bySession[SESSION_ID]).toMatchObject({
      isOpen: true,
      url: '',
      history: [],
      historyIndex: -1,
      loading: false,
    })
  })

  it('switching to the files tab calls setMode("workspace")', () => {
    useWorkspacePanelStore.getState().setMode(SESSION_ID, 'browser')
    render(<WorkbenchPanel sessionId={SESSION_ID} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))

    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')
  })

  it('the close button closes the unified panel', () => {
    render(<WorkbenchPanel sessionId={SESSION_ID} />)
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(false)
  })

  it('the expand button promotes the current workbench into a main content tab', () => {
    useWorkspacePanelStore.getState().setMode(SESSION_ID, 'browser')
    render(<WorkbenchPanel sessionId={SESSION_ID} />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }))

    expect(useTabStore.getState().activeTabId).toBe(`__workbench__${SESSION_ID}`)
    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: `__workbench__${SESSION_ID}`,
        title: 'Workbench',
        type: 'workbench',
        status: 'idle',
        workbenchSessionId: SESSION_ID,
        sourceSessionId: SESSION_ID,
      },
    ])
  })

  it('carries the conversation opener origin into the expanded workbench tab', () => {
    useWorkspacePanelStore.setState({
      originBySession: {
        [SESSION_ID]: {
          sourceTurnKey: 'assistant-turn-3',
          sourceElementId: 'turn-change-opener-3',
        },
      },
    })
    render(<WorkbenchPanel sessionId={SESSION_ID} />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }))

    expect(useTabStore.getState().tabs[0]).toMatchObject({
      sourceSessionId: SESSION_ID,
      sourceTurnKey: 'assistant-turn-3',
      sourceElementId: 'turn-change-opener-3',
    })
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(false)
    expect(useWorkspacePanelStore.getState().getOrigin(SESSION_ID)).toEqual({
      sourceTurnKey: 'assistant-turn-3',
      sourceElementId: 'turn-change-opener-3',
    })
  })

  it('renders the tab variant without a nested expand action', () => {
    const handleClose = vi.fn()
    render(<WorkbenchPanel sessionId={SESSION_ID} variant="tab" onClose={handleClose} />)

    expect(screen.queryByRole('button', { name: 'Expand panel' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel')).toHaveAttribute('data-force-visible', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(handleClose).toHaveBeenCalledTimes(1)
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)
  })

  it('returns the tab variant to its source conversation', () => {
    useTabStore.getState().openTab(SESSION_ID, 'Conversation')
    const workbenchTabId = useTabStore.getState().openWorkbenchTab(SESSION_ID, 'Workbench')
    render(<WorkbenchPanel sessionId={SESSION_ID} variant="tab" />)

    fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }))

    expect(useTabStore.getState().activeTabId).toBe(SESSION_ID)
    expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === workbenchTabId)).toBe(false)
  })
})
