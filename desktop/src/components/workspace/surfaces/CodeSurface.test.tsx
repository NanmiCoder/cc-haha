import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { CodeSurface, workspaceCodeTokenStyle } from './CodeSurface'

const previewLineLimit = vi.hoisted(() => 20)
const highlightWorkspaceCodeMock = vi.hoisted(() => vi.fn())

// The real cap is 2000 lines; shrinking it keeps the truncation cases readable.
vi.mock('../WorkspaceCodeSurface', async (importOriginal) => ({
  ...await importOriginal<typeof import('../WorkspaceCodeSurface')>(),
  WORKSPACE_PREVIEW_LINE_LIMIT: previewLineLimit,
}))

vi.mock('../workspaceDiffHighlighter', () => ({
  highlightWorkspaceCode: highlightWorkspaceCodeMock,
}))

const ROW_HEIGHT = 20
const SURFACE_HEIGHT = 100

function makeFile(lineCount: number) {
  return Array.from({ length: lineCount }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n')
}

/**
 * jsdom has no layout: every rect is zero and `clientHeight` is always 0, so the
 * centring maths in the reveal effect would be unobservable. Patch the
 * prototypes before render — the effect reads them on mount, which is earlier
 * than anything the render body could stub.
 */
function stubSurfaceLayout(rowHeight = ROW_HEIGHT) {
  const originalRect = Element.prototype.getBoundingClientRect
  const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')

  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const line = Number(this.getAttribute('data-workspace-line-number'))
    const isRow = Number.isFinite(line) && line > 0
    const top = isRow ? line * rowHeight : 0
    const height = isRow ? rowHeight : SURFACE_HEIGHT
    return {
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  }
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => SURFACE_HEIGHT,
  })

  return () => {
    Element.prototype.getBoundingClientRect = originalRect
    if (originalClientHeight) Object.defineProperty(Element.prototype, 'clientHeight', originalClientHeight)
    else delete (Element.prototype as { clientHeight?: number }).clientHeight
  }
}

function renderSurface(props: Partial<Parameters<typeof CodeSurface>[0]> = {}) {
  return render(
    <CodeSurface
      value={props.value ?? 'const a = 1\nconst b = 2\nconst c = 3'}
      language={props.language ?? 'typescript'}
      reveal={props.reveal}
      revealScroll={props.revealScroll}
      onAddLineComment={props.onAddLineComment ?? vi.fn()}
      onAddSelection={props.onAddSelection ?? vi.fn()}
    />,
  )
}

