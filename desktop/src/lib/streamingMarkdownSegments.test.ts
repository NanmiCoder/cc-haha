import { describe, expect, it } from 'vitest'
import { splitStreamingMarkdown, type StreamingMarkdownSegments } from './streamingMarkdownSegments'

const paragraph = (index: number) => `Paragraph ${index}: ${'reasoning about the request '.repeat(40)}`.trim()
const paragraphs = (count: number) => Array.from({ length: count }, (_, index) => paragraph(index + 1)).join('\n\n')
const fenceLines = (text: string) => text.split('\n').filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line)).length

describe('splitStreamingMarkdown', () => {
  it('keeps a short block entirely live', () => {
    const content = 'Checking the retry path first\n\nthen the queue'
    expect(splitStreamingMarkdown(content)).toEqual({ settled: [], live: content })
  })

  it('settles whole paragraphs at blank lines once a segment is long enough, never the growing last one', () => {
    const content = paragraphs(6)
    const result = splitStreamingMarkdown(content)

    expect(result.settled.join('') + result.live).toBe(content)
    // Two paragraphs (~2.3k chars) fill a segment; the fifth waits for the
    // sixth to be followed by something before it can settle.
    expect(result.settled).toEqual([
      `${paragraph(1)}\n\n${paragraph(2)}\n\n`,
      `${paragraph(3)}\n\n${paragraph(4)}\n\n`,
    ])
    expect(result.live).toBe(`${paragraph(5)}\n\n${paragraph(6)}`)
  })

  it('keeps every settled segment as the stream grows and matches a split from scratch', () => {
    const full = paragraphs(9)
    let previous: StreamingMarkdownSegments | undefined
    for (let end = 0; end <= full.length; end += 97) {
      const partial = full.slice(0, end)
      const result = splitStreamingMarkdown(partial, previous)
      expect(result.settled.join('') + result.live).toBe(partial)
      if (previous) {
        expect(result.settled.slice(0, previous.settled.length)).toEqual(previous.settled)
      }
      previous = result
    }
    expect(splitStreamingMarkdown(full, previous)).toEqual(splitStreamingMarkdown(full))
  })

  it('never cuts inside a fenced code block, even across the blank lines in it', () => {
    const fence = '```ts\n' + Array.from({ length: 40 }, (_, index) => `const value${index} = ${index}\n\n`).join('') + '```\n'
    const content = `${paragraph(1)}\n\n${fence}\n${paragraph(2)}\n\nstill going`
    const result = splitStreamingMarkdown(content, undefined, { minSegmentChars: 100, maxSegmentChars: 300 })

    expect(result.settled.join('') + result.live).toBe(content)
    expect(result.settled.length).toBeGreaterThan(1)
    for (const segment of result.settled) expect(fenceLines(segment) % 2).toBe(0)
  })

  it('falls back to a line break when prose runs past the maximum without a blank line', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `step ${index}: ${'reasoning about the request '.repeat(5)}`)
    const content = lines.join('\n')
    const result = splitStreamingMarkdown(content)

    expect(result.settled.join('') + result.live).toBe(content)
    expect(result.settled.length).toBeGreaterThan(0)
    for (const segment of result.settled) {
      expect(segment.length).toBeLessThanOrEqual(6_000 + lines[0]!.length + 1)
      expect(segment.endsWith('\n')).toBe(true)
    }
    expect(result.live.startsWith('step ')).toBe(true)
  })

  it('does not cut before an indented line, which may continue the block above it', () => {
    const content = `- ${paragraph(1)}\n\n  ${paragraph(2)}\n\n${paragraph(3)}\n\nmore`
    const result = splitStreamingMarkdown(content, undefined, { minSegmentChars: 100 })

    expect(result.settled.join('') + result.live).toBe(content)
    for (const segment of result.settled) expect(segment.startsWith(' ')).toBe(false)
    expect(result.live.startsWith(' ')).toBe(false)
    expect(result.settled[0]).toBe(`- ${paragraph(1)}\n\n  ${paragraph(2)}\n\n`)
  })

  it('starts over when the text no longer begins with what was settled', () => {
    const previous = splitStreamingMarkdown(paragraphs(6))
    const replaced = `A different block.\n\n${paragraphs(6)}`
    const result = splitStreamingMarkdown(replaced, previous)

    expect(result.settled.join('') + result.live).toBe(replaced)
    expect(result).toEqual(splitStreamingMarkdown(replaced))
  })

  it('does not close a fence with a matching marker followed by an info string', () => {
    const code = '```md\n' + paragraph(1) + '\n```ts\n\nkeep this code\n```\n'
    const result = splitStreamingMarkdown(code + '\nStill streaming', undefined, { minSegmentChars: 100 })
    expect(result.settled).toEqual([code + '\n'])
    expect(result.live).toBe('Still streaming')
  })
})
