import { describe, expect, test } from 'bun:test'
import {
  RECENT_LIMIT,
  RecentSkillsRepository,
  parseRecent,
  recentKey,
  recordRecent,
  recordRecents,
  serializeRecent,
  type RecentItem,
} from './recentSkills'
import type { Storage } from '../state/storage'

const entry = (key: string, extra: Partial<RecentItem> = {}): Omit<RecentItem, 'usedAt'> => ({
  key,
  kind: 'command',
  name: key,
  description: `${key} 的说明`,
  ...extra,
})

function memory(initial: Record<string, string> = {}): Storage & { values: Record<string, string> } {
  const values = { ...initial }
  return {
    values,
    getItem: async (key) => values[key] ?? null,
    setItem: async (key, value) => {
      values[key] = value
    },
    removeItem: async (key) => {
      delete values[key]
    },
  }
}

describe('recent skills', () => {
  test('puts the latest use first and never lists the same item twice', () => {
    let list: RecentItem[] = []
    list = recordRecent(list, entry('a'), 1)
    list = recordRecent(list, entry('b'), 2)
    list = recordRecent(list, entry('a', { description: '更新后的说明' }), 3)
    expect(list.map((item) => item.key)).toEqual(['a', 'b'])
    expect(list[0]).toMatchObject({ usedAt: 3, description: '更新后的说明' })
  })

  test('keeps only the most recent eight', () => {
    let list: RecentItem[] = []
    for (let index = 0; index < 12; index++) list = recordRecent(list, entry(`k${index}`), index)
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(list[0]!.key).toBe('k11')
    expect(list.at(-1)!.key).toBe('k4')
    expect(list.some((item) => item.key === 'k3')).toBe(false)
  })

  test('items chosen together keep the order they were chosen in', () => {
    const list = recordRecents([], [entry('first'), entry('second'), entry('third')], 100)
    expect(list.map((item) => item.key)).toEqual(['first', 'second', 'third'])
    const next = recordRecents(list, [entry('third'), entry('new')], 200)
    expect(next.map((item) => item.key)).toEqual(['third', 'new', 'first', 'second'])
  })

  test('damaged local data is ignored instead of breaking the composer', () => {
    expect(parseRecent(null)).toEqual([])
    expect(parseRecent('{')).toEqual([])
    expect(parseRecent('{"items":"x"}')).toEqual([])
    const raw = JSON.stringify({
      items: [
        { key: 'ok', kind: 'skill', name: 'ok', usedAt: 5 },
        { key: 'ok', kind: 'skill', name: 'dup', usedAt: 9 },
        { key: 'bad-kind', kind: 'other', name: 'x', usedAt: 1 },
        { key: '', kind: 'skill', name: 'x', usedAt: 1 },
        { key: 'no-time', kind: 'skill', name: 'x' },
        null,
      ],
    })
    expect(parseRecent(raw).map((item) => [item.key, item.description])).toEqual([['ok', '']])
    const saved = recordRecent([], entry('a'), 1)
    expect(parseRecent(serializeRecent(saved))).toEqual(saved)
  })

  test('the repository persists records and serializes concurrent writes', async () => {
    const storage = memory()
    const repository = new RecentSkillsRepository(storage)
    await Promise.all([repository.record([entry('a')], 1), repository.record([entry('b')], 2)])
    expect((await repository.load()).map((item) => item.key)).toEqual(['b', 'a'])
    expect(JSON.parse(storage.values[recentKey]!).version).toBe(1)
    const broken = new RecentSkillsRepository(memory({ [recentKey]: 'not json' }))
    expect(await broken.load()).toEqual([])
    expect((await broken.record([entry('c')], 3)).map((item) => item.key)).toEqual(['c'])
  })
})
