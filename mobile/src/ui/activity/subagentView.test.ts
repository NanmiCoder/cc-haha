import { describe, expect, test } from 'bun:test'
import type { HistoryEntry } from '../../core/types'
import { subagentHeader, subagentRunView } from './subagentView'

const entry = (id: string, type: HistoryEntry['type'], content: unknown, timestamp = '2026-10-25T10:00:00.000Z'): HistoryEntry => ({
  id,
  type,
  content,
  timestamp,
})
const messages: HistoryEntry[] = [
  entry('m1', 'user', 'Go through the existing pairing flow and list the places that need changes.'),
  entry('m2', 'assistant', [
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/a.ts' } },
    { type: 'tool_use', id: 'r2', name: 'Grep', input: { pattern: 'pair' } },
  ]),
  entry('m3', 'user', [
    { type: 'tool_result', tool_use_id: 'r1', content: 'file a' },
    { type: 'tool_result', tool_use_id: 'r2', content: '3 matches' },
  ]),
  entry('m4', 'assistant', [{ type: 'text', text: 'Connection entry points are concentrated in connectHost.ts.' }]),
  entry('m5', 'assistant', [{ type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: '/repo/connectHost.ts' } }]),
]

describe('subagentRunView Normalize into the same timeline as the main conversation', () => {
  test('The first user message is the task given by the main agent; tool results merge into tool rows and do not become user bubbles', () => {
    const view = subagentRunView({ messages }, true)
    expect(view.prompt?.text).toBe('Go through the existing pairing flow and list the places that need changes.')
    const kinds = view.rows.map((row) => row.kind)
    expect(kinds.filter((kind) => kind === 'message')).toHaveLength(2) // prompt + Text reply
    const groups = view.rows.filter((row) => row.kind === 'steps')
    expect(groups).toHaveLength(2)
    expect(groups[0]?.kind === 'steps' && groups[0].steps.map((step) => step.result !== undefined)).toEqual([true, true])
    expect(view.empty).toBe(false)
  })
  test('Running: the current step is a tool without a result yet; none after finishing', () => {
    expect(subagentRunView({ messages }, true).current).toMatchObject({ verb: 'Read', object: '/repo/connectHost.ts' })
    expect(subagentRunView({ messages }, false).current).toBeNull()
  })
  test('While running the last group is live (carried by the current step row); after finishing the process collapses into one row', () => {
    const running = subagentRunView({ messages }, true)
    expect(running.rows.at(-1)).toMatchObject({ kind: 'steps', live: true })
    expect(running.rows.some((row) => row.kind === 'turn')).toBe(false)
    const finished = subagentRunView({ messages: messages.slice(0, 4) }, false)
    expect(finished.rows.every((row) => row.kind !== 'steps' || !row.live)).toBe(true)
  })
  test('transcript empty: blank while running, falls back to the result from the computer after finishing', () => {
    expect(subagentRunView({ messages: [], result: 'All done' }, true)).toMatchObject({ rows: [], empty: true })
    const done = subagentRunView({ messages: [], result: 'All done' }, false)
    expect(done.rows).toHaveLength(1)
    expect(done.rows[0]).toMatchObject({ kind: 'message', item: { type: 'assistant', text: 'All done' } })
    expect(done.empty).toBe(false)
    expect(subagentRunView({ messages: [] }, false).empty).toBe(true)
  })
  test('No data / truncation marker', () => {
    expect(subagentRunView(null, true)).toMatchObject({ rows: [], prompt: null, empty: true })
    expect(subagentRunView({ messages, truncated: true }, false).truncated).toBe(true)
  })
})

describe('subagentHeader', () => {
  test('Name comes from the task description; state follows the background task list, falling back to the transcript state when not found', () => {
    expect(
      subagentHeader({ taskId: 't', status: 'running', description: ' explorer ', startedAt: '2026-10-25T10:00:00.000Z' }, { status: 'completed' })
    ).toEqual({ title: 'explorer', status: 'running', startedAt: Date.parse('2026-10-25T10:00:00.000Z') })
    expect(subagentHeader(undefined, { status: 'running' })).toEqual({ title: 'Subagent', status: 'running' })
    expect(subagentHeader(undefined, { status: 'weird' })).toMatchObject({ status: 'completed' })
    expect(subagentHeader(undefined, null)).toMatchObject({ title: 'Subagent', status: 'completed' })
  })
})
