import { describe, expect, it } from 'vitest'
import { mergeRowPieces, mergeRows } from './mergeRows'
import { buildTrajectoryItems, computeTotals, orderTrajectoryRows, rowDurationMs, wallClockMs } from './viewModel'
import { makeRow } from './trajectoryFixtures'

const NO_OPTIONS = { collapsedTurns: new Set<number>(), hideTools: false, query: '' }

describe('mergeRows', () => {
  it('pairs a tool_use piece with a later tool_result piece into one row', () => {
    const use = makeRow({ id: 't:1', kind: 'tool', ts: '2026-10-04T10:00:01.000Z', toolName: 'Bash', inputPreview: '{"command":"ls"}', loc: [[100, 150]], parentId: 'a:m1' })
    const result = makeRow({ id: 't:1', kind: 'tool', ts: '2026-10-04T10:00:04.000Z', resultTs: '2026-10-04T10:00:04.000Z', resultPreview: 'a.txt', partial: true, loc: [[300, 340]] })
    const merged = mergeRows(new Map([[use.id, use]]), [result]).get('t:1')!
    expect(merged.ts).toBe(use.ts)
    expect(merged.toolName).toBe('Bash')
    expect(merged.resultPreview).toBe('a.txt')
    expect(merged.partial).toBeUndefined()
    expect(merged.loc).toEqual([[100, 150], [300, 340]])
    expect(rowDurationMs(merged)).toBe(3000)
  })

  it('is idempotent when the same piece is delivered twice', () => {
    const piece = makeRow({ id: 'a:m1', kind: 'assistant', preview: 'hello', toolOnly: false, loc: [[10, 20]] })
    const once = mergeRows(new Map(), [piece])
    const twice = mergeRows(once, [piece])
    expect(twice.get('a:m1')).toEqual(once.get('a:m1'))
  })

  it('keeps the largest usage of any piece, because desktop transcripts put the final usage on the last block only', () => {
    const early = makeRow({ id: 'a:m2', kind: 'assistant', ts: '2026-10-04T10:00:02.000Z', usage: { input: 900, output: 0, cacheRead: 0, cacheWrite: 0 }, loc: [[100, 110]] })
    const late = makeRow({ id: 'a:m2', kind: 'assistant', ts: '2026-10-04T10:00:05.000Z', usage: { input: 900, output: 770, cacheRead: 4000, cacheWrite: 12 }, partial: true, loc: [[200, 210]] })
    // Whichever page arrives first, the merged row reports the final usage.
    expect(mergeRowPieces(early, late).usage).toEqual({ input: 900, output: 770, cacheRead: 4000, cacheWrite: 12 })
    expect(mergeRowPieces(late, early).usage).toEqual({ input: 900, output: 770, cacheRead: 4000, cacheWrite: 12 })
  })

  it('keeps the earlier text and ANDs toolOnly across assistant pieces split by a page boundary', () => {
    const later = makeRow({ id: 'a:m1', kind: 'assistant', ts: '2026-10-04T10:00:05.000Z', preview: '', toolOnly: true, partial: true, loc: [[500, 560]] })
    const earlier = makeRow({ id: 'a:m1', kind: 'assistant', ts: '2026-10-04T10:00:02.000Z', startTs: '2026-10-04T10:00:00.000Z', preview: 'Let me check', toolOnly: false, loc: [[400, 480]] })
    const merged = mergeRowPieces(later, earlier)
    expect(merged.ts).toBe(earlier.ts)
    expect(merged.endTs).toBe(later.ts)
    expect(merged.preview).toBe('Let me check')
    expect(merged.toolOnly).toBe(false)
    expect(merged.startTs).toBe(earlier.startTs)
    expect(rowDurationMs(merged)).toBe(5000)
  })
})

