import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../pages/TerminalSettings', () => ({
  TerminalSettings: ({
    active,
    cwd,
    runtimeId,
    preserveOnUnmount,
    compactHeader,
    autoStart,
    testId,
  }: {
    active?: boolean
    cwd?: string
    runtimeId?: string
    compactHeader?: boolean
    preserveOnUnmount?: boolean
    autoStart?: boolean
    testId: string
  }) => (
    <div
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      data-compact-header={compactHeader ? 'true' : 'false'}
      data-cwd={cwd ?? ''}
      data-runtime-id={runtimeId ?? ''}
      data-preserve-on-unmount={preserveOnUnmount ? 'true' : 'false'}
      data-auto-start={autoStart ? 'true' : 'false'}
    />
  ),
}))

import {
  getTerminalRuntime,
  updateTerminalRuntime,
  destroyTerminalRuntime,
} from '../../lib/terminalRuntime'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { WorkspaceTerminalTab } from './WorkspaceTerminalTab'
import type { WorkspaceTerminalTab as WorkspaceTerminalTabModel } from '../../lib/workspace/types'

const SESSION = 'session-a'

function makeTab(overrides: Partial<WorkspaceTerminalTabModel> = {}): WorkspaceTerminalTabModel {
  return {
    id: 'tab-term',
    kind: 'terminal',
    dock: 'side',
    preview: false,
    createdAt: 0,
    runtimeId: 'runtime-1',
    cwd: '/repo',
    status: 'live',
    ordinal: 1,
    ...overrides,
  }
}

beforeEach(() => {
  destroyTerminalRuntime('runtime-1')
  useWorkspaceStore.setState({
    bySession: {
      [SESSION]: {
        layout: 'split',
        bottomOpen: false,
        tabs: [makeTab()],
        activeSideTabId: 'tab-term',
        activeBottomTabId: null,
        closed: [],
        nextTerminalOrdinal: 2,
        focus: null,
        origin: null,
      },
    },
  })
})

describe('WorkspaceTerminalTab', () => {
  it('hands the runtime its identity and asks the host to keep it alive', () => {
    render(<WorkspaceTerminalTab sessionId={SESSION} tab={makeTab()} active />)

    const host = screen.getByTestId('workspace-terminal-host-1')
    expect(host).toHaveAttribute('data-runtime-id', 'runtime-1')
    expect(host).toHaveAttribute('data-cwd', '/repo')
    expect(host).toHaveAttribute('data-compact-header', 'true')
    // `preserveOnUnmount` is what lets a terminal move docks, survive the panel
    // being hidden and survive a task switch without restarting the PTY.
    expect(host).toHaveAttribute('data-preserve-on-unmount', 'true')
  })

  it('reports being off screen without tearing the terminal down', () => {
    const { rerender } = render(
      <WorkspaceTerminalTab sessionId={SESSION} tab={makeTab()} active />,
    )
    expect(screen.getByTestId('workspace-terminal-host-1')).toHaveAttribute('data-active', 'true')

    rerender(<WorkspaceTerminalTab sessionId={SESSION} tab={makeTab()} active={false} />)

    expect(screen.getByTestId('workspace-terminal-host-1')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('workspace-terminal-host-1'))
      .toHaveAttribute('data-runtime-id', 'runtime-1')
  })

  it('tells the controller when the shell exits so the tab can offer a restart', () => {
    render(<WorkspaceTerminalTab sessionId={SESSION} tab={makeTab()} active />)
    expect(useWorkspaceStore.getState().getTab(SESSION, 'tab-term'))
      .toMatchObject({ status: 'live' })

    act(() => {
      updateTerminalRuntime(getTerminalRuntime('runtime-1', 'idle'), { status: 'exited' })
    })

    expect(useWorkspaceStore.getState().getTab(SESSION, 'tab-term'))
      .toMatchObject({ status: 'exited' })
  })

  it('treats an unavailable host as exited rather than as a running shell', () => {
    render(<WorkspaceTerminalTab sessionId={SESSION} tab={makeTab()} active />)

    act(() => {
      updateTerminalRuntime(getTerminalRuntime('runtime-1', 'idle'), { status: 'unavailable' })
    })

    expect(useWorkspaceStore.getState().getTab(SESSION, 'tab-term'))
      .toMatchObject({ status: 'exited' })
  })

  it('stops listening once the tab is gone', () => {
    const { unmount } = render(
      <WorkspaceTerminalTab sessionId={SESSION} tab={makeTab()} active />,
    )
    unmount()

    // Unmounting must not be able to report state onto a tab that is no longer
    // rendered — and must not throw when the runtime keeps emitting.
    expect(() => {
      updateTerminalRuntime(getTerminalRuntime('runtime-1', 'idle'), { status: 'exited' })
    }).not.toThrow()
    expect(useWorkspaceStore.getState().getTab(SESSION, 'tab-term'))
      .toMatchObject({ status: 'live' })
  })
})

describe('restored terminals', () => {
  it('does not spawn a shell for a tab restored from disk', () => {
    render(
      <WorkspaceTerminalTab sessionId={SESSION} tab={makeTab({ status: 'exited' })} active />,
    )

    // A restart re-opening five terminals must not silently start five shells.
    expect(screen.getByTestId('workspace-terminal-host-1'))
      .toHaveAttribute('data-auto-start', 'false')
    expect(screen.getByTestId('workspace-terminal-exited-1')).toBeInTheDocument()
  })

  it('spawns normally for a terminal the user just created', () => {
    render(<WorkspaceTerminalTab sessionId={SESSION} tab={makeTab()} active />)
    expect(screen.getByTestId('workspace-terminal-host-1'))
      .toHaveAttribute('data-auto-start', 'true')
    expect(screen.queryByTestId('workspace-terminal-exited-1')).toBeNull()
  })

  it('leaves a restored tab marked exited until something actually runs', () => {
    useWorkspaceStore.setState({
      bySession: {
        [SESSION]: {
          layout: 'split',
          bottomOpen: false,
          tabs: [makeTab({ status: 'exited' })],
          activeSideTabId: 'tab-term',
          activeBottomTabId: null,
          closed: [],
          nextTerminalOrdinal: 2,
          focus: null,
          origin: null,
        },
      },
    })

    render(
      <WorkspaceTerminalTab sessionId={SESSION} tab={makeTab({ status: 'exited' })} active />,
    )

    // A fresh runtime reports `idle`, which is "no process yet" — reporting it
    // as `live` is what let a restored tab overwrite its own persisted state.
    expect(useWorkspaceStore.getState().getTab(SESSION, 'tab-term'))
      .toMatchObject({ status: 'exited' })
  })
})
