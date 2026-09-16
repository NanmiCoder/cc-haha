import { useCallback, useEffect, type KeyboardEvent, type RefObject } from 'react'

/**
 * Keyboard and focus behaviour for the workspace's own popup menus.
 *
 * The three menus in this directory (tab context menu, review comparison
 * picker, file "open with") each opened as a floating `role="menu"` that no
 * keyboard could reach: focus stayed on the trigger, so Tab walked past the
 * open menu into the page behind it and Escape left focus nowhere.
 *
 * The items are queried from the DOM rather than passed in, because one of the
 * three fills its menu from a component this directory does not own. Anything
 * carrying `role="menuitem"` participates, which is also what assistive tech
 * walks.
 */
export type MenuKeyboardOptions = {
  open: boolean
  menuRef: RefObject<HTMLElement | null>
  /** Focus returns here when the menu closes. */
  triggerRef?: RefObject<HTMLElement | null>
  onClose: () => void
  initialFocus?: 'first' | 'last'
  loop?: boolean
}

function menuItemsOf(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .filter((item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true')
}

export function useMenuKeyboard({
  open,
  menuRef,
  triggerRef,
  onClose,
  initialFocus = 'first',
  loop = true,
}: MenuKeyboardOptions): (event: KeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    if (!open) return
    const items = menuItemsOf(menuRef.current)
    items[initialFocus === 'last' ? items.length - 1 : 0]?.focus()
    return () => {
      // Only reclaim focus the menu itself was holding. A click that lands
      // somewhere else already moved focus on purpose, and stealing it back to
      // the trigger would undo the user's own navigation. By the time this
      // cleanup runs the menu is gone, so a focus that left with it reads as
      // `body`.
      const active = document.activeElement
      if (active === null || active === document.body) triggerRef?.current?.focus()
    }
  }, [initialFocus, menuRef, open, triggerRef])

  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    const items = menuItemsOf(menuRef.current)
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)

    const focusAt = (next: number) => {
      event.preventDefault()
      items[Math.max(0, Math.min(items.length - 1, next))]?.focus()
    }

    switch (event.key) {
      case 'ArrowDown':
        focusAt(index < 0 || (loop && index === items.length - 1) ? 0 : index + 1)
        break
      case 'ArrowUp':
        focusAt(index < 0 || (loop && index === 0) ? items.length - 1 : index - 1)
        break
      case 'Home':
        focusAt(0)
        break
      case 'End':
        focusAt(items.length - 1)
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
      case 'Tab':
        // Tab is a request to leave. Closing first keeps the menu from
        // outliving the focus that opened it.
        onClose()
        break
      default:
        break
    }
  }, [loop, menuRef, onClose])
}
