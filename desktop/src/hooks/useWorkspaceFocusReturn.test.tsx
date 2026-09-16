import { act, render, renderHook, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/terminalRuntime', () => ({ destroyTerminalRuntime: vi.fn() }))
vi.mock('../lib/workspace/browserHost', () => ({ releaseWorkspaceBrowserTab: vi.fn() }))

import { useWorkspaceStore } from '../stores/workspaceStore'
import { useWorkspaceFocusReturn } from './useWorkspaceFocusReturn'

const SESSION = 'session-a'

function renderToggles() {
  return render(
    <>
      <button type="button" data-workspace-focus="side-toggle">workspace</button>
      <button type="button" data-workspace-focus="bottom-toggle">terminal</button>
    </>,
  )
}

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {} })
})

describe('useWorkspaceFocusReturn', () => {
  it('returns focus to the title-bar toggle when the panel is hidden', () => {
    renderToggles()
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'file', path: 'a.ts' })
    renderHook(() => useWorkspaceFocusReturn(SESSION))

    act(() => { useWorkspaceStore.getState().toggleWorkspace(SESSION) })

    // The panel unmounts on hide, so the request can only be honoured from a
    // component that outlives it.
    expect(screen.getByText('workspace')).toHaveFocus()
  })

  it('consumes the request so it cannot fire again on the next open', () => {
    renderToggles()
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'file', path: 'a.ts' })
    renderHook(() => useWorkspaceFocusReturn(SESSION))
    act(() => { useWorkspaceStore.getState().toggleWorkspace(SESSION) })

    expect(useWorkspaceStore.getState().getSession(SESSION).focus).toBeNull()
  })

  it('consumes a request even when its toggle is not on screen', () => {
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'file', path: 'a.ts' })
    renderHook(() => useWorkspaceFocusReturn(SESSION))

    act(() => { useWorkspaceStore.getState().toggleWorkspace(SESSION) })

    // An unconsumed request outlives the moment it was about; leaving it would
    // park focus on the hide button the next time the panel mounts.
    expect(useWorkspaceStore.getState().getSession(SESSION).focus).toBeNull()
  })

  it('leaves content-focus requests to the panel itself', () => {
    renderToggles()
    renderHook(() => useWorkspaceFocusReturn(SESSION))

    act(() => {
      useWorkspaceStore.getState().openTarget(SESSION, { kind: 'file', path: 'a.ts' })
    })

    expect(useWorkspaceStore.getState().getSession(SESSION).focus?.target).toBe('active-side-tab')
  })
})
