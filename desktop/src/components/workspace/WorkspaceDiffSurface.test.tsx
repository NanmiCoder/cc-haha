import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { WorkspaceDiffSurface } from './WorkspaceDiffSurface'
import {
  WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD,
  WORKSPACE_PREVIEW_LINE_LIMIT,
  WorkspaceDiffSurface as ExportedWorkspaceDiffSurface,
} from './WorkspaceCodeSurface'

const highlightRequestSpy = vi.hoisted(() => vi.fn())

vi.mock('./workspaceDiffHighlightRuntime', () => {
  return {
    createWorkspaceDiffHighlightCacheKey: (path: string, value: string) => `${path}:${value}`,
    requestWorkspaceDiffHighlight: highlightRequestSpy,
  }
})

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,2 +10,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  '@@ -20 +21 @@',
  '-old tail',
  '+new tail',
].join('\n')

function getCodeRow(text: string) {
  const row = document.querySelector(`[data-row-text="${text}"]`)
  expect(row).not.toBeNull()
  return row!
}

function createHighlightResult(files: Array<{ rows: Array<{ id: string; text: string; selectable: boolean }> }>) {
  const tokensByRowId: Record<string, Array<{ content: string; color: string }>> = {}
  files.flatMap((file) => file.rows)
    .filter((row) => row.selectable)
    .forEach((row) => {
      tokensByRowId[row.id] = row.text.split(/(const)/).filter(Boolean).map((content) => ({
        content,
        color: content === 'const'
          ? 'var(--color-diff-syntax-keyword)'
          : 'var(--color-diff-syntax-foreground)',
      }))
    })
  return { engine: 'shiki', tokensByRowId, wordRangesByRowId: {} }
}

