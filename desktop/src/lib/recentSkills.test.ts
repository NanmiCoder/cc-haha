import { describe, expect, it } from 'vitest'
import { parseRecentSkills, readRecentSkills, recordRecentSkills, RECENT_SKILLS_MAX, RECENT_SKILLS_STORAGE_KEY } from './recentSkills'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    raw: (key: string) => values.get(key),
  }
}

describe('recent skills', () => {
  it('moves sent skills to the front, newest first, without duplicates', () => {
    const storage = memoryStorage()
    recordRecentSkills(['design'], storage)
    recordRecentSkills(['lint', 'design', 'lint'], storage)
    expect(readRecentSkills(storage)).toEqual(['lint', 'design'])
    expect(JSON.parse(storage.raw(RECENT_SKILLS_STORAGE_KEY)!)).toEqual({ version: 1, ids: ['lint', 'design'] })
  })

  it('keeps only the most recent entries', () => {
    const storage = memoryStorage()
    for (let index = 0; index < RECENT_SKILLS_MAX + 3; index++) recordRecentSkills([`skill-${index}`], storage)
    const ids = readRecentSkills(storage)
    expect(ids).toHaveLength(RECENT_SKILLS_MAX)
    expect(ids[0]).toBe(`skill-${RECENT_SKILLS_MAX + 2}`)
  })

  it('leaves storage alone when no skill was sent', () => {
    const storage = memoryStorage()
    recordRecentSkills([], storage)
    expect(storage.raw(RECENT_SKILLS_STORAGE_KEY)).toBeUndefined()
  })

  it.each([
    ['nothing stored', null],
    ['corrupt JSON', '{"ids":'],
    ['a bare array', '["design"]'],
    ['ids that are not a list', '{"version":1,"ids":"design"}'],
  ])('reads %s as an empty list', (_label, raw) => {
    expect(parseRecentSkills(raw)).toEqual([])
  })

  it('drops foreign entries from a stored list and still records over it', () => {
    const storage = memoryStorage({ [RECENT_SKILLS_STORAGE_KEY]: JSON.stringify({ version: 1, ids: ['design', 3, '', null, 'design', 'lint'] }) })
    expect(readRecentSkills(storage)).toEqual(['design', 'lint'])
    recordRecentSkills(['pdf'], storage)
    expect(readRecentSkills(storage)).toEqual(['pdf', 'design', 'lint'])
  })

  it('survives storage that throws', () => {
    const storage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readRecentSkills(storage)).toEqual([])
    expect(() => recordRecentSkills(['design'], storage)).not.toThrow()
  })
})
