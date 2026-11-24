import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import type { UIMessage } from '../../types/chat'
import {
  buildConversationNavigationItems,
  ConversationNavigator,
  type ConversationNavigationSource,
} from './ConversationNavigator'

function source(message: UIMessage, renderIndex: number): ConversationNavigationSource {
  return {
    message,
    renderIndex,
    renderItemKey: message.id,
  }
}

function markerVisualWidth(marker: HTMLElement) {
  const bar = marker.querySelector('[aria-hidden="true"]') as HTMLElement
  const scale = Number.parseFloat(bar.style.transform.match(/^scaleX\((.+)\)$/)?.[1] ?? '1')
  return Number.parseFloat(bar.style.width) * scale
}

describe('buildConversationNavigationItems', () => {
  it('keeps only visible user messages and numbers them in transcript order', () => {
    const items = buildConversationNavigationItems([
      source({ id: 'user-1', type: 'user_text', content: '  Review   the API  ', timestamp: 1 }, 0),
      source({ id: 'thinking-1', type: 'thinking', content: 'hidden', timestamp: 2 }, 1),
      source({ id: 'assistant-1', type: 'assistant_text', content: '**API** review complete', timestamp: 4 }, 3),
      source({ id: 'user-empty', type: 'user_text', content: '  ', timestamp: 5 }, 4),
      source({ id: 'user-2', type: 'user_text', content: 'Ship the fix', timestamp: 6 }, 5),
      source({ id: 'system-1', type: 'system', content: 'hidden', timestamp: 5 }, 4),
    ])

    expect(items).toEqual([
      {
        id: 'user-1',
        renderItemKey: 'user-1',
        renderIndex: 0,
        turnNumber: 1,
        preview: 'Review the API',
        attachmentCount: 0,
      },
      {
        id: 'user-2',
        renderItemKey: 'user-2',
        renderIndex: 5,
        turnNumber: 2,
        preview: 'Ship the fix',
        attachmentCount: 0,
      },
    ])
  })

  it('counts user attachments and flattens markdown into preview text', () => {
    const items = buildConversationNavigationItems([
      source({
        id: 'user-files',
        type: 'user_text',
        content: '> Please inspect [`MessageList`](https://example.com)\n\n```ts\nconst ready = true\n```',
        timestamp: 1,
        attachments: [
          { type: 'file', name: 'one.ts', mimeType: 'text/plain' },
          { type: 'file', name: 'two.ts', mimeType: 'text/plain' },
        ],
      }, 0),
    ])

    expect(items[0]).toMatchObject({
      turnNumber: 1,
      preview: 'Please inspect MessageList const ready = true',
      attachmentCount: 2,
    })
  })

  it('keeps attachment-only user turns in the navigation sequence', () => {
    const items = buildConversationNavigationItems([
      source({ id: 'assistant-1', type: 'assistant_text', content: 'Ready', timestamp: 1 }, 0),
      source({
        id: 'user-files',
        type: 'user_text',
        content: ' ',
        timestamp: 2,
        attachments: [
          { type: 'file', name: 'diagram.png', mimeType: 'image/png' },
          { type: 'file', name: 'notes.txt', mimeType: 'text/plain' },
        ],
      }, 1),
    ])

    expect(items).toEqual([{
      id: 'user-files',
      renderItemKey: 'user-files',
      renderIndex: 1,
      turnNumber: 1,
      preview: 'diagram.png, notes.txt',
      attachmentCount: 2,
    }])
  })

  it('bounds previews for very long messages', () => {
    const items = buildConversationNavigationItems([
      source({ id: 'long', type: 'user_text', content: 'long prompt '.repeat(200), timestamp: 1 }, 0),
    ])

    expect(items[0]?.preview.length).toBeLessThanOrEqual(280)
    expect(items[0]?.preview.endsWith('…')).toBe(true)
  })
})

