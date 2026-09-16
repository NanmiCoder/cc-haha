import { describe, expect, it, vi } from 'vitest'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'
import type { WorkspaceTab } from '../../lib/workspace/types'

const FILE_TAB: WorkspaceTab = {
  id: 'tab-file',
  kind: 'file',
  dock: 'side',
  preview: false,
  createdAt: 0,
  path: 'desktop/src/api/adapters.ts',
}

/**
 * jsdom has no `PointerEvent`, so `fireEvent.pointerDown(node, { clientX })`
 * silently drops the coordinate — which makes a drag test pass for the wrong
 * reason or, as here, never fire at all. Build the event and pin the fields.
 */
function firePointer(node: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number) {
  const event = createEvent[type](node)
  Object.defineProperty(event, 'button', { value: 0 })
  Object.defineProperty(event, 'clientX', { value: clientX })
  fireEvent(node, event)
}

const PREVIEW_TAB: WorkspaceTab = { ...FILE_TAB, id: 'tab-preview', preview: true, path: 'a.ts' }

const BROWSER_TAB: WorkspaceTab = {
  id: 'tab-web',
  kind: 'browser',
  dock: 'side',
  preview: false,
  createdAt: 0,
  browserTabId: 'wb-1',
  storageId: 'page-1',
  url: null,
  title: null,
  loadError: null,
}

const REVIEW_TAB: WorkspaceTab = {
  id: 'tab-review',
  kind: 'review',
  dock: 'side',
  preview: false,
  createdAt: 0,
  source: { kind: 'unstaged' },
  selectedPath: null,
}

const TERMINAL_TAB: WorkspaceTab = {
  id: 'tab-term',
  kind: 'terminal',
  dock: 'side',
  preview: false,
  createdAt: 0,
  runtimeId: 'rt-1',
  cwd: '/repo',
  status: 'live',
  ordinal: 2,
}

function renderStrip(overrides: Partial<Parameters<typeof WorkspaceTabStrip>[0]> = {}) {
  const props = {
    dock: 'side' as const,
    tabs: [FILE_TAB],
    activeTabId: FILE_TAB.id,
    onActivate: vi.fn(),
    onPin: vi.fn(),
    onClose: vi.fn(),
    onCloseScope: vi.fn(),
    onReorder: vi.fn(),
    onMoveDock: vi.fn(),
    onReopenClosed: vi.fn(),
    canReopenClosed: false,
    onAdd: vi.fn(),
    ...overrides,
  }
  const view = render(<WorkspaceTabStrip {...props} />)
  return { ...view, props }
}

