import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAnnotationLayout,
  getAnnotationRects,
  getRangeForAnnotation,
  getTextOffsetForRange,
} from './annotationAnchors'

function buildRoot(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

function textNodesUnder(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    nodes.push(current as Text)
    current = walker.nextNode()
  }
  return nodes
}

/** Range covering the `occurrence`-th appearance of `needle` in the root's text. */
function rangeForText(root: HTMLElement, needle: string, occurrence = 0): Range {
  const full = textNodesUnder(root).map((node) => node.data).join('')
  let index = -1
  for (let seen = 0; seen <= occurrence; seen += 1) {
    index = full.indexOf(needle, index + 1)
    if (index === -1) throw new Error(`"${needle}" (occurrence ${occurrence}) not found in "${full}"`)
  }
  const range = document.createRange()
  let consumed = 0
  let started = false
  for (const node of textNodesUnder(root)) {
    const next = consumed + node.data.length
    if (!started && index < next) {
      range.setStart(node, index - consumed)
      started = true
    }
    const endIndex = index + needle.length
    if (started && endIndex <= next) {
      range.setEnd(node, endIndex - consumed)
      return range
    }
    consumed = next
  }
  throw new Error('range end not found')
}

/** jsdom implements no layout, so `Range#getClientRects` has to be supplied outright. */
function stubClientRects(range: Range, rects: Array<Partial<DOMRect>>) {
  Object.defineProperty(range, 'getClientRects', {
    configurable: true,
    value: () => rects as unknown as DOMRectList,
  })
}

function stubElementRect(element: HTMLElement, rect: Partial<DOMRect>) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect)
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  // `stubRangeClientRects` puts this on the prototype, which outlives one case.
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects
})

describe('getTextOffsetForRange', () => {
  it('maps a range inside nested elements onto concatenated text offsets', () => {
    const root = buildRoot('<p>alpha <strong>beta</strong> gamma</p>')

    expect(getTextOffsetForRange(root, rangeForText(root, 'beta'))).toEqual({ start: 6, end: 10 })
  })

  it('returns null for a range that leaves the root', () => {
    const root = buildRoot('<p>alpha</p>')
    const outside = buildRoot('<p>beta</p>')

    expect(getTextOffsetForRange(root, rangeForText(outside, 'beta'))).toBeNull()
  })
})

describe('getRangeForAnnotation', () => {
  it('resolves an anchored annotation back to its exact span', () => {
    const root = buildRoot('<p>alpha</p><p>beta</p>')

    expect(getRangeForAnnotation(root, { quote: 'beta', startOffset: 5, endOffset: 9 })?.toString()).toBe('beta')
  })

  it('uses offsets to tell duplicate quotes apart', () => {
    const root = buildRoot('<p>dup</p><p>dup</p>')
    const second = getRangeForAnnotation(root, { quote: 'dup', startOffset: 3, endOffset: 6 })

    expect(second?.toString()).toBe('dup')
    expect(second?.startContainer).toBe(textNodesUnder(root)[1])
  })

  it('falls back to searching the quote when the offsets no longer match the text', () => {
    const root = buildRoot('<p>alpha</p><p>beta</p>')

    expect(getRangeForAnnotation(root, { quote: 'beta', startOffset: 0, endOffset: 4 })?.toString()).toBe('beta')
  })

  it('falls back to searching the quote when no offsets were recorded', () => {
    const root = buildRoot('<p>alpha</p><p>beta</p>')

    expect(getRangeForAnnotation(root, { quote: 'beta' })?.toString()).toBe('beta')
  })

  it('returns null when the quote is gone from the message', () => {
    const root = buildRoot('<p>alpha</p>')

    expect(getRangeForAnnotation(root, { quote: 'beta', startOffset: 3, endOffset: 7 })).toBeNull()
  })

  it('resolves a quote that spans several elements', () => {
    const root = buildRoot('<p>alpha <strong>beta</strong> gamma</p>')

    expect(getRangeForAnnotation(root, { quote: 'alpha beta' })?.toString()).toBe('alpha beta')
  })
})

describe('getAnnotationRects', () => {
  it('returns rects relative to the container, accounting for its scroll offset', () => {
    const root = buildRoot('<p>alpha beta</p>')
    const range = rangeForText(root, 'beta')
    stubElementRect(root, { left: 100, top: 200 })
    Object.defineProperty(root, 'scrollTop', { value: 24, configurable: true })
    Object.defineProperty(root, 'scrollLeft', { value: 8, configurable: true })
    stubClientRects(range, [{ left: 130, top: 260, width: 60, height: 20 }])

    expect(getAnnotationRects(root, range)).toEqual([{ left: 38, top: 84, width: 60, height: 20 }])
  })

  it('drops zero-area rects that browsers report for empty line boxes', () => {    const root = buildRoot('<p>alpha</p>')
    const range = rangeForText(root, 'alpha')
    stubElementRect(root, { left: 0, top: 0 })
    stubClientRects(range, [
      { left: 0, top: 0, width: 0, height: 0 },
      { left: 10, top: 20, width: 30, height: 12 },
    ])

    expect(getAnnotationRects(root, range)).toEqual([{ left: 10, top: 20, width: 30, height: 12 }])
  })

  it('returns nothing when the environment cannot measure ranges at all', () => {
    const root = buildRoot('<p>alpha</p>')
    const range = rangeForText(root, 'alpha')

    expect(typeof range.getClientRects).toBe('undefined')
    expect(getAnnotationRects(root, range)).toEqual([])
  })
})

describe('getAnnotationLayout', () => {
  /** Every range in the page reports the same client rects for the duration of one case. */
  function stubRangeClientRects(rects: Array<Partial<DOMRect>>) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => rects as unknown as DOMRectList,
    })
  }

  it('returns nothing when the anchor no longer matches the message', () => {
    const root = buildRoot('<p>alpha</p>')

    expect(getAnnotationLayout(root, { quote: 'beta' })).toBeNull()
  })

  it('returns nothing when the resolved range has no painted area', () => {
    const root = buildRoot('<p>alpha</p>')
    stubRangeClientRects([{ left: 0, top: 0, width: 0, height: 0 }])

    expect(getAnnotationLayout(root, { quote: 'alpha' })).toBeNull()
  })

  it('paints every line of a wrapped span and puts the badge at the end of the last one', () => {
    const root = buildRoot('<p>alpha beta</p>')
    stubElementRect(root, { left: 0, top: 0 })
    stubRangeClientRects([
      { left: 10, top: 20, width: 30, height: 12 },
      { left: 0, top: 40, width: 50, height: 12 },
    ])

    expect(getAnnotationLayout(root, { quote: 'alpha beta' })).toEqual({
      rects: [
        { left: 10, top: 20, width: 30, height: 12 },
        { left: 0, top: 40, width: 50, height: 12 },
      ],
      badge: { left: 47, top: 31 },
    })
  })
})
