import { describe, expect, test } from 'bun:test'

import {
  SLICE_OMITTED_SECTIONS,
  appendEndState,
  runVccSliceCompaction,
  sectionsOf,
  stripRefsOutside,
} from './vccCompact.js'

// A slice shaped like the real thing: a user ask, an assistant turn that edits
// a file, and the tool result. Enough for the compiler to find file activity.
const slice = () => [
  {
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: 'Fix the streak rendering in the viewer.' },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Editing the viewer.' },
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/tmp/viewer.html' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  },
] as never[]

describe('slice compaction', () => {
  test('summarizes the span and keeps nothing, since the caller owns the pivot', () => {
    const result = runVccSliceCompaction({ messages: slice() })
    expect(result.summary.length).toBeGreaterThan(0)
    // A tail kept here would double-keep part of the summarized side, because
    // the caller already keeps the other side of the pivot verbatim.
    expect(result.messagesToKeep).toEqual([])
    expect(result.keptUserTurns).toBe(0)
  })

  test('never claims a session-wide section from half a conversation', () => {
    const result = runVccSliceCompaction({ messages: slice() })
    // These describe the session, not the span they would be read from, so a
    // slice must not print them under a header that promises otherwise.
    for (const header of SLICE_OMITTED_SECTIONS) {
      expect(result.summary).not.toContain(`[${header}]`)
      expect(sectionsOf(result.summary)).not.toContain(header)
    }
  })

  test('honours an explicit section selection so the policy can be tuned', () => {
    const all = runVccSliceCompaction({ messages: slice(), omitSections: [] })
    const none = runVccSliceCompaction({ messages: slice(), omitSections: SLICE_OMITTED_SECTIONS })
    // Suppression only ever removes, so an empty omit list cannot be smaller.
    expect(all.summary.length).toBeGreaterThanOrEqual(none.summary.length)
  })

  test('reports no sections for an empty span instead of inventing one', () => {
    const result = runVccSliceCompaction({ messages: [] })
    expect(result.summary.trim()).toBe('')
    expect(result.sections).toEqual([])
  })
})

// A slice that produces BOTH a suppressed section and a kept one, which is the
// only state in which the bug below is observable.
const twoSections = () => [
  {
    type: 'user',
    uuid: 'g1',
    message: {
      role: 'user',
      content: 'I want to refactor the viewer so the wind streaks render reliably. My preference is to keep the file small.',
    },
  },
  {
    type: 'assistant',
    uuid: 'g2',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Editing the viewer file.' },
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/tmp/viewer.html' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'g3',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  },
] as never[]

describe('section suppression is per-section', () => {
  test('dropping a session-claiming section keeps the span facts beside it', () => {
    // Sections are joined by a blank line inside one block, so a naive split on
    // `---` made the first header decide for all of them: suppressing
    // `Session Goal` also discarded `Files And Changes`. That is the section a
    // reader most needs, so the bug cost the feature its whole point.
    const all = runVccSliceCompaction({ messages: twoSections(), omitSections: [] })
    expect(sectionsOf(all.summary)).toContain('Session Goal')
    expect(sectionsOf(all.summary)).toContain('Files And Changes')

    const filtered = runVccSliceCompaction({ messages: twoSections() })
    expect(sectionsOf(filtered.summary)).not.toContain('Session Goal')
    expect(sectionsOf(filtered.summary)).toContain('Files And Changes')
    expect(filtered.summary).toContain('/tmp/viewer.html')
  })
})

describe('inherited refs that point outside the span', () => {
  // Exercised directly: whether a merged prior summary even carries refs
  // depends on which brief the merge preserves, so a slice-shaped fixture
  // asserts nothing reliable about this filter.
  test('keeps refs inside the span and removes the rest', () => {
    const inside = new Set([1, 2, 3])
    expect(stripRefsOutside('Done. (#2) and later (#8)', inside)).toBe('Done. (#2) and later ')
    expect(stripRefsOutside('see (#1, #2) x2', inside)).toBe('see (#1, #2) x2')
  })

  test('tidies a separated pair rather than leaving a dangling comma', () => {
    expect(stripRefsOutside('Edit "/tmp/a" (#13, #14) x2', new Set([13]))).toBe('Edit "/tmp/a" (#13) x2')
    expect(stripRefsOutside('Edit "/tmp/a" (#13, #14) x2', new Set())).toBe('Edit "/tmp/a"  x2')
  })
})

describe('end-of-span state', () => {
  const spanEnding = (text: string) => [
    { type: 'assistant', uuid: 'e1', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ] as never[]
  const line = 'The edit is in and the page renders again, verified in the browser.'

  test('appends the span\'s own closing words when the brief does not carry them', () => {
    const out = appendEndState('[Status]\n- busy', spanEnding(line))
    expect(out).toContain('[Where This Span Ended]')
    expect(out).toContain(line)
  })

  test('stays silent when the brief already carries them', () => {
    // Appending a second copy would read as a claim rather than a recap.
    const carried = `[Status]\n- busy\n\n${line}`
    expect(appendEndState(carried, spanEnding(line))).toBe(carried)
  })

  test('adds nothing when no assistant turn closed the span in words', () => {
    const toolOnly = [
      { type: 'assistant', uuid: 'e2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } },
      { type: 'assistant', uuid: 'e3', message: { role: 'assistant', content: [{ type: 'text', text: 'short' }] } },
    ] as never[]
    expect(appendEndState('[Status]\n- busy', toolOnly)).toBe('[Status]\n- busy')
  })
})
