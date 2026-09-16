import { beforeEach, describe, expect, it } from 'vitest'
import {
  getElementForNode,
  getLineNumberFromNode,
  getLineRangeForText,
  getSelectionPosition,
  getTextSelectionFromContainer,
} from './textSelection'

function stubRect(target: object, rect: { left: number; top: number; right: number; bottom: number }) {
  Object.assign(target, {
    getBoundingClientRect: () => ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  })
}

function renderCodeRows(lines: string[]) {
  const root = document.createElement('div')
  for (const [index, line] of lines.entries()) {
    const row = document.createElement('div')
    row.setAttribute('data-workspace-line-number', String(index + 1))
    row.textContent = line
    root.appendChild(row)
  }
  document.body.appendChild(root)
  return root
}

function findTextNode(row: Element) {
  const node = row.firstChild
  if (!node) throw new Error('row has no text node')
  return node
}

describe('getLineRangeForText', () => {
  const value = ['alpha', 'beta', 'gamma', 'delta'].join('\n')

  it('reports the 1-based line span of a single-line match', () => {
    expect(getLineRangeForText(value, 'gamma')).toEqual({ startLine: 3, endLine: 3 })
  })

  it('spans every line a multi-line match covers', () => {
    expect(getLineRangeForText(value, 'beta\ngamma')).toEqual({ startLine: 2, endLine: 3 })
  })

  it('returns no range when the text is not in the document', () => {
    // The selection may come from rendered Markdown that no longer matches the
    // raw source; the caller then falls back to the DOM line numbers.
    expect(getLineRangeForText(value, 'epsilon')).toEqual({})
  })
})

describe('getElementForNode', () => {
  it('returns the element itself and the parent of a text node', () => {
    const root = renderCodeRows(['const a = 1'])
    const row = root.firstElementChild!

    expect(getElementForNode(row)).toBe(row)
    expect(getElementForNode(findTextNode(row))).toBe(row)
    expect(getElementForNode(null)).toBeNull()
  })
})

describe('getLineNumberFromNode', () => {
  it('reads the line number off the nearest annotated row', () => {
    const root = renderCodeRows(['const a = 1', 'const b = 2'])

    expect(getLineNumberFromNode(findTextNode(root.children[1]!), root)).toBe(2)
  })

  it('ignores rows outside the surface it was given', () => {
    const root = renderCodeRows(['const a = 1'])
    const foreign = renderCodeRows(['const b = 2'])

    expect(getLineNumberFromNode(findTextNode(foreign.firstElementChild!), root)).toBeUndefined()
  })
})

describe('getSelectionPosition', () => {
  it('places the menu above the selection, centred on it', () => {
    const root = renderCodeRows(['const a = 1'])
    stubRect(root, { left: 100, top: 24, right: 520, bottom: 420 })
    const range = document.createRange()
    range.setStart(findTextNode(root.firstElementChild!), 0)
    range.setEnd(findTextNode(root.firstElementChild!), 5)
    stubRect(range, { left: 120, top: 100, right: 240, bottom: 118 })

    const position = getSelectionPosition(
      range,
      root,
      { focusNode: null, focusOffset: 0 } as unknown as Selection,
    )

    // Centred on the selection (180) minus half the 158px menu, one menu height
    // plus the 10px offset above the selection top.
    expect(position).toEqual({ x: 101, y: 46 })
  })

  it('keeps the menu inside the viewport when the selection hugs the left edge', () => {
    const root = renderCodeRows(['const a = 1'])
    stubRect(root, { left: 0, top: 24, right: 520, bottom: 420 })
    const range = document.createRange()
    range.setStart(findTextNode(root.firstElementChild!), 0)
    range.setEnd(findTextNode(root.firstElementChild!), 5)
    stubRect(range, { left: 0, top: 100, right: 20, bottom: 118 })

    const position = getSelectionPosition(
      range,
      root,
      { focusNode: null, focusOffset: 0 } as unknown as Selection,
    )

    expect(position.x).toBe(12)
  })
})

describe('getTextSelectionFromContainer', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  it('returns the selected text with the line span it covers', () => {
    const root = renderCodeRows(['const a = 1', 'const b = 2', 'const c = 3'])
    stubRect(root, { left: 100, top: 24, right: 520, bottom: 420 })
    const range = document.createRange()
    range.setStart(findTextNode(root.children[0]!), 0)
    range.setEnd(findTextNode(root.children[1]!), 11)
    stubRect(range, { left: 120, top: 100, right: 240, bottom: 118 })
    window.getSelection()!.addRange(range)

    const selection = getTextSelectionFromContainer(root)

    expect(selection?.text).toBe('const a = 1const b = 2')
    expect(selection?.startLine).toBe(1)
    expect(selection?.endLine).toBe(2)
  })

  it('orders the line span when the selection was dragged upwards', () => {
    const root = renderCodeRows(['const a = 1', 'const b = 2', 'const c = 3'])
    stubRect(root, { left: 100, top: 24, right: 520, bottom: 420 })
    const range = document.createRange()
    range.setStart(findTextNode(root.children[0]!), 0)
    range.setEnd(findTextNode(root.children[2]!), 11)
    stubRect(range, { left: 120, top: 100, right: 240, bottom: 118 })
    window.getSelection()!.addRange(range)

    const selection = getTextSelectionFromContainer(
      root,
      () => ({ startLine: 3, endLine: 1 }),
    )

    expect(selection?.startLine).toBe(1)
    expect(selection?.endLine).toBe(3)
  })

  it('prefers the resolver line range over the DOM row numbers', () => {
    const root = renderCodeRows(['const a = 1', 'const b = 2'])
    stubRect(root, { left: 100, top: 24, right: 520, bottom: 420 })
    const range = document.createRange()
    range.setStart(findTextNode(root.children[0]!), 0)
    range.setEnd(findTextNode(root.children[0]!), 11)
    stubRect(range, { left: 120, top: 100, right: 240, bottom: 118 })
    window.getSelection()!.addRange(range)

    const selection = getTextSelectionFromContainer(root, () => ({ startLine: 40, endLine: 42 }))

    expect(selection?.startLine).toBe(40)
    expect(selection?.endLine).toBe(42)
  })

  it('ignores a selection that is not inside the surface', () => {
    const root = renderCodeRows(['const a = 1'])
    const outside = renderCodeRows(['const b = 2'])
    const range = document.createRange()
    range.setStart(findTextNode(outside.firstElementChild!), 0)
    range.setEnd(findTextNode(outside.firstElementChild!), 5)
    window.getSelection()!.addRange(range)

    expect(getTextSelectionFromContainer(root)).toBeNull()
    expect(getTextSelectionFromContainer(null)).toBeNull()
  })

  it('ignores a collapsed selection', () => {
    const root = renderCodeRows(['const a = 1'])
    const range = document.createRange()
    range.setStart(findTextNode(root.firstElementChild!), 3)
    range.collapse(true)
    window.getSelection()!.addRange(range)

    expect(getTextSelectionFromContainer(root)).toBeNull()
  })
})
