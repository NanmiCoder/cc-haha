// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../../stores/settingsStore'
import { ChatAnnotationMarks, type ChatAnnotationMark } from './ChatAnnotationMarks'

const CONTAINER_RECT = { left: 100, top: 200, width: 200, height: 100, right: 300, bottom: 300, x: 100, y: 200 }

/** One painted line, in viewport coordinates, as `Range#getClientRects` reports it. */
const LINE_RECTS = [{ left: 120, top: 220, width: 30, height: 12 }]

function marks(...overrides: Array<Partial<ChatAnnotationMark>>): ChatAnnotationMark[] {
  return overrides.map((override, index) => ({
    id: `annotation-${index + 1}`,
    number: index + 1,
    quote: 'alpha',
    ...override,
  }))
}

function Harness({
  annotations,
  onActivate = vi.fn(),
}: {
  annotations: ChatAnnotationMark[]
  onActivate?: (mark: ChatAnnotationMark, anchorRect: DOMRect) => void
}) {
  return (
    // The message wrapper the marks are measured against; the overlay is its direct child.
    <div data-testid="message">
      {/* Text the anchors resolve against, laid out the way the transcript renders it. */}
      <p>alpha beta gamma</p>
      <ChatAnnotationMarks annotations={annotations} onActivate={onActivate} />
    </div>
  )
}

describe('ChatAnnotationMarks', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      ...CONTAINER_RECT,
      toJSON: () => ({}),
    } as DOMRect)
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => LINE_RECTS as unknown as DOMRectList,
    })
  })

  it('paints a numbered badge for each annotation', () => {
    render(<Harness annotations={marks({ quote: 'alpha' }, { quote: 'beta' })} />)

    expect(screen.getByRole('button', { name: 'Edit annotation 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit annotation 2' })).toBeInTheDocument()
  })

  it('keeps the painted span non-interactive so the same text can be selected again', () => {
    render(<Harness annotations={marks({ quote: 'alpha' })} />)

    const overlay = screen.getByTestId('chat-annotation-marks')
    expect(overlay).toHaveClass('pointer-events-none')
    expect(screen.getByRole('button', { name: 'Edit annotation 1' })).toHaveClass('pointer-events-auto')
  })

  it('reports the annotation and the badge position when a badge is activated', () => {
    const onActivate = vi.fn()
    render(<Harness annotations={marks({ quote: 'alpha' })} onActivate={onActivate} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }))

    expect(onActivate).toHaveBeenCalledTimes(1)
    const [mark, anchorRect] = onActivate.mock.calls[0]!
    expect(mark.id).toBe('annotation-1')
    // Container-relative 47/11 (end of the painted line, raised as a superscript)
    // offset by the container's own viewport position.
    expect({ left: anchorRect.left, top: anchorRect.top }).toEqual({ left: 147, top: 211 })
  })

  it('paints nothing for an annotation whose text is no longer in the message', () => {
    render(<Harness annotations={marks({ quote: 'vanished' }, { quote: 'beta' })} />)

    expect(screen.queryByRole('button', { name: 'Edit annotation 1' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit annotation 2' })).toBeInTheDocument()
  })

  it('clears the marks once the annotations are gone', () => {
    const view = render(<Harness annotations={marks({ quote: 'alpha' })} />)
    expect(screen.getByRole('button', { name: 'Edit annotation 1' })).toBeInTheDocument()

    view.rerender(<Harness annotations={[]} />)

    expect(screen.queryByRole('button', { name: 'Edit annotation 1' })).not.toBeInTheDocument()
  })

  it('draws the lines it can resolve without a ResizeObserver in the environment', () => {
    // jsdom has no ResizeObserver; the overlay must still paint on mount rather
    // than depending on the observer's first callback.
    expect(typeof ResizeObserver).toBe('undefined')

    render(<Harness annotations={marks({ quote: 'alpha' })} />)

    expect(screen.getByRole('button', { name: 'Edit annotation 1' })).toBeInTheDocument()
  })
})
