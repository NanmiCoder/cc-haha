import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getSelectionPopoverPosition, useSelectionPopoverDismiss } from './useSelectionPopoverDismiss'

// Workspace surfaces size the menu 140x32 and float it 10px off the selection;
// the chat toolbar uses its own numbers (see components/workspace/surfaces/textSelection.ts
// and components/chat/MessageList.tsx). The placement rule itself is shared.
const MENU = { menuWidth: 140, menuHeight: 32, offset: 10 }

function rect(left: number, top: number, right: number, bottom: number) {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

function renderLines(lines: string[]) {
  const root = document.createElement('div')
  for (const line of lines) {
    const row = document.createElement('div')
    row.textContent = line
    root.appendChild(row)
  }
  document.body.appendChild(root)
  return root
}

function textNodeOf(row: Element) {
  const node = row.firstChild
  if (!node) throw new Error('row has no text node')
  return node
}

/**
 * A two-line selection whose last line ends at x=200, leaving the whole right
 * half of the 1024px viewport free, and whose first line starts at y=100.
 */
function renderTwoLineSelection() {
  const root = renderLines(['first selected line', 'second selected line'])
  Object.assign(root, { getBoundingClientRect: () => rect(100, 24, 520, 420) })

  const first = textNodeOf(root.children[0]!)
  const last = textNodeOf(root.children[1]!)
  const range = document.createRange()
  range.setStart(first, 0)
  range.setEnd(last, last.textContent!.length)
  Object.assign(range, {
    // Two client rects is how the browser reports a selection it wrapped
    // across two lines.
    getClientRects: () => [rect(120, 100, 500, 118), rect(120, 122, 200, 140)],
    getBoundingClientRect: () => rect(120, 100, 500, 140),
  })

  return { root, range }
}

function positionFor(root: HTMLElement, range: Range, preferAbove?: boolean) {
  return getSelectionPopoverPosition(range, root, {
    ...MENU,
    selectionFocus: { node: null, offset: 0 },
    ...(preferAbove === undefined ? {} : { preferAbove }),
  })
}

describe('getSelectionPopoverPosition', () => {
  it('places a multi-line selection menu beside the selection by default', () => {
    const { root, range } = renderTwoLineSelection()

    // The default is the upstream rule: a multi-line range goes to the right of
    // where it ends, i.e. the end of the last selected line (200 + 10) centred
    // vertically on that line (122 + 9 - 16). Callers opt out per user setting.
    expect(positionFor(root, range)).toEqual({ x: 210, y: 115 })
  })

  it('places a multi-line selection menu above the selection when asked to', () => {
    const { root, range } = renderTwoLineSelection()

    // The right-side slot sits in the reader's path, so this mode floats the
    // menu above the whole selection instead: centred on it (120..500) and
    // clear of its first line (top 100 - 32 - 10).
    expect(positionFor(root, range, true)).toEqual({ x: 240, y: 58 })
  })

  it('keeps a single-line selection menu above the selection in either mode', () => {
    const root = renderLines(['one line only'])
    Object.assign(root, { getBoundingClientRect: () => rect(100, 24, 520, 420) })

    const line = textNodeOf(root.children[0]!)
    const range = document.createRange()
    range.setStart(line, 0)
    range.setEnd(line, line.textContent!.length)
    Object.assign(range, {
      getClientRects: () => [rect(120, 100, 240, 118)],
      getBoundingClientRect: () => rect(120, 100, 240, 118),
    })

    expect(positionFor(root, range)).toEqual({ x: 110, y: 58 })
    expect(positionFor(root, range, true)).toEqual({ x: 110, y: 58 })
  })
})


it.each([false, true])('supports preserving native selections on scroll: %s', (preserve) => {
  const root = document.createElement('p')
  root.textContent = 'selected text'
  document.body.append(root)
  const range = document.createRange()
  range.selectNodeContents(root)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  const onDismiss = vi.fn()
  const onScroll = preserve ? vi.fn() : undefined
  const { unmount } = renderHook(() => useSelectionPopoverDismiss({ active: true, popoverRef: { current: null }, onDismiss, onScroll }))
  act(() => document.dispatchEvent(new Event('scroll')))
  expect(document.getSelection()?.toString()).toBe(preserve ? 'selected text' : '')
  expect(onDismiss).toHaveBeenCalledTimes(preserve ? 0 : 1)
  if (onScroll) expect(onScroll).toHaveBeenCalledOnce()
  unmount()
  document.getSelection()?.removeAllRanges()
  root.remove()
})
