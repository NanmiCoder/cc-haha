import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { MarkdownSurface } from './MarkdownSurface'

function renderSurface(props: Partial<Parameters<typeof MarkdownSurface>[0]> = {}) {
  return render(
    <MarkdownSurface
      value={props.value ?? '# Title'}
      path={props.path ?? 'docs/guide.md'}
      sessionId={props.sessionId ?? 'session-1'}
      workDir={props.workDir ?? '/work'}
      onAddSelection={props.onAddSelection ?? vi.fn()}
    />,
  )
}

function imageSources(container: HTMLElement) {
  return Array.from(container.querySelectorAll('img')).map((image) => image.getAttribute('src'))
}

describe('MarkdownSurface', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('resolves a relative image against the document directory instead of leaving it raw', () => {
    // A bare `img/shot.png` would resolve against the app origin and 404; the
    // workspace resolver rewrites it to the sandboxed session file route.
    const { container } = renderSurface({
      value: '![shot](img/shot.png)',
      path: 'docs/guide.md',
    })

    const [src] = imageSources(container)
    expect(src).not.toBe('img/shot.png')
    expect(src).toContain('/preview-fs/session-1/docs/img/shot.png')
  })

  it('walks the document directory up for a parent-relative image', () => {
    const { container } = renderSurface({
      value: '![logo](../assets/logo.png)',
      path: 'docs/guide.md',
    })

    expect(imageSources(container)[0]).toContain('/preview-fs/session-1/assets/logo.png')
  })

  it('sends an absolute image path through the local-file route', () => {
    const { container } = renderSurface({
      value: '![shot](/Users/me/shot.png)',
    })

    expect(imageSources(container)[0]).toContain('/local-file/')
  })

  it('leaves remote and inline images untouched', () => {
    const { container } = renderSurface({
      value: [
        '![badge](https://img.shields.io/badge/stars-1k.svg)',
        '![inline](data:image/png;base64,iVBORw0KGgo=)',
      ].join('\n\n'),
    })

    expect(imageSources(container)).toEqual([
      'https://img.shields.io/badge/stars-1k.svg',
      'data:image/png;base64,iVBORw0KGgo=',
    ])
  })

  it('rebuilds the resolver when the document changes so images follow the new file', () => {
    const { container, rerender } = renderSurface({
      value: '![shot](img/shot.png)',
      path: 'docs/guide.md',
    })
    expect(imageSources(container)[0]).toContain('/preview-fs/session-1/docs/img/shot.png')

    rerender(
      <MarkdownSurface
        value={'![shot](img/shot.png)'}
        path="manual/intro.md"
        sessionId="session-1"
        workDir="/work"
        onAddSelection={vi.fn()}
      />,
    )

    expect(imageSources(container)[0]).toContain('/preview-fs/session-1/manual/img/shot.png')
  })

  it('adds a selection to the chat with the line range it covers in the source', async () => {
    // The rendered prose has no line numbers, so the range has to come from the
    // raw Markdown the surface was given.
    const onAddSelection = vi.fn()
    const value = ['# Title', '', 'alpha paragraph', '', 'beta paragraph'].join('\n')
    const { container } = renderSurface({ value, onAddSelection })
    const surface = container.firstElementChild as HTMLElement

    const paragraph = screen.getByText('beta paragraph')
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, 0)
    range.setEnd(paragraph.firstChild!, 'beta paragraph'.length)
    Object.assign(range, {
      getBoundingClientRect: () => ({
        left: 130, top: 60, right: 260, bottom: 78, width: 130, height: 18, x: 130, y: 60, toJSON: () => ({}),
      }),
    })
    Object.assign(surface, {
      getBoundingClientRect: () => ({
        left: 100, top: 24, right: 520, bottom: 420, width: 420, height: 396, x: 100, y: 24, toJSON: () => ({}),
      }),
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    await act(async () => {
      fireEvent.mouseUp(surface, { clientX: 190, clientY: 80 })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))

    expect(onAddSelection).toHaveBeenCalledWith({
      text: 'beta paragraph',
      startLine: 5,
      endLine: 5,
    })
  })

  it('keeps the selection menu closed for a right-click', async () => {
    const value = 'alpha paragraph'
    const { container } = renderSurface({ value })
    const surface = container.firstElementChild as HTMLElement

    const paragraph = screen.getByText('alpha paragraph')
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, 0)
    range.setEnd(paragraph.firstChild!, 5)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)

    await act(async () => {
      fireEvent.mouseUp(surface, { button: 2, clientX: 190, clientY: 80 })
    })

    expect(screen.queryByRole('button', { name: 'Add to chat' })).not.toBeInTheDocument()
  })
})