describe('orderTrajectoryRows', () => {
  it('keeps file order and puts a snapshot row between the prompt and the response it was sent with', () => {
    const user = makeRow({ id: 'u:1', kind: 'user', ts: '2026-10-04T10:00:00.000Z', loc: [[0, 10]] })
    const assistant = makeRow({ id: 'a:m1', kind: 'assistant', ts: '2026-10-04T10:00:03.000Z', loc: [[20, 30]] })
    const tool = makeRow({ id: 't:1', kind: 'tool', ts: '2026-10-04T10:00:03.000Z', loc: [[20, 30]] })
    const snapshot = makeRow({ id: 's:main:0', kind: 'system', turn: null, ts: '2026-10-04T10:00:01.000Z', loc: [], snapshot: { scope: 'main', change: 'initial' } })
    const ordered = orderTrajectoryRows(new Map([[tool.id, tool], [assistant.id, assistant], [user.id, user]]), [snapshot])
    expect(ordered.map((row) => row.id)).toEqual(['u:1', 's:main:0', 'a:m1', 't:1'])
    // The snapshot takes the turn of the response it precedes.
    expect(ordered[1]!.turn).toBe(1)
  })

  it('holds back snapshots that belong to history not loaded yet', () => {
    const user = makeRow({ id: 'u:9', kind: 'user', turn: 9, ts: '2026-10-04T12:00:00.000Z', loc: [[9000, 9010]] })
    const old = makeRow({ id: 's:main:0', kind: 'system', turn: null, ts: '2026-10-04T09:00:00.000Z', loc: [], snapshot: { scope: 'main', change: 'initial' } })
    const recent = makeRow({ id: 's:main:5', kind: 'system', turn: null, ts: '2026-10-04T12:00:01.000Z', loc: [], snapshot: { scope: 'main', change: 'tools' } })
    const rows = new Map([[user.id, user]])
    expect(orderTrajectoryRows(rows, [old, recent], { hasOlder: true }).map((row) => row.id)).toEqual(['u:9', 's:main:5'])
    // Once the head of the file is loaded, the initial prompt has its place again.
    expect(orderTrajectoryRows(rows, [old, recent], { hasOlder: false }).map((row) => row.id)).toEqual(['s:main:0', 'u:9', 's:main:5'])
  })
})

describe('wallClockMs', () => {
  it('merges overlapping calls instead of summing them', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 10, 0, s)).toISOString()
    const parallel = [
      makeRow({ id: 't:a', kind: 'tool', ts: at(0), resultTs: at(10) }),
      makeRow({ id: 't:b', kind: 'tool', ts: at(2), resultTs: at(8) }),
      makeRow({ id: 't:c', kind: 'tool', ts: at(20), resultTs: at(25) }),
    ]
    expect(wallClockMs(parallel)).toBe(15_000)
  })
})

describe('buildTrajectoryItems', () => {
  const rows = [
    makeRow({ id: 'u:1', kind: 'user', turn: 1, preview: 'build it' }),
    makeRow({ id: 'a:1', kind: 'assistant', turn: 1 }),
    makeRow({ id: 't:1', kind: 'tool', turn: 1, parentId: 'a:1', toolName: 'Bash', inputPreview: 'npm install' }),
    makeRow({ id: 't:2', kind: 'tool', turn: 1, parentId: 'a:1', toolName: 'Read' }),
    makeRow({ id: 'u:2', kind: 'user', turn: 2, preview: 'now test it' }),
    makeRow({ id: 'a:2', kind: 'assistant', turn: 2, preview: 'done' }),
  ]

  it('marks the first row of every turn', () => {
    const items = buildTrajectoryItems(rows, NO_OPTIONS)
    expect(items.filter((item) => item.type === 'row' && item.turnStart).map((item) => item.key)).toEqual(['u:1', 'u:2'])
  })

  it('folds a collapsed turn to its prompt plus a summary of what it hides', () => {
    const items = buildTrajectoryItems(rows, { ...NO_OPTIONS, collapsedTurns: new Set([1]) })
    expect(items.map((item) => item.key)).toEqual(['u:1', 'summary:1', 'u:2', 'a:2'])
    const summary = items[1]!
    expect(summary.type === 'summary' && summary.hiddenRows).toBe(3)
    expect(summary.type === 'summary' && summary.toolCount).toBe(2)
  })

  it('hides tool rows and summarizes them, failures included, on the assistant that issued them', () => {
    const withFailure = rows.map((row) => (row.id === 't:1' ? { ...row, isError: true } : row))
    const items = buildTrajectoryItems(withFailure, { ...NO_OPTIONS, hideTools: true })
    expect(items.map((item) => item.key)).toEqual(['u:1', 'a:1', 'u:2', 'a:2'])
    const assistant = items[1]!
    expect(assistant.type === 'row' && assistant.hiddenTools).toEqual({ count: 2, errors: 1, names: [['Bash', 1], ['Read', 1]] })
  })

  it('searches across folded turns and hidden tools with AND semantics', () => {
    const items = buildTrajectoryItems(rows, { collapsedTurns: new Set([1]), hideTools: true, query: 'bash  npm' })
    expect(items.map((item) => item.key)).toEqual(['t:1'])
  })
})

describe('computeTotals', () => {
  it('sums usage over assistant rows and counts turns, steps and tools', () => {
    const totals = computeTotals([
      makeRow({ id: 'u:1', kind: 'user', turn: 1 }),
      makeRow({ id: 'a:1', kind: 'assistant', turn: 1, usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 } }),
      makeRow({ id: 't:1', kind: 'tool', turn: 1, isError: true }),
      makeRow({ id: 'a:2', kind: 'assistant', turn: 2, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
    ])
    expect(totals).toEqual({ turns: 2, firstTurn: 1, steps: 2, tools: 1, errors: 1, input: 11, output: 7, cacheRead: 103, cacheWrite: 24 })
  })
})