describe('WorkspaceTabStrip', () => {
  it('preserves the file language identity without adding it to the tab name', () => {
    renderStrip()
    const tab = screen.getByRole('tab', { name: 'adapters.ts' })
    expect(tab.querySelector('[data-file-type="ts"]')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows the strip for a single tab', () => {
    renderStrip()
    // The reference keeps the strip at one tab too: it is what makes "this
    // panel holds resources, and here they are" true at every moment.
    expect(screen.getByTestId('workspace-tab-strip-side')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('lets leftover window-header space drag the window without capturing tab controls', () => {
    renderStrip({ placement: 'window' })
    const strip = screen.getByTestId('workspace-tab-strip-side')
    const tab = screen.getByTestId('workspace-tab-wrap-tab-file')
    const add = screen.getByTestId('workspace-add-tab-side').closest('span')

    expect(strip).toHaveAttribute('data-desktop-drag-region')
    expect(tab).toHaveClass('tab-bar-interactive')
    expect(add).toHaveClass('tab-bar-interactive')
    expect(tab).not.toHaveAttribute('data-desktop-drag-region')
  })

  it('does not turn a dock strip into window chrome', () => {
    renderStrip({ placement: 'dock' })
    expect(screen.getByTestId('workspace-tab-strip-side')).not.toHaveAttribute('data-desktop-drag-region')
  })

  it('titles each kind from its own identity', () => {
    renderStrip({ tabs: [FILE_TAB, BROWSER_TAB, REVIEW_TAB, TERMINAL_TAB] })

    expect(screen.getByTestId('workspace-tab-tab-file')).toHaveTextContent('adapters.ts')
    expect(screen.getByTestId('workspace-tab-tab-web')).toHaveTextContent('New tab')
    expect(screen.getByTestId('workspace-tab-tab-review')).toHaveTextContent('Review')
    expect(screen.getByTestId('workspace-tab-tab-term')).toHaveTextContent('Terminal 2')
  })

  it('marks the active tab for assistive technology', () => {
    renderStrip({ tabs: [FILE_TAB, BROWSER_TAB], activeTabId: BROWSER_TAB.id })
    expect(screen.getByTestId('workspace-tab-tab-web')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('workspace-tab-tab-file')).toHaveAttribute('aria-selected', 'false')
  })

  it('distinguishes a replaceable preview tab', () => {
    renderStrip({ tabs: [PREVIEW_TAB] })
    expect(screen.getByTestId('workspace-tab-tab-preview')).toHaveAttribute('data-preview', 'true')
  })

  it('activates on click and pins on double click', () => {
    const { props } = renderStrip({ tabs: [FILE_TAB, PREVIEW_TAB] })

    fireEvent.click(screen.getByTestId('workspace-tab-tab-preview'))
    expect(props.onActivate).toHaveBeenCalledWith('tab-preview')

    fireEvent.doubleClick(screen.getByTestId('workspace-tab-tab-preview'))
    expect(props.onPin).toHaveBeenCalledWith('tab-preview')
  })

  it('closes a tab without also activating it', () => {
    const { props } = renderStrip({ tabs: [FILE_TAB, BROWSER_TAB] })

    fireEvent.click(screen.getByLabelText('Close New tab'))

    expect(props.onClose).toHaveBeenCalledWith('tab-web')
    expect(props.onActivate).not.toHaveBeenCalled()
  })

  it.each([FILE_TAB, BROWSER_TAB, TERMINAL_TAB])('closes a background $kind tab with the middle button without activating or dragging it', (target) => {
    const other: WorkspaceTab = { ...FILE_TAB, id: 'active-file', path: 'README.md' }
    const { props } = renderStrip({ tabs: [other, target], activeTabId: other.id })
    const tab = screen.getByTestId(`workspace-tab-${target.id}`)
    const down = createEvent.mouseDown(tab, { button: 1 })
    fireEvent(tab, down)
    const aux = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    fireEvent(tab, aux)

    expect(down.defaultPrevented).toBe(true)
    expect(aux.defaultPrevented).toBe(true)
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith(target.id)
    expect(props.onActivate).not.toHaveBeenCalled()
    expect(props.onReorder).not.toHaveBeenCalled()
  })

  it('does not close a tab for left or right auxiliary clicks', () => {
    const { props } = renderStrip()
    const tab = screen.getByTestId('workspace-tab-tab-file')
    for (const button of [0, 2]) {
      fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button }))
    }
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('reveals a newly active overflowing tab within its strip without stealing focus', () => {
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) })
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tablist') return rect(100, 400)
      if (this.dataset.testid === 'workspace-tab-wrap-tab-review') return rect(450, 590)
      if (this.dataset.testid === 'workspace-tab-wrap-tab-file') return rect(100, 240)
      return originalRect.call(this)
    })
    try {
      const { props, rerender } = renderStrip({ tabs: [FILE_TAB, BROWSER_TAB] })
      const strip = screen.getByRole('tablist')
      const trigger = screen.getByTestId('workspace-add-tab-side')
      act(() => { trigger.focus() })
      rerender(<WorkspaceTabStrip {...props} tabs={[FILE_TAB, BROWSER_TAB, REVIEW_TAB]} activeTabId={REVIEW_TAB.id} />)
      expect(strip.scrollLeft).toBe(190)
      expect(document.activeElement).toBe(trigger)

      // Once revealed, an unrelated rerender must leave the user's scroll alone.
      measure.mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('role') === 'tablist') return rect(100, 400)
        if (this.dataset.testid === 'workspace-tab-wrap-tab-review') return rect(250, 390)
        return originalRect.call(this)
      })
      rerender(<WorkspaceTabStrip {...props} tabs={[FILE_TAB, BROWSER_TAB, REVIEW_TAB]} activeTabId={REVIEW_TAB.id} />)
      expect(strip.scrollLeft).toBe(190)
    } finally {
      measure.mockRestore()
    }
  })

  it('reveals an activated tab hidden to the left without scrolling the document', () => {
    const { props, rerender } = renderStrip({ tabs: [FILE_TAB, BROWSER_TAB], activeTabId: BROWSER_TAB.id })
    const strip = screen.getByRole('tablist')
    strip.scrollLeft = 180
    strip.getBoundingClientRect = () => ({ left: 200, right: 500, width: 300 } as DOMRect)
    screen.getByTestId('workspace-tab-wrap-tab-file').getBoundingClientRect = () => ({ left: 20, right: 160, width: 140 } as DOMRect)
    const documentScroll = document.documentElement.scrollTop
    rerender(<WorkspaceTabStrip {...props} activeTabId={FILE_TAB.id} />)
    expect(strip.scrollLeft).toBe(0)
    expect(document.documentElement.scrollTop).toBe(documentScroll)
  })

  it('offers the close scopes from the context menu', () => {
    const { props } = renderStrip({ tabs: [FILE_TAB, BROWSER_TAB] })

    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-file'))
    const menu = screen.getByTestId('workspace-tab-menu')
    fireEvent.click(within(menu).getByText('Close to the right'))

    expect(props.onCloseScope).toHaveBeenCalledWith('tab-file', 'right')
  })

  it('disables reopen-closed when there is nothing to reopen', () => {
    renderStrip({ canReopenClosed: false })
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-file'))
    expect(screen.getByText('Reopen closed tab')).toBeDisabled()
  })

  it.each(['side', 'bottom'] as const)('disables close scopes without targets in the %s dock', (dock) => {
    const target: WorkspaceTab = { ...TERMINAL_TAB, dock }
    const otherDock: WorkspaceTab = { ...TERMINAL_TAB, id: 'other-dock', dock: dock === 'side' ? 'bottom' : 'side' }
    renderStrip({ dock, tabs: [target, otherDock], activeTabId: target.id })
    fireEvent.contextMenu(screen.getByTestId(`workspace-tab-${target.id}`))
    expect(screen.getByText('Close others')).toBeDisabled()
    expect(screen.getByText('Close to the right')).toBeDisabled()
  })

  it('only enables close-right for a tab with another tab to its right in this dock', () => {
    renderStrip({ tabs: [FILE_TAB, BROWSER_TAB] })
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-web'))
    expect(screen.getByText('Close others')).not.toBeDisabled()
    expect(screen.getByText('Close to the right')).toBeDisabled()
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-file'))
    expect(screen.getByText('Close to the right')).not.toBeDisabled()
  })

  it('dismisses a context menu whose target was closed elsewhere', () => {
    const { props, rerender } = renderStrip({ tabs: [FILE_TAB, BROWSER_TAB] })
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-web'))
    rerender(<WorkspaceTabStrip {...props} tabs={[FILE_TAB]} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('offers the dock move only for terminals', () => {
    const { props, unmount } = renderStrip({ tabs: [TERMINAL_TAB], activeTabId: TERMINAL_TAB.id })
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-term'))
    fireEvent.click(screen.getByText('Move to bottom panel'))
    expect(props.onMoveDock).toHaveBeenCalledWith('tab-term', 'bottom')
    unmount()

    renderStrip({ tabs: [FILE_TAB] })
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-file'))
    // Files, pages and reviews live in the side panel only; offering to move one
    // to the bottom would be an entry point to a state that cannot exist.
    expect(screen.queryByText('Move to bottom panel')).toBeNull()
  })

  it.each(['side', 'bottom'] as const)('passes the %s plus button so the picker can return focus', (dock) => {
    const { props } = renderStrip({ dock })
    const trigger = screen.getByTestId(`workspace-add-tab-${dock}`)
    fireEvent.click(trigger)
    expect(props.onAdd).toHaveBeenCalledTimes(1)
    expect(props.onAdd).toHaveBeenCalledWith(trigger)
  })

  it('exposes the plus menu expanded state and only controls a mounted menu', () => {
    const { props, rerender } = renderStrip({ addMenuId: 'resource-menu', addMenuOpen: false })
    const trigger = screen.getByTestId('workspace-add-tab-side')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).not.toHaveAttribute('aria-controls')
    expect(trigger).toHaveAttribute('aria-pressed', 'false')
    rerender(<WorkspaceTabStrip {...props} addMenuOpen />)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', 'resource-menu')
    expect(trigger).toHaveAttribute('aria-pressed', 'true')
  })

  it.each([['ArrowDown', 'first'], ['ArrowUp', 'last']] as const)('opens plus menu with %s at the %s enabled item', (key, initialFocus) => {
    const { props } = renderStrip()
    const trigger = screen.getByTestId('workspace-add-tab-side')
    const event = createEvent.keyDown(trigger, { key })
    fireEvent(trigger, event)
    expect(event.defaultPrevented).toBe(true)
    expect(props.onAdd).toHaveBeenCalledExactlyOnceWith(trigger, initialFocus)
  })

  it('reorders on drag and suppresses the click that ends the drag', () => {
    const tabs = [FILE_TAB, BROWSER_TAB, REVIEW_TAB]
    const { props } = renderStrip({ tabs })

    // jsdom reports all-zero rects, so stub the midpoints the drag reads. They
    // are measured on the wrapper: the tab button no longer spans the whole tab.
    let left = 0
    for (const tab of tabs) {
      const node = screen.getByTestId(`workspace-tab-wrap-${tab.id}`)
      const rect = { left, width: 100, right: left + 100, top: 0, bottom: 40, height: 40, x: left, y: 0 }
      node.getBoundingClientRect = () => rect as DOMRect
      left += 100
    }

    const dragged = screen.getByTestId('workspace-tab-tab-review')
    firePointer(dragged, 'pointerDown', 250)
    firePointer(dragged, 'pointerMove', 40)

    expect(props.onReorder).toHaveBeenCalledWith('tab-review', 0)

    firePointer(dragged, 'pointerUp', 40)
    fireEvent.click(dragged)
    // The click that terminates a drag is not a request to switch tabs.
    expect(props.onActivate).not.toHaveBeenCalled()
  })

  it('treats a press with no movement as a plain click', () => {
    const { props } = renderStrip({ tabs: [FILE_TAB, BROWSER_TAB] })
    const tab = screen.getByTestId('workspace-tab-tab-web')

    firePointer(tab, 'pointerDown', 100)
    firePointer(tab, 'pointerMove', 101)
    firePointer(tab, 'pointerUp', 101)
    fireEvent.click(tab)

    expect(props.onReorder).not.toHaveBeenCalled()
    expect(props.onActivate).toHaveBeenCalledWith('tab-web')
  })

  it('keeps the tab a tab: the close control is a sibling, not a child of it', () => {
    // `role="tab"` may not contain an interactive descendant. Nesting the close
    // button inside it made the tab an invalid composite and left the close
    // affordance off the keyboard entirely.
    renderStrip({ tabs: [FILE_TAB] })

    const tab = screen.getByRole('tab', { name: /adapters\.ts/ })
    expect(within(tab).queryByRole('button')).toBeNull()
    expect(screen.getByLabelText('Close adapters.ts')).toBeInTheDocument()
  })

  it('gives the active tab and its close control the only tab stops', () => {
    renderStrip({ tabs: [FILE_TAB, BROWSER_TAB], activeTabId: BROWSER_TAB.id })

    expect(screen.getByTestId('workspace-tab-tab-web')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('workspace-tab-close-tab-web')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('workspace-tab-tab-file')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByTestId('workspace-tab-close-tab-file')).toHaveAttribute('tabindex', '-1')
  })

  it('walks the strip with the arrow keys, Home and End', () => {
    // `tabIndex={isActive ? 0 : -1}` was half a roving tabindex: it took every
    // other tab out of the tab order and gave nothing back that could reach
    // them.
    const tabs = [FILE_TAB, BROWSER_TAB, REVIEW_TAB]
    const { props } = renderStrip({ tabs, activeTabId: FILE_TAB.id })

    const first = screen.getByTestId('workspace-tab-tab-file')
    const second = screen.getByTestId('workspace-tab-tab-web')
    const third = screen.getByTestId('workspace-tab-tab-review')

    act(() => { first.focus() })
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(second)
    expect(second).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(second, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(third)

    fireEvent.keyDown(third, { key: 'Home' })
    expect(document.activeElement).toBe(first)

    // Moving focus must not switch content: arrowing past a terminal tab would
    // otherwise attach its PTY on the way through.
    expect(props.onActivate).not.toHaveBeenCalled()
  })

  it('activates the focused tab with Enter', () => {
    const { props } = renderStrip({ tabs: [FILE_TAB, BROWSER_TAB], activeTabId: FILE_TAB.id })

    const second = screen.getByTestId('workspace-tab-tab-web')
    act(() => { second.focus() })
    // A native button turns Enter into a click; the assertion is that the tab
    // still is one.
    fireEvent.click(second)

    expect(props.onActivate).toHaveBeenCalledWith('tab-web')
  })

  it('says a tab has a context menu without claiming its panel is collapsed', () => {
    renderStrip({ tabs: [FILE_TAB] })
    const tab = screen.getByTestId('workspace-tab-tab-file')
    expect(tab).toHaveAttribute('aria-haspopup', 'menu')
    // On `role="tab"`, `aria-expanded` describes the tab panel, so the context
    // menu must not borrow it.
    expect(tab).not.toHaveAttribute('aria-expanded')
  })

  it('names the context menu for its own purpose, not the strip\'s', () => {
    renderStrip({ tabs: [FILE_TAB] })
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-file'))
    expect(screen.getByRole('menu', { name: 'Tab actions' })).toBeInTheDocument()
  })

  it('moves focus into the context menu and walks it', () => {
    renderStrip({ tabs: [FILE_TAB, BROWSER_TAB], canReopenClosed: true })

    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-file'))
    const menu = screen.getByTestId('workspace-tab-menu')
    const items = within(menu).getAllByRole('menuitem')

    expect(document.activeElement).toBe(items[0])

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])

    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])

    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(items[items.length - 1])
  })

  it('closes the context menu on Escape and returns focus to the tab', () => {
    renderStrip({ tabs: [FILE_TAB, BROWSER_TAB] })
    const tab = screen.getByTestId('workspace-tab-tab-file')

    fireEvent.contextMenu(tab)
    fireEvent.keyDown(screen.getByTestId('workspace-tab-menu'), { key: 'Escape' })

    expect(screen.queryByTestId('workspace-tab-menu')).toBeNull()
    expect(document.activeElement).toBe(tab)
  })

  it('skips the disabled menu item when focusing the menu', () => {
    renderStrip({ tabs: [FILE_TAB], canReopenClosed: false })

    fireEvent.contextMenu(screen.getByTestId('workspace-tab-tab-file'))
    // "Reopen closed tab" is disabled here; landing focus on it would look like
    // the menu is broken.
    expect(document.activeElement).toHaveTextContent('Close')
    expect(document.activeElement).not.toBeDisabled()
  })

  it('stands at the one workbench bar height', () => {
    // Match the file and review toolbars so switching resources does not move
    // the content boundary. The OS titlebar keeps its independent dimensions.
    renderStrip()
    expect(screen.getByTestId('workspace-tab-strip-side').className).toContain('h-10')
  })
})

