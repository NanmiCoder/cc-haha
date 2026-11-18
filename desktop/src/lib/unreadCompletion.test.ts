import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../types/chat'
import { createUnreadCompletion, recoveredUnreadCompletion, resolveUnreadCompletion } from './unreadCompletion'

const user = (id: string, content: string, transcriptMessageId?: string) => ({
  id, type: 'user_text' as const, content, timestamp: 0, transcriptMessageId,
})
const reply = (id: string, content: string, transcriptMessageId?: string) => ({
  id, type: 'assistant_text' as const, content, timestamp: 0, transcriptMessageId,
})

describe('unread completion identity', () => {
  it('matches the second of two identical turns after the live transcript was released', () => {
    const done = reply('live-2', 'Done')
    const live = [user('u1', 'Run'), reply('live-1', 'Done'), user('u2', 'Run'), done]
    const marker = createUnreadCompletion(live, done)
    const restored = [
      user('history-u1', 'Run', 'u-one'), reply('history-a1', 'Done', 'a-one'),
      user('history-u2', 'Run', 'u-two'), reply('history-a2', 'Done', 'a-two'),
    ]
    expect(resolveUnreadCompletion(restored.slice(0, 2), marker)).toBeUndefined()
    expect(resolveUnreadCompletion(restored, marker)).toBe(restored[3])
    expect(resolveUnreadCompletion([...live, user('u3', 'Next'), reply('preamble', 'Starting')], marker)).toBe(done)
  })

  it('uses a stable tool id across windowed history, including identical replies after the same tool', () => {
    const tool = { id: 'live-tool', type: 'tool_use' as const, toolUseId: 'tool-u', toolName: 'Read', input: {}, timestamp: 0 }
    const done = reply('live-last', 'Done')
    const marker = createUnreadCompletion([user('omitted', 'Run'), tool, reply('live-first', 'Done'), done], done)
    const restored = [{ ...tool, id: 'restored-tool' }, reply('restored-first', 'Done', 'a1'), reply('restored-last', 'Done', 'a2')]
    expect(resolveUnreadCompletion(restored.slice(0, 2), marker)).toBeUndefined()
    expect(resolveUnreadCompletion(restored, marker)).toBe(restored[2])
  })

  it('keeps a known durable reply tied to its identity even across equally worded subsequent turns', () => {
    const target = reply('live', 'Done', 'a1')
    const marker = createUnreadCompletion([target], target)
    expect(resolveUnreadCompletion([reply('a2', 'Done', 'a2')], marker)).toBeUndefined()
    const hydrated = reply('a1-block-2', 'Done', 'a1')
    expect(resolveUnreadCompletion([hydrated], marker)).toBe(hydrated)
  })

  it('resolves the exact text block even when one SDK message includes two identical replies', () => {
    const first = reply('a-block-0', 'Done', 'a')
    const last = reply('a-block-2', 'Done', 'a')
    const rows: UIMessage[] = [first, { id: 'thought', type: 'thinking', content: '...', timestamp: 0 }, last]
    const marker = createUnreadCompletion(rows, last)
    expect(resolveUnreadCompletion(rows, marker)).toBe(last)
    const reloaded = rows.map(row => ({ ...row, id: 'restored-' + row.id }))
    expect(resolveUnreadCompletion(reloaded, marker)).toBe(reloaded[2])
    expect(resolveUnreadCompletion(reloaded.slice(0, 2), marker)).toBeUndefined()
  })

  it('recovers only a new durable reply in the turn that was observed running', () => {
    const current = user('live', 'Go')
    const previous = reply('old', 'Earlier', 'a1')
    const restoredUser = user('u1', 'Go', 'u1')
    const latest = reply('a2', 'Done', 'a2')
    const durable = [restoredUser, previous, latest]
    const marker = recoveredUnreadCompletion([current, previous], durable)!
    expect(resolveUnreadCompletion(durable, marker)).toBe(latest)
    expect(recoveredUnreadCompletion([current, previous], [restoredUser, previous])).toBeUndefined()
    expect(recoveredUnreadCompletion([current], [user('u0', 'Different', 'u0'), latest])).toBeUndefined()
    expect(recoveredUnreadCompletion([], durable)).toBeUndefined()
    const stopped: UIMessage = { id: 's', type: 'system', content: 'Stopped', timestamp: 0, generationStopped: true }
    expect(recoveredUnreadCompletion([current], [...durable, stopped])).toBeUndefined()
    expect(recoveredUnreadCompletion([current], [...durable, { id: 'error', type: 'error', message: 'error', code: 'SDK_ERROR', timestamp: 0 }])).toBeUndefined()
    expect(recoveredUnreadCompletion([current], [restoredUser, user('next', 'New turn'), latest])).toBeUndefined()
    expect(recoveredUnreadCompletion([current], [restoredUser, latest, {
      type: 'tool_use', id: 'tool', toolName: 'Read', toolUseId: 'tu', input: {}, timestamp: 1,
    }])).toBeUndefined()
  })
})
