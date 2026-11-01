import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ApiError } from '../../../middleware/errorHandler.js'
import { VOICE_VOCABULARY_MAX_TERMS } from '../types.js'
import {
  defaultVoiceVocabularyPath,
  FileVoiceVocabularyStore,
  normalizeAliases,
  normalizeVocabularyTerm,
} from './store.js'

const FIXTURE_V1 = path.join(import.meta.dir, '__fixtures__', 'voice-vocabulary.v1.json')

let tmpDir: string
let filePath: string
let clock: number
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-vocabulary-'))
  filePath = path.join(tmpDir, 'cc-haha', 'voice-vocabulary.json')
  clock = Date.parse('2026-11-01T00:00:00.000Z')
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function store() {
  return new FileVoiceVocabularyStore({ filePath, now: () => new Date(clock) })
}

const tick = (ms = 1000) => { clock += ms }
const readFile = async () => JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, any>

async function rejectsWith(promise: Promise<unknown>, status: number) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).statusCode).toBe(status)
    return
  }
  throw new Error('expected rejection')
}

describe('voice vocabulary file (persistence)', () => {
  test('lives in the cc-haha config folder', () => {
    expect(defaultVoiceVocabularyPath()).toBe(path.join(tmpDir, 'cc-haha', 'voice-vocabulary.json'))
  })

  test('a missing file reads as empty and is not created by reading', async () => {
    expect(await store().read()).toEqual({ terms: [], suggestions: [], history: null, maxTerms: VOICE_VOCABULARY_MAX_TERMS })
    expect((await store().snapshot()).terms).toEqual([])
    await expect(fs.stat(filePath)).rejects.toThrow()
  })

  test('a v1 file reads its valid entries and keeps every unknown field through a write', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.copyFile(FIXTURE_V1, filePath)

    const before = await store().read()
    expect(before.terms).toEqual([
      { term: 'Claude Code', aliases: ['cloud code', '克劳德扣的'], source: 'manual', addedAt: '2026-10-01T08:00:00.000Z' },
      { term: 'Codex', aliases: ['coded'], source: 'history', addedAt: '2026-10-02T08:00:00.000Z' },
    ])
    // Dismissed terms are hidden; ties on count go to the most recent.
    expect(before.suggestions.map(item => item.term)).toEqual(['DeepSeek', 'Agent Browser'])
    expect(before.history).toEqual({ lastRunAt: '2026-10-08T08:00:00.000Z', addedCount: 1 })

    await store().add([{ term: 'Gemini' }])

    const file = await readFile()
    expect(file.version).toBe(1)
    expect(file.futureTopLevel).toEqual({ keep: true })
    expect(file.terms[0]).toMatchObject({ term: 'Claude Code', futureEntryField: 'kept' })
    expect(file.terms.map((entry: { term: string }) => entry.term)).toEqual(['Claude Code', 'Codex', 'Gemini'])
    expect(file.suggestions.find((item: { term: string }) => item.term === 'Agent Browser')).toMatchObject({ futureSuggestionField: 7 })
    expect(file.history).toEqual({ lastRunAt: '2026-10-08T08:00:00.000Z', addedCount: 1, futureHistoryField: 'kept' })
    expect(file.dismissed).toEqual(['ignored-uppercase'])
  })

  test('an unparsable file reads as empty and is kept aside, not overwritten, on the next write', async () => {
    const corrupt = '{ "version": 1, "terms": [ { "term": "Claude Code", "aliases": [\n'
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, corrupt, 'utf-8')

    expect((await store().read()).terms).toEqual([])
    // Reading alone leaves the file as it was.
    expect(await fs.readFile(filePath, 'utf-8')).toBe(corrupt)

    await store().add([{ term: 'Codex' }])

    const siblings = await fs.readdir(path.dirname(filePath))
    const kept = siblings.filter(name => /^voice-vocabulary\.json\.corrupt-\d+$/.test(name))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(filePath), kept[0]!), 'utf-8')).toBe(corrupt)
    expect((await readFile()).terms.map((entry: { term: string }) => entry.term)).toEqual(['Codex'])
    expect(siblings.filter(name => name.includes('.tmp-'))).toEqual([])
  })

  test('a JSON value that is not an object is treated as corrupt too', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '["not", "an", "object"]', 'utf-8')
    await store().add([{ term: 'Codex' }])
    expect((await fs.readdir(path.dirname(filePath))).some(name => name.includes('.corrupt-'))).toBe(true)
  })

  test('concurrent writes are serialized and none is lost', async () => {
    const terms = Array.from({ length: 25 }, (_, index) => `Term${index}`)
    await Promise.all(terms.map(term => store().add([{ term }])))
    expect((await store().read()).terms.map(entry => entry.term).sort()).toEqual([...terms].sort())
  })
})

