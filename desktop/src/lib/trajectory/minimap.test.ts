import { describe, expect, it } from 'vitest'
import { buildMinimap, layoutRows, rowAtFraction } from './minimap'
import { makeRow } from './trajectoryFixtures'

function at(seconds: number) {
  return new Date(Date.UTC(2026, 9, 4, 10, 0, seconds)).toISOString()
}

describe('layoutRows', () => {
  it('gives every row the same slot in sequence mode', () => {
    const rows = [makeRow({ id: 'a', kind: 'user' }), makeRow({ id: 'b', kind: 'assistant' })]
    expect(layoutRows(rows, 'sequence')).toEqual([{ x: 0, w: 0.5 }, { x: 0.5, w: 0.5 }])
  })

  it('sizes rows by duration so the slow call dominates', () => {
    const rows = [
      makeRow({ id: 'u', kind: 'user', ts: at(0) }),
      makeRow({ id: 'fast', kind: 'tool', ts: at(1), resultTs: at(2) }),
      makeRow({ id: 'slow', kind: 'tool', ts: at(2), resultTs: at(11) }),
    ]
    const [user, fast, slow] = layoutRows(rows, 'duration')
    expect(slow!.w).toBeGreaterThan(fast!.w * 8)
    expect(user!.w).toBeGreaterThan(0)
    expect(slow!.x + slow!.w).toBeCloseTo(1)
  })
})

describe('buildMinimap', () => {
  it('bounds the span count by the bucket budget regardless of session size', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) =>
      makeRow({ id: `r${index}`, kind: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool', turn: Math.floor(index / 30) }),
    )
    const model = buildMinimap(rows, 'sequence', { buckets: 600 })
    expect(model.runs.length).toBeLessThanOrEqual(600 * 3)
    expect(model.positions.size).toBe(20_000)
  })

  it('places runs in the lane of their row kind and flags errors and the selection', () => {
    const rows = [
      makeRow({ id: 'u', kind: 'user', turn: 1 }),
      makeRow({ id: 'a', kind: 'assistant', turn: 1 }),
      makeRow({ id: 't', kind: 'tool', turn: 1, isError: true }),
      makeRow({ id: 'u2', kind: 'user', turn: 2 }),
    ]
    const model = buildMinimap(rows, 'sequence', { selectedId: 'a' })
    const byRow = new Map(model.runs.map((run) => [run.rowId, run]))
    expect(byRow.get('u')!.lane).toBe(0)
    expect(byRow.get('a')!.lane).toBe(1)
    expect(byRow.get('a')!.selected).toBe(true)
    expect(byRow.get('t')!.lane).toBe(2)
    expect(byRow.get('t')!.error).toBe(true)
    expect(byRow.get('t')!.kind).toBe('tool')
    expect(model.turnMarks).toEqual([0.75])
    // Failures also get a full-height mark so they survive bucketing.
    expect(model.errorMarks.map((mark) => mark.rowId)).toEqual(['t'])
  })

  it('shows the prompt, not the context sharing its bucket, in the input lane', () => {
    const rows = [makeRow({ id: 'c', kind: 'context' }), makeRow({ id: 'u', kind: 'user' })]
    const model = buildMinimap(rows, 'sequence', { buckets: 1 })
    const input = model.runs.filter((run) => run.lane === 0)
    expect(input).toHaveLength(1)
    expect(input[0]).toMatchObject({ kind: 'user', rowId: 'u' })
  })

  it('resolves a click between runs to the nearest row in that lane', () => {
    const rows = [
      makeRow({ id: 'u', kind: 'user' }),
      makeRow({ id: 'a', kind: 'assistant' }),
      makeRow({ id: 't', kind: 'tool' }),
      makeRow({ id: 'a2', kind: 'assistant' }),
    ]
    const model = buildMinimap(rows, 'sequence')
    expect(rowAtFraction(model, 0.9, 1)).toBe('a2')
    expect(rowAtFraction(model, 0.1, 1)).toBe('a')
    expect(rowAtFraction(model, 0.6, null)).toBe('t')
  })
})