describe('terminal tab chrome', () => {
  it('keeps the expanded terminal menu inside the viewport near the bottom edge', () => {
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu'
        ? { x: 0, y: 0, top: 0, left: 0, right: 210, bottom: 300, width: 210, height: 300, toJSON: () => ({}) }
        : { x: 900, y: 720, top: 720, left: 900, right: 928, bottom: 748, width: 28, height: 28, toJSON: () => ({}) }
    })
    try {
      renderStrip({ tabs: [TERMINAL_TAB], activeTabId: TERMINAL_TAB.id })
      fireEvent.keyDown(screen.getByRole('tab'), { key: 'F10', shiftKey: true })
      const menu = screen.getByRole('menu')
      expect(Number.parseFloat(menu.style.top) + 300).toBeLessThanOrEqual(window.innerHeight - 8)
      expect(menu).toHaveClass('overflow-y-auto')
    } finally {
      measure.mockRestore()
    }
  })

  it('updates the title and shell tooltip without replacing the persisted tab', async () => {
    const { getTerminalRuntime, updateTerminalRuntime, destroyTerminalRuntime } = await import('@/lib/terminalRuntime')
    const { unmount } = renderStrip({ tabs: [TERMINAL_TAB], activeTabId: TERMINAL_TAB.id })
    const runtime = getTerminalRuntime('rt-1', 'idle')
    act(() => updateTerminalRuntime(runtime, { title: 'repo — zsh', shellInfo: { cwd: '/repo/packages', shell: '/bin/zsh' } }))
    expect(screen.getByRole('tab', { name: 'repo — zsh' })).toHaveAttribute('title', '/repo/packages · /bin/zsh')
    expect(TERMINAL_TAB).not.toHaveProperty('title')
    act(() => updateTerminalRuntime(runtime, { title: '' }))
    expect(screen.getByRole('tab')).not.toHaveTextContent('repo — zsh')
    unmount()
    destroyTerminalRuntime('rt-1')
  })

  it('offers terminal actions from the visible menu and disables restart while starting', async () => {
    const { getTerminalRuntime, updateTerminalRuntime, destroyTerminalRuntime } = await import('@/lib/terminalRuntime')
    const { t } = await import('@/i18n')
    const runtime = getTerminalRuntime('rt-1', 'idle')
    const clear = vi.fn()
    const restart = vi.fn()
    const focus = vi.fn()
    const dispose = vi.fn()
    updateTerminalRuntime(runtime, { terminal: { clear, dispose, focus } as unknown as NonNullable<typeof runtime.terminal>, restart, status: 'running' })
    const { unmount } = renderStrip({ tabs: [TERMINAL_TAB], activeTabId: TERMINAL_TAB.id })
    fireEvent.click(screen.getByRole('button', { name: t('workspace.tabMenu') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('settings.terminal.clear') }))
    expect(clear).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('tab'), { key: 'F10', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: t('settings.terminal.restart') }))
    expect(restart).toHaveBeenCalledOnce()
    act(() => updateTerminalRuntime(runtime, { status: 'starting' }))
    fireEvent.click(screen.getByRole('button', { name: t('workspace.tabMenu') }))
    expect(screen.getByRole('menuitem', { name: t('settings.terminal.restart') })).toBeDisabled()
    unmount()
    destroyTerminalRuntime('rt-1')
  })
})