describe('term rules', () => {
  test('terms are trimmed, inner whitespace collapsed, 1–64 characters and single-line', () => {
    expect(normalizeVocabularyTerm('  Claude   Code ')).toBe('Claude Code')
    expect(normalizeVocabularyTerm('克'.repeat(64))).toBe('克'.repeat(64))
    expect(normalizeVocabularyTerm('克'.repeat(65))).toBeNull()
    expect(normalizeVocabularyTerm('two\nlines')).toBeNull()
    expect(normalizeVocabularyTerm('   ')).toBeNull()
    expect(normalizeVocabularyTerm(42)).toBeNull()
  })

  test('aliases follow the same rules, are unique ignoring case, never the term and at most ten', () => {
    expect(normalizeAliases(['cloud code', 'Cloud  Code', 'CLAUDE CODE', '', 'x\ny', '克劳德'], 'Claude Code'))
      .toEqual(['cloud code', '克劳德'])
    expect(normalizeAliases(Array.from({ length: 15 }, (_, index) => `alias ${index}`), 'Term')).toHaveLength(10)
    expect(normalizeAliases('not a list', 'Term')).toEqual([])
  })
})

describe('add', () => {
  test('adds new terms, merges aliases into existing ones and skips invalid or repeated entries', async () => {
    const first = await store().add([{ term: 'Claude Code', aliases: ['cloud code'] }, { term: 'Codex' }])
    expect(first).toMatchObject({ added: 2, merged: 0, skipped: 0 })
    expect(first.vocabulary.terms[0]).toEqual({
      term: 'Claude Code', aliases: ['cloud code'], source: 'manual', addedAt: '2026-11-01T00:00:00.000Z',
    })

    tick()
    const second = await store().add([
      { term: 'claude code', aliases: ['克劳德扣的', 'Cloud Code'] },
      { term: 'DeepSeek' },
      { term: 'deepseek' },
      { term: '' },
      { term: 'x'.repeat(65) },
    ], { source: 'correction' })
    expect(second).toMatchObject({ added: 1, merged: 1, skipped: 3 })
    expect(second.vocabulary.terms).toEqual([
      { term: 'Claude Code', aliases: ['cloud code', '克劳德扣的'], source: 'manual', addedAt: '2026-11-01T00:00:00.000Z' },
      { term: 'Codex', aliases: [], source: 'manual', addedAt: '2026-11-01T00:00:00.000Z' },
      { term: 'DeepSeek', aliases: [], source: 'correction', addedAt: '2026-11-01T00:00:01.000Z' },
    ])
  })

  test('stops at the size limit and counts the rest as skipped', async () => {
    const entries = Array.from({ length: VOICE_VOCABULARY_MAX_TERMS + 3 }, (_, index) => ({ term: `Term ${index}` }))
    const result = await store().add(entries)
    expect(result).toMatchObject({ added: VOICE_VOCABULARY_MAX_TERMS, skipped: 3 })
    // Existing terms still merge at the limit.
    expect(await store().add([{ term: 'Term 0', aliases: ['term zero'] }, { term: 'One more' }]))
      .toMatchObject({ added: 0, merged: 1, skipped: 1 })
  })

  test('adding takes a term out of dismissed and suggestions; dismiss moves others out of suggestions', async () => {
    await store().recordSuggestions([
      { from: 'agent brother', to: 'Agent Browser' },
      { from: 'deep seek', to: 'DeepSeek' },
      { from: 'jemini', to: 'Gemini' },
    ])
    await store().remove('Codex')

    const result = await store().add(
      [{ term: 'Agent Browser', aliases: ['agent brother'] }, { term: 'codex' }],
      { source: 'history', dismiss: ['DeepSeek', 'Agent Browser'] },
    )
    expect(result).toMatchObject({ added: 2, merged: 0 })
    expect(result.vocabulary.suggestions.map(item => item.term)).toEqual(['Gemini'])
    expect(result.vocabulary.history).toEqual({ lastRunAt: '2026-11-01T00:00:00.000Z', addedCount: 2 })
    const file = await readFile()
    expect(file.dismissed).toEqual(['deepseek'])

    // A later suggestion for a dismissed term is not recorded.
    expect(await store().recordSuggestions([{ from: 'deep sick', to: 'DeepSeek' }])).toBe(0)
  })

  test('history adds accumulate on top of the last run', async () => {
    tick()
    await store().markHistoryRun()
    await store().add([{ term: 'A1' }, { term: 'B2' }], { source: 'history' })
    await store().add([{ term: 'C3' }], { source: 'history' })
    await store().add([{ term: 'Manual' }])
    expect((await store().read()).history).toEqual({ lastRunAt: '2026-11-01T00:00:01.000Z', addedCount: 3 })

    tick()
    await store().markHistoryRun()
    expect((await store().read()).history).toEqual({ lastRunAt: '2026-11-01T00:00:02.000Z', addedCount: 3 })
  })
})

