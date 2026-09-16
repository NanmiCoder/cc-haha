import { StrictMode, useRef } from 'react'
import { createPortal } from 'react-dom'
import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceHeaderProvider, useWorkspaceHeaderHost, useWorkspaceHeaderTarget } from './WorkspaceHeaderContext'

afterEach(() => vi.unstubAllGlobals())

function Host({ session }: { session: string }) {
  const host = useWorkspaceHeaderHost(session)
  return <header data-testid="header" style={{ width: host.width }}><div ref={host.ref} /></header>
}

function Surface({ session }: { session: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const target = useWorkspaceHeaderTarget(ref, session, true)
  return <div ref={ref} data-testid={`surface-${session}`}>
    <input aria-label={`content-${session}`} defaultValue="retained" />
    {target ? createPortal(<span>{session} tabs</span>, target) : null}
  </div>
}

it('keeps CSS widths scoped to the current surface and ignores disconnected observer delivery', () => {
  const callbacks: Array<(entries: { contentRect: { width: number } }[]) => void> = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: typeof callbacks[number]) { callbacks.push(callback) }
    observe() {}
    disconnect() {}
  })
  function Scene({ session, header = true }: { session: string; header?: boolean }) {
    return <StrictMode><WorkspaceHeaderProvider>
      {header ? <Host session={session} /> : null}
      <Surface session={session} />
    </WorkspaceHeaderProvider></StrictMode>
  }
  const { rerender } = render(<Scene session="a" />)
  const oldCallback = callbacks.at(-1)!
  act(() => oldCallback([{ contentRect: { width: 640 } }]))
  expect(screen.getByTestId('header').style.width).toBe('640px')
  const content = screen.getByRole('textbox')
  rerender(<Scene session="a" header={false} />)
  expect(screen.getByRole('textbox')).toBe(content)
  expect(screen.queryByText('a tabs')).toBeNull()
  rerender(<Scene session="b" />)
  act(() => callbacks.at(-1)!([{ contentRect: { width: 800 } }]))
  act(() => oldCallback([{ contentRect: { width: 111 } }]))
  expect(screen.getByTestId('header').style.width).toBe('800px')
  expect(screen.queryByText('a tabs')).toBeNull()
  expect(screen.getByTestId('header').textContent).toBe('b tabs')
})
