import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/sessions', () => ({ sessionsApi: {
  getWorkspaceTree: vi.fn(async () => ({ state: 'ok', path: '', entries: [{ name: 'a.ts', path: 'a.ts', isDirectory: false }] })),
  getWorkspaceFile: vi.fn(async (_session, path) => ({ state: 'ok', path, content: 'one\ntwo\nthree', language: 'text', size: 13 })),
  getWorkspaceStatus: vi.fn(async () => ({ state: 'ok', workDir: '/fixtures/repo', changedFiles: [] })),
  searchWorkspace: vi.fn(async (_session, query) => ({ state: 'ok', query, entries: [{ name: 'a.ts', path: 'a.ts', isDirectory: false }], truncated: false })),
} }))
vi.mock('@/components/workspace/WorkspaceFileOpenWith', () => ({ WorkspaceFileOpenWith: () => <div /> }))
vi.mock('@/components/workspace/workspaceDiffHighlighter', () => ({ highlightWorkspaceCode: vi.fn(async () => ({ engine: 'prism' })) }))

import { WorkspaceFileTab } from './WorkspaceFileTab'
import { useWorkspaceContentStore } from '@/stores/workspaceContentStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { WorkspaceFileTab as FileTab } from '@/lib/workspace/types'

function tab(path: string): FileTab {
  return { kind: 'file', id: path || 'files', path, dock: 'side', preview: false, createdAt: 0 }
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  for (const session of ['a', 'b']) useWorkspaceContentStore.getState().clearSession(session)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Files navigation across real panel boundaries', () => {
  it('retains the same filter and scroll DOM while the tree is collapsed and reopened', async () => {
    render(<WorkspaceFileTab sessionId="a" tab={tab('a.ts')} />)
    await screen.findByTestId('workspace-tree-row-a.ts')
    const filter = screen.getByRole('searchbox')
    fireEvent.change(filter, { target: { value: 'a' } })
    const tree = screen.getByRole('tree')
    tree.scrollTop = 140
    fireEvent.scroll(tree)
    fireEvent.click(screen.getByTestId('workspace-file-tree-toggle'))
    fireEvent.click(screen.getByTestId('workspace-file-tree-toggle'))
    expect(screen.getByRole('searchbox')).toBe(filter)
    expect(screen.getByRole('searchbox')).toHaveValue('a')
    expect(screen.getByRole('tree').scrollTop).toBe(140)
  })

  it('restores per-task filter and tree scroll after leaving Files, without leaking into another task', async () => {
    const view = render(<WorkspaceFileTab sessionId="a" tab={tab('a.ts')} />)
    await screen.findByTestId('workspace-tree-row-a.ts')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'needle' } })
    const tree = screen.getByRole('tree')
    tree.scrollTop = 180
    fireEvent.scroll(tree)

    await act(async () => {
      view.rerender(<WorkspaceFileTab sessionId="b" tab={tab('a.ts')} />)
    })
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('tree').scrollTop).toBe(0)
    view.rerender(<div>browser</div>)
    await act(async () => {
      view.rerender(<WorkspaceFileTab sessionId="a" tab={tab('a.ts')} />)
    })
    expect(screen.getByRole('searchbox')).toHaveValue('needle')
    expect(screen.getByRole('tree').scrollTop).toBe(180)
  })

  it('offers a close control inside the narrow overlay and keeps the selected path when reopened', async () => {
    let resize: ResizeObserverCallback = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe() {}
      disconnect() {}
    })
    render(<WorkspaceFileTab sessionId="a" tab={tab('a.ts')} />)
    await screen.findByTestId('workspace-tree-row-a.ts')
    act(() => resize([{ contentRect: { width: 500 } } as ResizeObserverEntry], {} as ResizeObserver))
    fireEvent.click(screen.getByTestId('workspace-file-tree-toggle'))
    const overlay = screen.getByTestId('workspace-tree-sidebar')
    const close = overlay.querySelector<HTMLElement>('[data-testid="workspace-tree-overlay-close"]')
    expect(close).not.toBeNull()
    fireEvent.click(close!)
    expect(overlay).not.toBeVisible()
    fireEvent.click(screen.getByTestId('workspace-file-tree-toggle'))
    expect(screen.getByTestId('workspace-tree-row-a.ts')).toHaveAttribute('aria-selected', 'true')
  })

  it('restores file scroll separately per path and task after remount', async () => {
    const revealedTab = { ...tab('a.ts'), reveal: { line: 2, nonce: 1 } }
    const view = render(<WorkspaceFileTab sessionId="a" tab={revealedTab} />)
    await screen.findByTestId('workspace-code')
    let surface = screen.getByTestId('workspace-code').parentElement!.parentElement!
    surface.scrollTop = 210
    surface.scrollLeft = 35
    fireEvent.scroll(surface)
    expect(surface.scrollTop).toBe(210)
    view.rerender(<WorkspaceFileTab sessionId="a" tab={tab('b.ts')} />)
    await waitFor(() => expect(screen.getByTestId('workspace-code')).toBeInTheDocument())
    surface = screen.getByTestId('workspace-code').parentElement!.parentElement!
    expect(surface.scrollTop).toBe(0)
    view.rerender(<div>browser</div>)
    view.rerender(<WorkspaceFileTab sessionId="b" tab={tab('a.ts')} />)
    await screen.findByTestId('workspace-code')
    surface = screen.getByTestId('workspace-code').parentElement!.parentElement!
    expect(surface.scrollTop).toBe(0)
    view.rerender(<WorkspaceFileTab sessionId="a" tab={revealedTab} />)
    await screen.findByTestId('workspace-code')
    surface = screen.getByTestId('workspace-code').parentElement!.parentElement!
    expect(surface.scrollTop).toBe(210)
    expect(surface.scrollLeft).toBe(35)
  })
})