describe('WorkspaceDiffSurface', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    highlightRequestSpy.mockReset()
    highlightRequestSpy.mockImplementation(() => new Promise(() => {}))
  })

  it('keeps one scroll surface while hiding redundant single-file patch chrome', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" hideSingleFileHeader />)

    const scrollSurface = screen.getByTestId('workspace-diff-scroll')
    expect(scrollSurface.className).toContain('min-h-0')
    expect(scrollSurface.className).toContain('overflow-auto')
    expect(scrollSurface).toHaveStyle({ containerType: 'inline-size' })
    expect(screen.getByTestId('workspace-diff-content').className).toContain('w-max')
    expect(screen.queryByTestId('workspace-diff-file-header')).not.toBeInTheDocument()
    expect(screen.queryByText('--- a/src/a.ts')).not.toBeInTheDocument()
    expect(screen.queryByText('+++ b/src/a.ts')).not.toBeInTheDocument()
    expect(screen.getByText('@@ -10,2 +10,3 @@')).toBeInTheDocument()
    expect(getCodeRow('const a = 1')).toBeInTheDocument()
  })

  it('does not spend the visible line limit on hidden single-file patch metadata', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" hideSingleFileHeader lineLimit={2} />)

    expect(screen.getByText('@@ -10,2 +10,3 @@')).toBeInTheDocument()
    expect(getCodeRow('const a = 1')).toBeInTheDocument()
    expect(document.querySelector('[data-row-text="const b = 2"]')).not.toBeInTheDocument()
  })

  it('uses the Codex-style compact number gutter without a dedicated comment column', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)

    const code = screen.getByTestId('workspace-code')
    const row = getCodeRow('const b = 3').closest<HTMLElement>('[data-diff-row-id]')
    const gutter = row?.querySelector<HTMLElement>('[data-diff-number-gutter]')
    const commentButton = screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' })

    expect(code.style.getPropertyValue('--workspace-diff-gutter-width')).toBe('6ch')
    expect(row).toHaveStyle({
      gridTemplateColumns: 'var(--workspace-diff-gutter-width) minmax(max-content, 1fr)',
    })
    expect(gutter).toHaveTextContent('11')
    expect(gutter).toContainElement(commentButton)
    expect(gutter?.querySelector('[data-diff-gutter-utility-slot]')).toContainElement(commentButton)
    expect(gutter?.className).toContain('bg-[var(--color-diff-added-bg)]')
    expect(getCodeRow('const a = 1').closest('[data-diff-row-id]')?.querySelector('[data-diff-number-gutter]')?.className).toContain('bg-[var(--color-code-bg)]')
    expect(commentButton.className).toContain('h-5')
    expect(commentButton.className).toContain('w-5')
    expect(row?.querySelectorAll('[data-diff-line-number]')).toHaveLength(1)
    expect(row?.className).toContain('min-h-5')
  })

  it('submits a forward range with its source coordinates and quote', () => {
    const onAddComment = vi.fn()
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    expect(screen.getByRole('textbox', { name: 'Review comment' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 12' }), { shiftKey: true })
    expect(screen.getByText('new L11-L12')).toBeInTheDocument()
    const rangeEndRow = getCodeRow('const c = 4').closest('[data-diff-row-id]')
    const editorContainer = screen.getByRole('textbox', { name: 'Review comment' }).closest('[data-diff-editor]')
    expect(rangeEndRow?.nextElementSibling).toBe(editorContainer)
    expect(getCodeRow('const b = 3')).toHaveAttribute('data-selected', 'true')
    expect(getCodeRow('const c = 4')).toHaveAttribute('data-selected', 'true')

    const editor = screen.getByRole('textbox', { name: 'Review comment' })
    fireEvent.change(editor, { target: { value: 'Use a shared helper' } })
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })

    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({
      side: 'new',
      lineStart: 11,
      lineEnd: 12,
      quote: 'const b = 3\nconst c = 4',
      hunkId: 'file-0-hunk-0',
    }), 'Use a shared helper')
  })

  it('normalizes reverse Shift selection', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 12' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }), { shiftKey: true })

    expect(screen.getByText('new L11-L12')).toBeInTheDocument()
    expect(getCodeRow('const b = 3')).toHaveAttribute('data-selected', 'true')
    expect(getCodeRow('const c = 4')).toHaveAttribute('data-selected', 'true')
  })

  it('exposes the selected Shift range on the diff rows and review rail', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 10' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 12' }), { shiftKey: true })

    const firstRow = getCodeRow('const a = 1').closest('[data-diff-row-id]')
    const middleRow = getCodeRow('const b = 3').closest('[data-diff-row-id]')
    const lastRow = getCodeRow('const c = 4').closest('[data-diff-row-id]')
    expect(firstRow).toHaveAttribute('aria-selected', 'true')
    expect(firstRow).toHaveAttribute('data-range-edge', 'start')
    expect(middleRow).toHaveAttribute('aria-selected', 'true')
    expect(middleRow).not.toHaveAttribute('data-range-edge')
    expect(lastRow).toHaveAttribute('aria-selected', 'true')
    expect(lastRow).toHaveAttribute('data-range-edge', 'end')
    expect(document.querySelectorAll('[data-diff-selection-rail]')).toHaveLength(3)
    document.querySelectorAll('[data-diff-selection-rail]').forEach((rail) => {
      expect(rail.closest('[data-diff-number-gutter]')).not.toBeNull()
    })
    expect(firstRow?.className).toContain('bg-[var(--color-info-container)]')
    expect(firstRow?.className).not.toContain('bg-[var(--color-diff-added-bg)]')
    expect(screen.getByTestId('workspace-code').className).toContain('text-[13px]')
    const editor = screen.getByRole('textbox', { name: 'Review comment' })
    const editorContainer = editor.closest('[data-diff-editor]')
    expect(editorContainer?.className).toContain('max-w-3xl')
    expect(editorContainer?.className).toContain('sticky')
    expect(editorContainer).toHaveStyle({ left: 'var(--workspace-diff-gutter-width)' })
    expect(editorContainer).toHaveStyle({ width: 'min(48rem, calc(100cqi - var(--workspace-diff-gutter-width) - 0.75rem))' })
    expect(editorContainer?.className).not.toContain('ml-[116px]')
    expect(editorContainer?.className).not.toContain('min-w-[420px]')
    expect(editorContainer).toHaveTextContent('Local comment')
    expect(editor.className).toContain('min-h-0')
    expect(editor.className).not.toContain('shadow-[inset_0_0_0_1px')
    expect(screen.getByRole('button', { name: 'Comment on src/a.ts new line 10' })).not.toHaveAttribute('data-selection-focus')
    const focusedGutter = screen.getByRole('button', { name: 'Comment on src/a.ts new line 12' })
    expect(focusedGutter).toHaveAttribute('data-selection-focus', 'true')
    expect(focusedGutter.className).toContain('text-[var(--color-surface)]')
    expect(focusedGutter.className).not.toContain('text-[var(--color-text-tertiary)]')
    expect(focusedGutter.className).not.toContain('text-white')
    const submit = screen.getByRole('button', { name: 'Submit review comment' })
    expect(submit.className).toContain('text-[var(--color-surface)]')
    expect(submit.className).not.toContain('text-white')
  })

  it('cancels an inline review from the visible editor action', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    const anchor = screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' })

    fireEvent.click(anchor)
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), {
      target: { value: 'This draft should close' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('textbox', { name: 'Review comment' })).not.toBeInTheDocument()
    expect(anchor).toHaveFocus()
  })

  it('does not submit an empty review comment', () => {
    const onAddComment = vi.fn()
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" onAddComment={onAddComment} />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Review comment' }), { key: 'Enter', ctrlKey: true })

    expect(onAddComment).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Review comment' })).toBeInTheDocument()
  })

  it('closes on Escape and restores focus to the anchor gutter button', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    const anchor = screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' })

    fireEvent.click(anchor)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Review comment' }), { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'Review comment' })).not.toBeInTheDocument()
    expect(anchor).toHaveFocus()
  })

  it('resets an incompatible Shift range and announces why', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts old line 20' }), { shiftKey: true })

    expect(screen.getByText('Selection reset: choose lines from the same side and hunk.')).toBeInTheDocument()
    expect(screen.getByText('old L20')).toBeInTheDocument()
  })

  it('uses one roving tab stop and supports Arrow, Home, End, and activation keys', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    const buttons = screen.getAllByRole('button', { name: /Comment on src\/a\.ts/ })
    const firstButton = buttons[0]!
    const secondButton = buttons[1]!

    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    act(() => firstButton.focus())
    fireEvent.keyDown(firstButton, { key: 'ArrowDown' })
    expect(secondButton).toHaveFocus()
    expect(secondButton).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(secondButton, { key: 'End' })
    expect(buttons.at(-1)).toHaveFocus()
    fireEvent.keyDown(buttons.at(-1)!, { key: 'Home' })
    expect(firstButton).toHaveFocus()
    fireEvent.keyDown(firstButton, { key: ' ' })
    expect(screen.getByRole('textbox', { name: 'Review comment' })).toHaveFocus()
  })

  it('keeps Shift+Home selection inside the current side and hunk', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    const line10 = screen.getByRole('button', { name: 'Comment on src/a.ts new line 10' })
    const line11 = screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' })

    act(() => line11.focus())
    fireEvent.keyDown(line11, { key: 'Home', shiftKey: true })

    expect(line10).toHaveFocus()
    expect(screen.getByText('new L10-L11')).toBeInTheDocument()
    expect(getCodeRow('const a = 1')).toHaveAttribute('data-selected', 'true')
    expect(getCodeRow('const b = 3')).toHaveAttribute('data-selected', 'true')
  })

  it('extends the range with Shift+Arrow and returns focus after submit', () => {
    const onAddComment = vi.fn()
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" onAddComment={onAddComment} />)
    const anchor = screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' })

    act(() => anchor.focus())
    fireEvent.keyDown(anchor, { key: 'ArrowDown', shiftKey: true })
    expect(screen.getByText('new L11-L12')).toBeInTheDocument()

    const editor = screen.getByRole('textbox', { name: 'Review comment' })
    fireEvent.change(editor, { target: { value: 'Keep this focused' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    expect(onAddComment).toHaveBeenCalledOnce()
    expect(anchor).toHaveFocus()
  })

  it('skips incompatible rows when extending with Shift+Arrow', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    const anchor = screen.getByRole('button', { name: 'Comment on src/a.ts new line 10' })

    act(() => anchor.focus())
    fireEvent.keyDown(anchor, { key: 'ArrowDown', shiftKey: true })

    expect(screen.getByText('new L10-L11')).toBeInTheDocument()
    expect(getCodeRow('const a = 1')).toHaveAttribute('data-selected', 'true')
    expect(getCodeRow('const b = 3')).toHaveAttribute('data-selected', 'true')
  })

  it('keeps gutter focus for repeatable Shift+Arrow extension and shrinking', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    const line10 = screen.getByRole('button', { name: 'Comment on src/a.ts new line 10' })
    const line11 = screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' })
    const line12 = screen.getByRole('button', { name: 'Comment on src/a.ts new line 12' })

    act(() => line10.focus())
    fireEvent.keyDown(line10, { key: 'ArrowDown', shiftKey: true })
    expect(line11).toHaveFocus()
    fireEvent.keyDown(line11, { key: 'ArrowDown', shiftKey: true })
    expect(line12).toHaveFocus()
    expect(screen.getByText('new L10-L12')).toBeInTheDocument()

    fireEvent.keyDown(line12, { key: 'ArrowUp', shiftKey: true })
    expect(line11).toHaveFocus()
    expect(screen.getByText('new L10-L11')).toBeInTheDocument()
  })

  it('keeps roving navigation on mounted rows when the preview is truncated', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" lineLimit={5} />)
    const visibleButtons = screen.getAllByRole('button', { name: /Comment on src\/a\.ts/ })
    const lastVisibleButton = visibleButtons.at(-1)!

    act(() => lastVisibleButton.focus())
    fireEvent.keyDown(lastVisibleButton, { key: 'ArrowDown' })

    expect(lastVisibleButton).toHaveFocus()
    expect(visibleButtons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    expect(screen.getByText('Showing first 5 of 9 loaded lines.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all loaded lines' })).toBeInTheDocument()
  })

  it('invalidates a hidden selection on collapse while preserving its draft and visible roving target', () => {
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" lineLimit={5} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all loaded lines' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 12' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), {
      target: { value: 'Keep this collapsed draft' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Collapse preview' }))

    expect(screen.queryByRole('textbox', { name: 'Review comment' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Select visible lines again')
    const visibleButtons = screen.getAllByRole('button', { name: /Comment on src\/a\.ts/ })
    expect(visibleButtons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    expect(visibleButtons[0]).toHaveFocus()

    fireEvent.click(visibleButtons[0]!)
    expect(screen.getByRole('textbox', { name: 'Review comment' })).toHaveValue('Keep this collapsed draft')
  })

  it('uses plain text instead of Shiki after expanding a diff beyond the large preview threshold', () => {
    const additions = Array.from(
      { length: WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD + 1 },
      (_, index) => `+const value${index} = ${index}`,
    )
    const largeDiff = [
      'diff --git a/src/large.ts b/src/large.ts',
      '--- a/src/large.ts',
      '+++ b/src/large.ts',
      `@@ -0,0 +1,${additions.length} @@`,
      ...additions,
    ].join('\n')
    render(<WorkspaceDiffSurface value={largeDiff} path="src/large.ts" lineLimit={1} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show all loaded lines' }))

    expect(screen.getByTestId('workspace-code')).toHaveAttribute('data-highlight-engine', 'plain')
    expect(highlightRequestSpy).not.toHaveBeenCalled()
    expect(getCodeRow('const value5000 = 5000')).toHaveTextContent('const value5000 = 5000')
  })

  it('renders parsed file headers and keeps multiple files visually separated', () => {
    const multiFileDiff = [
      diff,
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-export const before = true',
      '+export const after = true',
    ].join('\n')

    render(<WorkspaceDiffSurface value={multiFileDiff} path="workspace.diff" />)

    const headers = screen.getAllByTestId('workspace-diff-file-header')
    expect(headers).toHaveLength(2)
    expect(headers[0]).toHaveTextContent('diff --git a/src/a.ts b/src/a.ts')
    expect(headers[1]).toHaveTextContent('diff --git a/src/b.ts b/src/b.ts')
  })

  it('renders TypeScript Shiki tokens through the compatibility export without a circular runtime failure', async () => {
    highlightRequestSpy.mockImplementationOnce(async ({ files }) => createHighlightResult(files))
    render(<ExportedWorkspaceDiffSurface value={diff} path="src/a.ts" />)

    await waitFor(() => expect(screen.getByTestId('workspace-code')).toHaveAttribute('data-highlight-engine', 'shiki'))
    const keyword = screen.getAllByText('const').find((element) => (
      element.getAttribute('style')?.includes('var(--color-diff-syntax-keyword)')
    ))
    expect(keyword).toBeDefined()
    expect(document.querySelectorAll('[data-row-text="const b = 3"]')).toHaveLength(1)
  })

  it('never renders tokens from the previous diff while the next highlight is pending', async () => {
    highlightRequestSpy.mockImplementationOnce(async ({ files }) => {
      const result = createHighlightResult(files)
      const firstRow = files.flatMap((file: { rows: Array<{ id: string; selectable: boolean }> }) => file.rows)
        .find((row: { selectable: boolean }) => row.selectable)!
      result.tokensByRowId[firstRow.id] = [{
        content: 'STALE_TOKEN',
        color: 'var(--color-diff-syntax-keyword)',
      }]
      return result
    })
    const view = render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    await screen.findByText('STALE_TOKEN')

    let resolveNext: (() => void) | undefined
    const nextDiff = diff.replace('const a = 1', 'let fresh = 2')
    highlightRequestSpy.mockImplementationOnce(({ files }) => new Promise((resolve) => {
      resolveNext = () => resolve(createHighlightResult(files))
    }))
    view.rerender(<WorkspaceDiffSurface value={nextDiff} path="src/a.ts" />)

    expect(screen.queryByText('STALE_TOKEN')).not.toBeInTheDocument()
    expect(getCodeRow('let fresh = 2')).toHaveTextContent('let fresh = 2')

    await act(async () => resolveNext?.())
    await waitFor(() => expect(screen.getByTestId('workspace-code')).toHaveAttribute('data-highlight-engine', 'shiki'))
  })

  it('layers word-level changes over Shiki tokens without changing the line layout', async () => {
    const wordDiff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-const label = oldName',
      '+const label = newName',
    ].join('\n')
    highlightRequestSpy.mockImplementationOnce(async ({ files }) => {
      const result = createHighlightResult(files)
      const rows = files.flatMap((file: { rows: Array<{ id: string; text: string }> }) => file.rows)
      const oldRow = rows.find((row: { text: string }) => row.text.includes('oldName'))!
      const newRow = rows.find((row: { text: string }) => row.text.includes('newName'))!
      return {
        ...result,
        wordRangesByRowId: {
          [oldRow.id]: [{ start: 14, end: 21 }],
          [newRow.id]: [{ start: 14, end: 21 }],
        },
      }
    })

    render(<WorkspaceDiffSurface value={wordDiff} path="src/a.ts" />)

    await waitFor(() => expect(screen.getByTestId('workspace-code')).toHaveAttribute('data-highlight-engine', 'shiki'))
    expect(document.querySelector('[data-diff-word-change="deletion"]')).toHaveTextContent('oldName')
    expect(document.querySelector('[data-diff-word-change="addition"]')).toHaveTextContent('newName')
    expect(document.querySelector('[data-diff-word-change="deletion"]')?.className).toContain('color-diff-removed-word')
    expect(document.querySelector('[data-diff-word-change="addition"]')?.className).toContain('color-diff-added-word')
  })

  it('renders the complete review flow in Chinese', () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)

    const gutter = screen.getByRole('button', { name: '评论 src/a.ts 的新侧第 11 行' })
    fireEvent.click(gutter)

    expect(screen.getByRole('textbox', { name: '评审评论' })).toHaveFocus()
    expect(screen.getByText('新 L11')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交评审评论' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '评论 src/a.ts 的旧侧第 20 行' }), { shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('只能选择同一侧、同一变更块中的行')
  })

  it('does not request Shiki highlighting again for each controlled draft change', () => {
    const additions = Array.from(
      { length: WORKSPACE_PREVIEW_LINE_LIMIT - 4 },
      (_, index) => `+const value${index + 1} = ${index + 1}`,
    )
    const nearLimitDiff = [
      'diff --git a/src/near-limit.ts b/src/near-limit.ts',
      '--- a/src/near-limit.ts',
      '+++ b/src/near-limit.ts',
      `@@ -0,0 +1,${additions.length} @@`,
      ...additions,
    ].join('\n')
    render(<WorkspaceDiffSurface value={nearLimitDiff} path="src/near-limit.ts" />)
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/near-limit.ts new line 1' }))
    const highlightCountBeforeTyping = highlightRequestSpy.mock.calls.length
    const editor = screen.getByRole('textbox', { name: 'Review comment' })

    fireEvent.change(editor, { target: { value: 'a' } })
    fireEvent.change(editor, { target: { value: 'ab' } })
    fireEvent.change(editor, { target: { value: 'abc' } })

    expect(highlightRequestSpy).toHaveBeenCalledTimes(highlightCountBeforeTyping)
    expect(editor).toHaveValue('abc')
  })

  it('preserves draft text but invalidates its selection when the diff changes', () => {
    const { rerender } = render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), {
      target: { value: 'Draft survives refresh' },
    })
    rerender(<WorkspaceDiffSurface value={`${diff}\n`} path="src/a.ts" />)

    expect(screen.queryByRole('textbox', { name: 'Review comment' })).not.toBeInTheDocument()
    expect(screen.getByText('Diff changed. Select lines again to submit this comment.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    expect(screen.getByRole('textbox', { name: 'Review comment' })).toHaveValue('Draft survives refresh')
  })

  it('resets the editor and draft when the path changes', () => {
    const { rerender } = render(<WorkspaceDiffSurface value={diff} path="src/a.ts" />)
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/a.ts new line 11' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), {
      target: { value: 'Discard on another file' },
    })

    rerender(<WorkspaceDiffSurface value={diff} path="src/b.ts" />)

    expect(screen.queryByRole('textbox', { name: 'Review comment' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on src/b.ts new line 11' }))
    expect(screen.getByRole('textbox', { name: 'Review comment' })).toHaveValue('')
  })
})