describe('update, remove and dismiss', () => {
  test('update replaces the entry found by its current term', async () => {
    await store().add([{ term: 'Claude Code', aliases: ['cloud code'] }, { term: 'Codex' }])

    const renamed = await store().update('claude code', { term: 'Claude  Code CLI', aliases: ['claude code cli', 'cc', 'CC'] })
    expect(renamed.terms[0]).toEqual({
      term: 'Claude Code CLI', aliases: ['cc'], source: 'manual', addedAt: '2026-11-01T00:00:00.000Z',
    })
    // Same key with new casing is not a collision.
    expect((await store().update('Codex', { term: 'CODEX', aliases: [] })).terms[1]!.term).toBe('CODEX')

    await rejectsWith(store().update('Missing', { term: 'Other', aliases: [] }), 404)
    await rejectsWith(store().update('Codex', { term: 'claude code cli', aliases: [] }), 409)
    await rejectsWith(store().update('Codex', { term: '   ', aliases: [] }), 400)
    await rejectsWith(store().update('Codex', { term: 'Ok', aliases: 'nope' as unknown as string[] }), 400)
  })

  test('remove deletes the term and stops suggesting it; re-adding it lifts that', async () => {
    await store().add([{ term: 'Codex' }])
    await store().recordSuggestions([{ from: 'coded', to: 'codex' }])

    const after = await store().remove('CODEX')
    expect(after.terms).toEqual([])
    expect(after.suggestions).toEqual([])
    expect((await readFile()).dismissed).toEqual(['codex'])
    expect(await store().recordSuggestions([{ from: 'coded', to: 'Codex' }])).toBe(0)

    await store().add([{ term: 'Codex' }])
    expect((await readFile()).dismissed).toEqual([])
  })

  test('dismissing a suggestion hides it for good', async () => {
    await store().recordSuggestions([{ from: 'agent brother', to: 'Agent Browser' }])
    expect((await store().dismissSuggestion('agent browser')).suggestions).toEqual([])
    expect(await store().recordSuggestions([{ from: 'agent brother', to: 'Agent Browser' }])).toBe(0)
    await rejectsWith(store().dismissSuggestion(''), 400)
  })
})

describe('suggestions from corrections', () => {
  test('records Latin-script terms of up to four words and 40 characters, counting repeats', async () => {
    expect(await store().recordSuggestions([
      { from: 'agent brother', to: 'Agent Browser' },
      { from: '克劳德', to: '克劳德代码' },
      { from: 'a b c d e', to: 'one two three four five' },
      { from: 'long', to: 'L'.repeat(41) },
    ])).toBe(1)

    tick()
    await store().recordSuggestions([
      { from: 'agent brother', to: 'Agent Browser' },
      { from: 'Agent Brother', to: 'Agent Browser' },
      { from: 'agent browse', to: 'agent browser' },
    ])
    expect((await store().read()).suggestions).toEqual([{
      term: 'agent browser',
      heardAs: ['agent brother', 'agent browse'],
      count: 4,
      lastSeenAt: '2026-11-01T00:00:01.000Z',
    }])
  })

  test('keeps at most five ways it was heard', async () => {
    await store().recordSuggestions(Array.from({ length: 8 }, (_, index) => ({ from: `heard ${index}`, to: 'Codex' })))
    const [suggestion] = (await store().read()).suggestions
    expect(suggestion!.heardAs).toEqual(['heard 0', 'heard 1', 'heard 2', 'heard 3', 'heard 4'])
    expect(suggestion!.count).toBe(8)
  })

  test('keeps the 100 most recently seen and sorts by count, then recency', async () => {
    for (let index = 0; index < 105; index += 1) {
      tick()
      await store().recordSuggestions([{ from: `heard ${index}`, to: `Term${index}` }])
    }
    tick()
    await store().recordSuggestions([{ from: 'again', to: 'Term50' }])

    const { suggestions } = await store().read()
    expect(suggestions).toHaveLength(100)
    expect(suggestions[0]!.term).toBe('Term50')
    expect(suggestions[1]!.term).toBe('Term104')
    expect(suggestions.some(item => item.term === 'Term4')).toBe(false)
    expect(suggestions.some(item => item.term === 'Term5')).toBe(true)
  })

  test('nothing worth recording does not touch the file', async () => {
    expect(await store().recordSuggestions([{ from: '克劳德', to: '克劳德代码' }])).toBe(0)
    await expect(fs.stat(filePath)).rejects.toThrow()
  })
})
