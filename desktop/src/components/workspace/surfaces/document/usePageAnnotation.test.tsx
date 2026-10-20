import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPageSelection, usePageAnnotation } from './usePageAnnotation'

const mounted: HTMLElement[] = []
afterEach(async () => {
  window.getSelection()?.removeAllRanges()
  await new Promise((resolve) => setTimeout(resolve, 0))
  mounted.splice(0).forEach((node) => node.remove())
})
function pages(frame?: HTMLIFrameElement) {
  const doc = frame?.contentDocument ?? document
  const root = doc.createElement('div')
  root.innerHTML = frame
    ? '<section class="docx"><p>first</p></section><section class="docx"><p>second</p></section>'
    : '<section data-document-page="2"><p>first</p></section><section data-document-page="3"><p>second</p></section>'
  doc.body.append(root)
  mounted.push(root)
  const range = doc.createRange()
  range.setStart(root.querySelectorAll('p')[0]!.firstChild!, 0)
  range.setEnd(root.querySelectorAll('p')[1]!.firstChild!, 6)
  doc.getSelection()!.removeAllRanges()
  doc.getSelection()!.addRange(range)
  return { root, range }
}

describe('page annotations', () => {
  it('unmounts safely after a selected Word frame has been removed', async () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    mounted.push(frame)
    const { root } = pages(frame)
    const rootRef = { current: frame }
    const onAnnotate = vi.fn()
    const { result, unmount } = renderHook(() => usePageAnnotation({ rootRef, frame, identity: 1, path: 'report.docx', onAnnotate }))
    act(() => root.ownerDocument.dispatchEvent(new Event('selectionchange')))
    expect(result.current.selection?.text).toBe('firstsecond')
    // React removes the iframe before passive effect cleanup. The closed frame
    // must not receive a new selectionchange task from that cleanup.
    frame.remove()
    unmount()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('includes both page endpoints and rejects ranges outside the viewer', () => {
    const { root, range } = pages()
    expect(readPageSelection(root)).toMatchObject({ text: 'firstsecond', location: 'Pages 2–3' })
    range.setEnd(document.body, document.body.childNodes.length)
    expect(readPageSelection(root)).toBeNull()
  })

  it('reads Word from its own document and translates frame geometry to the outer viewport', () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    mounted.push(frame)
    const { root, range } = pages(frame)
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 100, 400, 600))
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => new DOMRect(30, 80, 80, 20) })
    const result = readPageSelection(root, frame)
    expect(result).toMatchObject({ text: 'firstsecond', location: 'Pages 1–2', x: 200, y: 138 })
  })

  it('clears saved selections on document replacement and removes listeners on unmount', () => {
    const { root } = pages()
    const rootRef = { current: root }
    const onAnnotate = vi.fn()
    const { result, rerender, unmount } = renderHook(({ identity }) => usePageAnnotation({ rootRef, identity, path: '/report.pdf', onAnnotate }), { initialProps: { identity: 1 } })
    act(() => document.dispatchEvent(new Event('selectionchange')))
    expect(result.current.selection?.location).toBe('Pages 2–3')
    rerender({ identity: 2 })
    expect(result.current.selection).toBeNull()
    expect(window.getSelection()?.isCollapsed).toBe(true)
    const remove = vi.spyOn(document, 'removeEventListener')
    unmount()
    expect(remove).toHaveBeenCalledWith('selectionchange', expect.any(Function))
    remove.mockRestore()
  })
})

describe('dragging page selections', () => {
  it.each(['pdf', 'word'] as const)('keeps %s ranges during scrolling and shows the final range after release', (kind) => {
    const frame = kind === 'word' ? document.createElement('iframe') : undefined
    if (frame) { document.body.append(frame); mounted.push(frame) }
    const { root } = pages(frame)
    const doc = root.ownerDocument
    const rootRef = { current: frame ?? root }
    const onAnnotate = vi.fn()
    const { result, unmount } = renderHook(() => usePageAnnotation({ rootRef, frame, identity: 1, path: 'report', onAnnotate }))
    act(() => root.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 })))
    act(() => doc.dispatchEvent(new Event('selectionchange')))
    expect(result.current.selection).toBeNull()
    act(() => document.dispatchEvent(new Event('scroll')))
    expect(doc.getSelection()?.toString()).toBe('firstsecond')
    // Release may occur outside the Word iframe.
    act(() => document.dispatchEvent(new Event('pointerup')))
    expect(result.current.selection?.text).toBe('firstsecond')
    // Momentum scrolling after release repositions the menu without losing text.
    act(() => document.dispatchEvent(new Event('scroll')))
    expect(doc.getSelection()?.toString()).toBe('firstsecond')
    expect(result.current.selection?.text).toBe('firstsecond')
    act(() => result.current.add())
    expect(onAnnotate).toHaveBeenCalledWith({ text: 'firstsecond', location: kind === 'word' ? 'Pages 1–2' : 'Pages 2–3' })
    expect(doc.getSelection()?.isCollapsed).toBe(true)
    unmount()
  })

  it('cancels a pointer gesture without leaving keyboard selections suppressed', () => {
    const { root } = pages()
    const rootRef = { current: root }
    const onAnnotate = vi.fn()
    const { result, unmount } = renderHook(() => usePageAnnotation({ rootRef, identity: 1, path: 'report', onAnnotate }))
    act(() => root.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    act(() => document.dispatchEvent(new Event('pointercancel')))
    expect(result.current.selection).toBeNull()
    expect(document.getSelection()?.isCollapsed).toBe(true)
    const range = document.createRange()
    range.selectNodeContents(root.querySelector('p')!)
    act(() => { document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
    expect(result.current.selection?.text).toBe('first')
    unmount()
  })
})


it('waits for release when starting a new drag with an existing menu', () => {
  const { root } = pages()
  const rootRef = { current: root }
  const onAnnotate = vi.fn()
  const { result, unmount } = renderHook(() => usePageAnnotation({ rootRef, identity: 1, path: 'report', onAnnotate }))
  act(() => document.dispatchEvent(new Event('selectionchange')))
  expect(result.current.selection).not.toBeNull()
  act(() => root.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
  const range = document.createRange()
  range.selectNodeContents(root.querySelector('p')!)
  act(() => { document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
  expect(result.current.selection).toBeNull()
  act(() => document.dispatchEvent(new Event('pointerup')))
  expect(result.current.selection?.text).toBe('first')
  unmount()
})