describe('CodeSurface', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    highlightWorkspaceCodeMock.mockReset()
    highlightWorkspaceCodeMock.mockResolvedValue({ engine: 'plain', tokensByLine: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('numbers every rendered line with a gutter button', () => {
    renderSurface()

    expect(screen.getByRole('button', { name: 'Comment line 1' })).toHaveTextContent('1')
    expect(screen.getByRole('button', { name: 'Comment line 3' })).toHaveTextContent('3')
    expect(screen.queryByRole('button', { name: 'Comment line 4' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-code').textContent).toContain('const c = 3')
  })

  it('keeps the screenshot code rhythm and centers revealed lines using its measured 26px rows', () => {
    const restore = stubSurfaceLayout(26)
    try {
      renderSurface({ value: makeFile(12), reveal: { line: 10, nonce: 9 } })
      const code = screen.getByTestId('workspace-code')
      expect(code.closest('pre')).toHaveClass('text-[15px]', 'leading-[26px]')
      expect(code.closest('[data-workspace-scroll-surface]')!.scrollTop).toBe(223)
    } finally {
      restore()
    }
  })

  it('caps a long preview and expands it on demand', async () => {
    renderSurface({ value: makeFile(previewLineLimit + 3) })

    expect(screen.getByTestId('workspace-code').textContent).toContain('const line20 = 20')
    expect(screen.getByTestId('workspace-code').textContent).not.toContain('const line21 = 21')
    expect(screen.getByText('Showing first 20 of 23 loaded lines.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show all loaded lines' }))

    await waitFor(() => {
      expect(screen.getByTestId('workspace-code').textContent).toContain('const line23 = 23')
    })
    expect(screen.getByText('Showing all 23 loaded lines.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse preview' }))
    expect(screen.getByTestId('workspace-code').textContent).not.toContain('const line23 = 23')
  })

  it('leaves the expand control off a preview that fits', () => {
    renderSurface({ value: makeFile(previewLineLimit) })

    expect(screen.queryByRole('button', { name: 'Show all loaded lines' })).not.toBeInTheDocument()
  })

  it('marks the revealed line and scrolls it to the middle of the surface', async () => {
    const restoreLayout = stubSurfaceLayout()
    try {
      const { container } = renderSurface({ value: makeFile(30), reveal: { line: 10, nonce: 1 } })
      const surface = container.firstElementChild as HTMLElement

      const revealed = screen.getByTestId('workspace-code').querySelector('[data-workspace-line-number="10"]')
      expect(revealed?.className).toContain('bg-[var(--color-brand-soft)]')
      expect(revealed?.className).toContain('shadow-[inset_2px_0_0_var(--color-brand)]')
      expect(screen.getByTestId('workspace-code')
        .querySelector('[data-workspace-line-number="9"]')?.className)
        .toContain('hover:bg-[var(--color-surface-hover)]')

      // row top (200) - surface top (0) - half the viewport (50) + half the row (10)
      await waitFor(() => {
        expect(surface.scrollTop).toBe(160)
      })
    } finally {
      restoreLayout()
    }
  })

  it('re-scrolls when the same line is revealed again under a new nonce', async () => {
    // #1146 follow-up: clicking `foo.ts:10` twice has to jump back to line 10 the
    // second time. The line alone is an unchanged effect dependency, so the nonce
    // is the only thing that can retrigger the scroll.
    const restoreLayout = stubSurfaceLayout()
    try {
      const { container, rerender } = render(
        <CodeSurface
          value={makeFile(30)}
          language="typescript"
          reveal={{ line: 10, nonce: 1 }}
          onAddLineComment={vi.fn()}
          onAddSelection={vi.fn()}
        />,
      )
      const surface = container.firstElementChild as HTMLElement
      await waitFor(() => {
        expect(surface.scrollTop).toBe(160)
      })

      // The user scrolls away, then clicks the same reference again.
      surface.scrollTop = 0
      rerender(
        <CodeSurface
          value={makeFile(30)}
          language="typescript"
          reveal={{ line: 10, nonce: 1 }}
          onAddLineComment={vi.fn()}
          onAddSelection={vi.fn()}
        />,
      )
      expect(surface.scrollTop).toBe(0)

      rerender(
        <CodeSurface
          value={makeFile(30)}
          language="typescript"
          reveal={{ line: 10, nonce: 2 }}
          onAddLineComment={vi.fn()}
          onAddSelection={vi.fn()}
        />,
      )
      await waitFor(() => {
        expect(surface.scrollTop).toBe(160)
      })
    } finally {
      restoreLayout()
    }
  })

  it('keeps a restored viewport while retaining the old reveal mark', async () => {
    const restoreLayout = stubSurfaceLayout()
    try {
      const { container } = renderSurface({ value: makeFile(30), reveal: { line: 10, nonce: 1 }, revealScroll: false })
      const surface = container.firstElementChild as HTMLElement
      surface.scrollTop = 40
      await act(async () => { await Promise.resolve() })
      expect(surface.scrollTop).toBe(40)
      expect(screen.getByTestId('workspace-code').querySelector('[data-workspace-line-number="10"]')?.className)
        .toContain('bg-[var(--color-brand-soft)]')
    } finally {
      restoreLayout()
    }
  })

  it('expands a truncated preview when the revealed line is past the fold', async () => {
    // The row the reference points at is not rendered at all while the preview is
    // capped, so the reveal has to lift the cap before it can mark anything.
    const revealLine = previewLineLimit + 5
    renderSurface({ value: makeFile(previewLineLimit + 10), reveal: { line: revealLine, nonce: 1 } })

    await waitFor(() => {
      expect(screen.getByTestId('workspace-code').textContent)
        .toContain(`const line${revealLine} = ${revealLine}`)
    })
    expect(screen.getByTestId('workspace-code')
      .querySelector(`[data-workspace-line-number="${revealLine}"]`)?.className)
      .toContain('bg-[var(--color-brand-soft)]')
  })

  it('collapses back to the cap when a reload replaces the file', async () => {
    const { rerender } = renderSurface({ value: makeFile(previewLineLimit + 3) })
    fireEvent.click(screen.getByRole('button', { name: 'Show all loaded lines' }))
    await waitFor(() => {
      expect(screen.getByTestId('workspace-code').textContent).toContain('const line23 = 23')
    })

    rerender(
      <CodeSurface
        value={`${makeFile(previewLineLimit + 3)}\n`}
        language="typescript"
        onAddLineComment={vi.fn()}
        onAddSelection={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Show all loaded lines' })).toBeInTheDocument()
  })

  it('sends a gutter comment to the chat with the quoted line', async () => {
    const onAddLineComment = vi.fn()
    renderSurface({ onAddLineComment })

    fireEvent.click(screen.getByRole('button', { name: 'Comment line 2' }))
    const editor = await screen.findByPlaceholderText('Describe what should change here...')
    fireEvent.change(editor, { target: { value: 'rename this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    expect(onAddLineComment).toHaveBeenCalledWith(2, 2, 'rename this', 'const b = 2')
  })

  it('renders shiki tokens with their colour and font style once highlighting resolves', async () => {
    highlightWorkspaceCodeMock.mockResolvedValue({
      engine: 'shiki',
      tokensByLine: [[{ content: 'const a = 1', color: '#ff0000', fontStyle: 3 }]],
    })

    await act(async () => {
      render(
        <CodeSurface
          value="const a = 1"
          language="typescript"
          onAddLineComment={vi.fn()}
          onAddSelection={vi.fn()}
        />,
      )
    })

    await waitFor(() => {
      expect(screen.getByTestId('workspace-code')).toHaveAttribute('data-highlight-engine', 'shiki')
    })
    const token = screen.getByTestId('workspace-code').querySelector('[data-workspace-token]')
    expect(token).toHaveStyle({ color: '#ff0000', fontStyle: 'italic', fontWeight: '700' })
  })
})

describe('workspaceCodeTokenStyle', () => {
  it('maps the shiki font-style bitmask onto CSS', () => {
    expect(workspaceCodeTokenStyle({ content: 'a', color: '#111' }))
      .toEqual({ color: '#111', fontStyle: undefined, fontWeight: undefined })
    expect(workspaceCodeTokenStyle({ content: 'a', color: '#111', fontStyle: 1 }).fontStyle).toBe('italic')
    expect(workspaceCodeTokenStyle({ content: 'a', color: '#111', fontStyle: 2 }).fontWeight).toBe(700)
    expect(workspaceCodeTokenStyle({ content: 'a', color: '#111', fontStyle: 4 }))
      .toEqual({ color: '#111', fontStyle: undefined, fontWeight: undefined })
  })
})
