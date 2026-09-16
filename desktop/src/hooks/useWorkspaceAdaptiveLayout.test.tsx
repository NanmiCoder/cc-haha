import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkspaceAdaptiveLayout } from './useWorkspaceAdaptiveLayout'

afterEach(() => vi.unstubAllGlobals())

it('temporarily shows one pane and restores the split when the content row grows', () => {
  let resize: ResizeObserverCallback = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  function Fixture() {
    const ref = useRef<HTMLElement>(null)
    const compact = useWorkspaceAdaptiveLayout(ref, true)
    return <div><aside ref={ref} data-testid="panel">{compact ? 'single' : 'split'}</aside></div>
  }
  const view = render(<Fixture />)
  act(() => resize([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver))
  expect(screen.getByTestId('panel').textContent).toBe('single')
  act(() => resize([{ contentRect: { width: 1000 } } as ResizeObserverEntry], {} as ResizeObserver))
  expect(screen.getByTestId('panel').textContent).toBe('split')
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})