describe('ConversationNavigator', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders numbered user turns and moves the active turn indicator', () => {
    const { rerender } = render(
      <ConversationNavigator
        mode="full"
        items={[
          { id: 'user-1', renderItemKey: 'user-1', renderIndex: 0, turnNumber: 1, preview: 'First prompt', attachmentCount: 0 },
          { id: 'user-2', renderItemKey: 'user-2', renderIndex: 2, turnNumber: 2, preview: 'Second prompt', attachmentCount: 0 },
        ]}
        activeItemId="user-2"
        onNavigate={vi.fn()}
      />,
    )

    const markers = screen.getAllByRole('button')
    expect(markers.map((marker) => marker.getAttribute('data-turn-number'))).toEqual(['1', '2'])
    expect(markers.map((marker) => marker.getAttribute('aria-label'))).toEqual([
      'Turn 1 of 2: First prompt',
      'Turn 2 of 2: Second prompt',
    ])
    expect(markers[0]?.getAttribute('aria-current')).toBeNull()
    expect(markers[1]?.getAttribute('aria-current')).toBe('location')

    const markerBars = markers.map((marker) => marker.querySelector('[aria-hidden="true"]'))
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('full')
    expect(markerBars.every((bar) => bar?.className.includes('transition-[transform,background-color,opacity]'))).toBe(true)
    expect(markers.every((marker) => marker.className.includes('h-3'))).toBe(true)
    expect(markers.every((marker) => !marker.className.includes('focus-visible:ring-2'))).toBe(true)
    expect(markerBars.every((bar) => bar?.className.includes('group-focus-visible:ring-1'))).toBe(true)
    expect(markerVisualWidth(markers[0]!)).toBe(7)
    expect(markerBars[0]?.textContent).toBe('')
    expect(markerVisualWidth(markers[1]!)).toBe(14)
    expect(markerBars[1]?.className).toContain('h-0.5')
    expect(markerBars[1]?.className).toContain('bg-[var(--color-brand)]')
    expect(markerBars[1]?.textContent).toBe('')

    rerender(
      <ConversationNavigator
        mode="full"
        items={[
          { id: 'user-1', renderItemKey: 'user-1', renderIndex: 0, turnNumber: 1, preview: 'First prompt', attachmentCount: 0 },
          { id: 'user-2', renderItemKey: 'user-2', renderIndex: 2, turnNumber: 2, preview: 'Second prompt', attachmentCount: 0 },
        ]}
        activeItemId="user-1"
        onNavigate={vi.fn()}
      />,
    )

    const updatedBars = screen.getAllByRole('button').map((marker) => marker.querySelector('[aria-hidden="true"]'))
    const updatedMarkers = screen.getAllByRole('button')
    expect(markerVisualWidth(updatedMarkers[0]!)).toBe(14)
    expect(updatedBars[0]?.className).toContain('bg-[var(--color-brand)]')
    expect(markerVisualWidth(updatedMarkers[1]!)).toBe(7)
  })

  it('magnifies nearby markers as a continuous proximity wave', () => {
    render(
      <ConversationNavigator
        mode="full"
        items={Array.from({ length: 9 }, (_, index) => ({
          id: `user-${index}`,
          renderItemKey: `user-${index}`,
          renderIndex: index,
          turnNumber: index + 1,
          preview: `Prompt ${index}`,
          attachmentCount: 0,
        }))}
        activeItemId={null}
        onNavigate={vi.fn()}
      />,
    )

    const navigator = screen.getByTestId('conversation-navigator')
    const lane = navigator.querySelector('.conversation-navigation-scroll') as HTMLElement
    vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({
      bottom: 180,
      height: 180,
      left: 0,
      right: 56,
      top: 0,
      width: 56,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.mouseMove(lane, { clientY: 64 })

    const widths = screen.getAllByRole('button').map(markerVisualWidth)
    expect(widths[4]).toBe(22)
    expect(widths[3]).toBeGreaterThan(widths[2]!)
    expect(widths[2]).toBe(7)
    expect(widths[1]).toBe(7)
    expect(widths[0]).toBe(7)
    expect(widths.slice(0, 4)).toEqual(widths.slice(5).reverse())

    fireEvent.mouseLeave(lane)
    expect(screen.getAllByRole('button').every((marker) => (
      markerVisualWidth(marker) === 7
    ))).toBe(true)
  })

  it('uses equal shorter marker geometry in compact mode', () => {
    render(
      <ConversationNavigator
        mode="compact"
        items={[
          { id: 'user-1', renderItemKey: 'user-1', renderIndex: 0, turnNumber: 1, preview: 'First prompt', attachmentCount: 0 },
          { id: 'user-2', renderItemKey: 'user-2', renderIndex: 2, turnNumber: 2, preview: 'Second prompt', attachmentCount: 0 },
        ]}
        activeItemId="user-1"
        onNavigate={vi.fn()}
      />,
    )

    const markers = screen.getAllByRole('button')
    const markerBars = markers.map((marker) => marker.querySelector('[aria-hidden="true"]'))
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('compact')
    expect(markerVisualWidth(markers[0]!)).toBe(12)
    expect(markerVisualWidth(markers[1]!)).toBe(6)
    expect(markerBars.every((bar) => bar?.className.includes('motion-reduce:transition-none'))).toBe(true)
  })

  it('uses an edge-sized lane when the transcript becomes narrow', () => {
    render(
      <ConversationNavigator
        mode="edge"
        items={[
          { id: 'user-1', renderItemKey: 'user-1', renderIndex: 0, turnNumber: 1, preview: 'First prompt', attachmentCount: 0 },
          { id: 'user-2', renderItemKey: 'user-2', renderIndex: 2, turnNumber: 2, preview: 'Second prompt', attachmentCount: 0 },
        ]}
        activeItemId="user-2"
        onNavigate={vi.fn()}
      />,
    )

    const markers = screen.getAllByRole('button')
    expect(screen.getByTestId('conversation-navigator').getAttribute('data-mode')).toBe('edge')
    expect(markerVisualWidth(markers[0]!)).toBe(4)
    expect(markerVisualWidth(markers[1]!)).toBe(10)
  })

  it('shows the preview on hover or focus and navigates on click', () => {
    const onNavigate = vi.fn()
    const item = {
      id: 'user-1',
      renderItemKey: 'user-1',
      renderIndex: 0,
      turnNumber: 1,
      preview: 'Inspect the virtual transcript',
      attachmentCount: 2,
    }
    render(
      <ConversationNavigator
        mode="full"
        items={[item]}
        activeItemId="user-1"
        onNavigate={onNavigate}
      />,
    )

    const marker = screen.getByRole('button', { name: /Turn 1 of 1.*Inspect the virtual transcript/ })
    expect(screen.queryByTestId('conversation-navigation-preview')).toBeNull()

    fireEvent.mouseEnter(marker)
    const preview = screen.getByTestId('conversation-navigation-preview')
    expect(preview.parentElement).toBe(document.body)
    expect(preview.textContent).toContain('Turn 1 of 1')
    expect(preview.textContent).toContain('Inspect the virtual transcript')
    expect(preview.textContent).toContain('2')

    fireEvent.mouseLeave(marker)
    fireEvent.focus(marker)
    expect(screen.getByTestId('conversation-navigation-preview')).toBeTruthy()
    expect(markerVisualWidth(marker)).toBe(14)

    fireEvent.click(marker)
    expect(onNavigate).toHaveBeenCalledWith(item)

    fireEvent.blur(marker)
    expect(markerVisualWidth(marker)).toBe(14)
  })
})
