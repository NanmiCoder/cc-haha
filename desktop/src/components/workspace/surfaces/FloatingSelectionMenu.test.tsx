import '@testing-library/jest-dom/vitest'
import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { resolveAppRegion } from '@/test/appRegion'
import { FloatingSelectionMenu } from './FloatingSelectionMenu'

describe('FloatingSelectionMenu', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders nothing without a selection', () => {
    const { container } = render(
      <FloatingSelectionMenu selection={null} onAdd={vi.fn()} popoverRef={createRef<HTMLButtonElement>()} />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('pins the menu to the selection position', () => {
    render(
      <FloatingSelectionMenu
        selection={{ text: 'const a = 1', x: 120, y: 48 }}
        onAdd={vi.fn()}
        popoverRef={createRef<HTMLButtonElement>()}
      />,
    )

    const button = screen.getByRole('button', { name: 'Add to chat' })
    expect(button).toHaveStyle({ left: '120px', top: '48px' })
  })

  it('stays clickable when it is clamped up under the window titlebar', () => {
    // Following a selection scrolled off the top of a PDF, the button is
    // clamped to y=12 — inside the 52px titlebar. Rendered inside the surface
    // it reported no app-region, so the titlebar's drag region took the click:
    // Windows dragged the window and macOS swallowed it. As an overlay
    // portalled under <body> its own box is the no-drag rectangle.
    const root = document.body.appendChild(document.createElement('div'))
    root.id = 'root'
    render(
      <FloatingSelectionMenu
        selection={{ text: 'const a = 1', x: 120, y: 12 }}
        onAdd={vi.fn()}
        popoverRef={createRef<HTMLButtonElement>()}
      />,
      { container: root },
    )

    const button = screen.getByRole('button', { name: 'Add to chat' })
    expect(root).not.toContainElement(button)
    expect(resolveAppRegion(button)).toBe('no-drag')
  })

  it('reports the click to the caller', () => {
    const onAdd = vi.fn()
    render(
      <FloatingSelectionMenu
        selection={{ text: 'const a = 1', x: 10, y: 10 }}
        onAdd={onAdd}
        popoverRef={createRef<HTMLButtonElement>()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('swallows the plain left mousedown so the selection survives the click', () => {
    // Without preventDefault the browser collapses the selection on mousedown and
    // the menu would add an empty quote to the chat.
    render(
      <FloatingSelectionMenu
        selection={{ text: 'const a = 1', x: 10, y: 10 }}
        onAdd={vi.fn()}
        popoverRef={createRef<HTMLButtonElement>()}
      />,
    )
    const button = screen.getByRole('button', { name: 'Add to chat' })

    expect(fireEvent.mouseDown(button, { button: 0 })).toBe(false)
    // A ctrl-click is the macOS context menu gesture, which must stay native.
    expect(fireEvent.mouseDown(button, { button: 0, ctrlKey: true })).toBe(true)
    expect(fireEvent.mouseDown(button, { button: 2 })).toBe(true)
  })

  it('hands the button back through popoverRef so outside-click dismissal can skip it', () => {
    const popoverRef = createRef<HTMLButtonElement>()
    render(
      <FloatingSelectionMenu
        selection={{ text: 'const a = 1', x: 10, y: 10 }}
        onAdd={vi.fn()}
        popoverRef={popoverRef}
      />,
    )

    expect(popoverRef.current).toBe(screen.getByRole('button', { name: 'Add to chat' }))
  })
})
