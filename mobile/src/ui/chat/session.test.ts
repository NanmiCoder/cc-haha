import { describe, expect, test } from 'bun:test'
import type { ChatItem, Session } from '../../core/types'
import type { Checkpoint } from '../../core/operations'
import {
  contextPercent,
  contextWindow,
  displayPath,
  latestTurnCheckpoint,
  nextTurnStart,
  projectName,
  sessionSubtitle,
  turnMeta,
} from './session'

const session = (patch: Partial<Session>): Session => ({
  id: 's',
  title: 't',
  createdAt: '',
  modifiedAt: '',
  messageCount: 0,
  projectPath: '/Users/me/code/cc-haha',
  workDir: '/Users/me/code/cc-haha',
  workDirExists: true,
  ...patch,
})
const checkpoint = (index: number, count: number, startedAt?: number): Checkpoint => ({
  target: { targetUserMessageId: `u${index}`, userMessageIndex: index, userMessageCount: count },
  code: { available: true, filesChanged: ['a.ts'], insertions: 1, deletions: 0 },
  ...(startedAt === undefined ? {} : { startedAt }),
})

describe('navigation subtitle', () => {
  test('uses the repository root for worktrees and appends the branch only when known', () => {
    const worktree = session({ projectRoot: '/Users/me/code/cc-haha', workDir: '/tmp/worktrees/feat-x' })
    expect(projectName(worktree)).toBe('cc-haha')
    expect(sessionSubtitle(worktree, 'main')).toBe('cc-haha · main')
    expect(sessionSubtitle(worktree, null)).toBe('cc-haha')
    expect(sessionSubtitle(session({ projectRoot: null, workDir: 'C:\\code\\app\\' }), '  ')).toBe('app')
    expect(sessionSubtitle(null, 'main')).toBe('main')
  })

  test('abbreviates only a real home directory prefix', () => {
    expect(displayPath('/Users/me/code/cc-haha')).toBe('~/code/cc-haha')
    expect(displayPath('/home/dev')).toBe('~')
    expect(displayPath('/opt/Users/me')).toBe('/opt/Users/me')
    expect(displayPath(null)).toBe('')
  })
})

describe('context usage', () => {
  test('is only computed when the model declares its window', () => {
    expect(contextWindow('claude-sonnet-4-5')).toBeUndefined()
    expect(contextWindow('claude-sonnet-4-5[1m]')).toBe(1_000_000)
    expect(contextWindow('claude-sonnet-4-5', '200k')).toBe(200_000)
    expect(contextWindow('x', '1M')).toBe(1_000_000)
    expect(contextWindow('x', '')).toBeUndefined()
    expect(contextWindow('x', 'large')).toBeUndefined()
    const usage = { input_tokens: 400_000, output_tokens: 10, cache_read_tokens: 20_000 }
    expect(contextPercent(usage, contextWindow('claude-sonnet-4-5[1m]'))).toBe(42)
    expect(contextPercent(usage, undefined)).toBeUndefined()
    expect(contextPercent(undefined, 1_000_000)).toBeUndefined()
  })
})

describe('turn clock', () => {
  const now = Date.parse('2026-10-25T10:00:00Z')
  test('a turn seen starting while connected uses the local time', () => {
    expect(
      nextTurnStart({
        previous: { active: false, live: true },
        active: true,
        lastUserTimestamp: '2026-10-25T09:00:00Z',
        now,
      })
    ).toBe(now)
  })

  test('a turn already running when the page opens uses the last user message time', () => {
    expect(
      nextTurnStart({ previous: undefined, active: true, lastUserTimestamp: '2026-10-25T09:59:00Z', now })
    ).toBe(now - 60_000)
    expect(nextTurnStart({ previous: { active: false, live: false }, active: true, now })).toBe(now)
    // A future or malformed timestamp never produces a negative duration.
    expect(
      nextTurnStart({ previous: undefined, active: true, lastUserTimestamp: '2026-10-25T11:00:00Z', now })
    ).toBe(now)
  })

  test('keeps the start for the rest of the turn and clears it when idle', () => {
    expect(nextTurnStart({ previous: { active: true, startedAt: 5, live: true }, active: true, now })).toBe(5)
    expect(nextTurnStart({ previous: { active: true, startedAt: 5, live: true }, active: false, now })).toBeUndefined()
  })
})

describe('turn meta line', () => {
  const at = (value: string) => new Date(value).getTime()
  const history: ChatItem[] = [
    { id: 'u0', type: 'user', text: 'old', timestamp: '2026-10-25T08:00:00' },
    { id: 'a0', type: 'assistant', text: 'old', timestamp: '2026-10-25T08:01:00' },
    { id: 'u1', type: 'user', text: 'now', timestamp: '2026-10-25T14:26:00' },
    { id: 't1', type: 'tool', text: '', timestamp: '2026-10-25T14:28:00' },
    { id: 'a1', type: 'assistant', text: 'done', model: 'claude-sonnet-4-5', timestamp: '2026-10-25T14:32:12' },
  ]
  test('history uses message timestamps of the last turn', () => {
    expect(turnMeta({ items: history })).toBe('14:32 · 用时 6:12 · claude-sonnet-4-5')
  })

  test('a turn watched live uses the locally recorded start and end', () => {
    const items: ChatItem[] = [
      ...history,
      { id: 'live:s:1', type: 'user', text: 'again' },
      { id: 'live:s:2', type: 'assistant', text: 'ok', model: 'deepseek-v4-flash' },
    ]
    const startedAt = at('2026-10-25T15:00:00')
    expect(turnMeta({ items, local: { startedAt, endedAt: startedAt + 75_000 } })).toBe(
      '15:01 · 用时 1:15 · deepseek-v4-flash'
    )
  })

  test('omits what cannot be computed', () => {
    const items: ChatItem[] = [
      { id: 'live:s:1', type: 'user', text: 'x' },
      { id: 'live:s:2', type: 'assistant', text: 'y' },
    ]
    expect(turnMeta({ items, modelId: 'gpt-5' })).toBe('gpt-5')
    expect(turnMeta({ items: [{ id: 'u', type: 'user', text: 'x' }] })).toBe('')
  })

  test('falls back to the latest-turn checkpoint start when the user record has no time', () => {
    const items: ChatItem[] = [
      { id: 'u', type: 'user', text: 'x' },
      { id: 'a', type: 'assistant', text: 'y', timestamp: '2026-10-25T10:02:00' },
    ]
    expect(turnMeta({ items, checkpoint: checkpoint(0, 1, at('2026-10-25T10:00:30')) })).toBe('10:02 · 用时 1:30')
    // An older turn's checkpoint is not this turn's start.
    expect(turnMeta({ items, checkpoint: checkpoint(0, 2, at('2026-10-25T10:00:30')) })).toBe('10:02')
  })
})

describe('latest turn checkpoint', () => {
  test('is the newest checkpoint only when it belongs to the last turn', () => {
    expect(latestTurnCheckpoint([checkpoint(1, 2), checkpoint(0, 2)])?.target.userMessageIndex).toBe(1)
    expect(latestTurnCheckpoint([checkpoint(0, 2)])).toBeUndefined()
    expect(latestTurnCheckpoint([])).toBeUndefined()
  })
})

test('a turn shorter than a second shows no duration instead of 0:00', () => {
  const items = [
    { id: 'u', type: 'user', text: 'hi', timestamp: '2026-10-25T10:00:00.000Z' },
    { id: 'a', type: 'assistant', text: 'ok', timestamp: '2026-10-25T10:00:00.400Z', model: 'm' },
  ] as never
  expect(turnMeta({ items })).not.toContain('用时')
})
