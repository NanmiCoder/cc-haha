import { describe, expect, it } from 'vitest'
import type { VoiceVocabularyEntry } from '@/api/voice'
import { cleanVocabularyTerm, parseBulkVocabulary, parseVocabularyAliases } from './voiceVocabularyText'

const existing: VoiceVocabularyEntry[] = [
  { term: 'JSVMP', aliases: [], source: 'manual', addedAt: '2026-11-01T00:00:00.000Z' },
]

describe('cleanVocabularyTerm', () => {
  it('trims and collapses whitespace, and rejects empty or over-long terms', () => {
    expect(cleanVocabularyTerm('  Agent   Browser ')).toBe('Agent Browser')
    expect(cleanVocabularyTerm('   ')).toBeNull()
    expect(cleanVocabularyTerm('x'.repeat(64))).toBe('x'.repeat(64))
    expect(cleanVocabularyTerm('x'.repeat(65))).toBeNull()
  })
})

describe('parseVocabularyAliases', () => {
  it('splits on ASCII and full-width commas and 、, dedupes case-insensitively and drops the term itself', () => {
    expect(parseVocabularyAliases('eagle net， go net、Eagle Net, ego lite', 'ego lite')).toEqual(['eagle net', 'go net'])
  })

  it('keeps at most ten', () => {
    expect(parseVocabularyAliases(Array.from({ length: 12 }, (_, index) => `a${index}`).join(','))).toHaveLength(10)
  })
})

describe('parseBulkVocabulary', () => {
  it('reads the design example: new terms, one already present, one repeated line', () => {
    const text = [
      'cc-haha = CC杠哈哈, 西西哈哈',
      'Agent Browser = agent brother',
      'ego lite = eagle net, go net',
      'MediaCrawler = media crawl',
      'ModelDial',
      'JSVMP = GSVMP',
      'OpenRouter',
      'Seedance',
      'SenseNova',
      'Eigenflux',
      'cc-haha',
    ].join('\n')

    const preview = parseBulkVocabulary(text, existing)

    expect(preview).toMatchObject({ added: 9, merged: 1, duplicates: 1, invalid: 0 })
    expect(preview.entries).toHaveLength(10)
    expect(preview.entries[0]).toEqual({ term: 'cc-haha', aliases: ['CC杠哈哈', '西西哈哈'] })
    expect(preview.entries.find(entry => entry.term === 'JSVMP')).toEqual({ term: 'JSVMP', aliases: ['GSVMP'] })
  })

  it('accepts full-width ＝, ignores blank lines, and merges aliases of a repeated term', () => {
    const preview = parseBulkVocabulary('Codex ＝ coded\n\n  \ncodex = code x、Coded\n', [])
    expect(preview.entries).toEqual([{ term: 'Codex', aliases: ['coded', 'code x'] }])
    expect(preview).toMatchObject({ added: 1, merged: 0, duplicates: 1 })
  })

  it('counts over-long terms as invalid instead of adding them', () => {
    const preview = parseBulkVocabulary(`${'x'.repeat(65)}\nok`, [])
    expect(preview.entries).toEqual([{ term: 'ok', aliases: [] }])
    expect(preview.invalid).toBe(1)
  })
})
