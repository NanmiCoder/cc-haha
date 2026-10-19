import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageActionBar } from './MessageActionBar'

/**
 * Regression anchor for #1616: the edit-and-resend pencil only worked for some
 * messages.
 *
 * The hover shell around a user bubble is shrink-to-fit. The overlay bar used
 * to be `absolute top-full right-0`, which adds nothing to the shell's width,
 * so under a bubble narrower than the bar (about 125px: "hi") the bar hung out
 * past the shell's left edge. Moving the pointer from the bubble to the pencil
 * left the shell on the way, `:hover` dropped, and the bar faded out and went
 * `pointer-events: none` under the cursor.
 *
 * The fix keeps the overlay bar in flow as a zero-height row, so the shell is
 * always at least as wide as its bar. jsdom has no layout, so this cannot
 * measure widths; it locks the structural property that makes the width
 * contribute: the bar is not taken out of flow and it holds no height of its
 * own. Limitation: it proves the structure, not the rendered geometry. The
 * geometry (shell width >= bar width, pencil reachable on a straight pointer
 * path for 41px/81px/133px bubbles) was replayed in a real Chromium page.
 */

const OUT_OF_FLOW = /(^|\s)(absolute|fixed)(\s|$)/

function renderOverlay(align: 'start' | 'end') {
  const { container } = render(
    <div data-message-shell="user">
      <div data-message-body="user">hi</div>
      <MessageActionBar
        copyText="hi"
        copyLabel="Copy"
        branchAction={{ label: 'Branch', onBranch: vi.fn() }}
        editAction={{ label: 'Edit', onEdit: vi.fn() }}
        align={align}
        placement="overlay"
        timestamp={1_700_000_000_000}
      />
    </div>,
  )
  const bar = container.querySelector<HTMLElement>('[data-message-actions]')
  if (!bar) throw new Error('action bar not rendered')
  return bar
}

describe('MessageActionBar overlay placement (#1616)', () => {
  it.each(['start', 'end'] as const)('stays in flow with no height of its own (align=%s)', (align) => {
    const bar = renderOverlay(align)
    expect(bar.getAttribute('data-placement')).toBe('overlay')
    expect(bar.className).not.toMatch(OUT_OF_FLOW)
    expect(bar.className).toContain('h-0')
    expect(bar.className).not.toMatch(/(^|\s)h-6(\s|$)/)
  })

  it('still lines the row up with the bubble edge it belongs to', () => {
    expect(renderOverlay('end').className).toContain('justify-end')
    expect(renderOverlay('start').className).toContain('justify-start')
  })

  it('keeps the inline placement as a full-width row in the document flow', () => {
    const { container } = render(<MessageActionBar copyText="hi" copyLabel="Copy" placement="inline" />)
    const bar = container.querySelector<HTMLElement>('[data-message-actions]')!
    expect(bar.className).toContain('h-6')
    expect(bar.className).toContain('w-full')
    expect(bar.className).not.toMatch(OUT_OF_FLOW)
  })

  it('detects an out-of-flow bar (helper sanity, so the assertions above cannot pass vacuously)', () => {
    expect('flex absolute top-full right-0').toMatch(OUT_OF_FLOW)
    expect('flex h-0 justify-end').not.toMatch(OUT_OF_FLOW)
  })
})
