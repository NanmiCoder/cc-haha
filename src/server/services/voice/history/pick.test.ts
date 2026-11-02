import { describe, expect, test } from 'bun:test'
import {
  buildPickUserMessage,
  HISTORY_PICK_SYSTEM_PROMPT,
  isLocallyDoubtful,
  parsePickResponse,
} from './pick.js'
import type { VoiceHistoryGroup } from '../types.js'
import type { HistoryCandidate } from './scan.js'

const candidates: HistoryCandidate[] = [
  { term: 'claude', sessions: 120, count: 400 },
  { term: 'Codex', sessions: 90, count: 300 },
  { term: 'deepseek', sessions: 40, count: 80 },
  { term: 'cc-haha', sessions: 30, count: 50 },
  { term: 'Go', sessions: 12, count: 20 },
  { term: 'dont', sessions: 9, count: 12 },
  { term: 'review', sessions: 200, count: 900 },
]

describe('pick request', () => {
  test('sends only candidate words and session counts, one per line', () => {
    expect(buildPickUserMessage(candidates.slice(0, 2))).toBe('claude\t120\nCodex\t90')
  })

  test('asks for grouped JSON with doubtful flags', () => {
    expect(HISTORY_PICK_SYSTEM_PROMPT).toContain('{"groups":[{"category":"project|model|tool|other","terms":[{"term":"…","doubtful":false}]}]}')
    expect(HISTORY_PICK_SYSTEM_PROMPT).toContain('<TAB>')
  })
})

describe('parsePickResponse', () => {
  test('keeps candidates only, in the model\'s casing, once across groups, in category order', () => {
    const answer = JSON.stringify({
      groups: [
        { category: 'tool', terms: [{ term: 'cc-haha', doubtful: false }, { term: 'Bun', doubtful: false }] },
        { category: 'model', terms: [{ term: 'Claude', doubtful: false }, { term: 'DeepSeek', doubtful: false }] },
        { category: 'project', terms: [{ term: 'CLAUDE', doubtful: false }, 'Codex'] },
        { category: 'weird', terms: [{ term: 'Go' }, { term: 'Claude Code', doubtful: false }, { nope: true }] },
      ],
    })

    expect(parsePickResponse(answer, candidates, new Set(['codex']))).toEqual([
      { category: 'project', terms: [{ term: 'Codex', sessions: 90, doubtful: false, inVocabulary: true }] },
      {
        category: 'model',
        terms: [
          { term: 'Claude', sessions: 120, doubtful: false, inVocabulary: false },
          { term: 'DeepSeek', sessions: 40, doubtful: false, inVocabulary: false },
        ],
      },
      { category: 'tool', terms: [{ term: 'cc-haha', sessions: 30, doubtful: false, inVocabulary: false }] },
      // Unknown category → other; "Go" is short mixed case → doubtful even though the model said nothing.
      { category: 'other', terms: [{ term: 'Go', sessions: 12, doubtful: true, inVocabulary: false }] },
    ])
  })

  test('reads JSON inside a code fence or after leading prose', () => {
    const json = '{"groups":[{"category":"model","terms":[{"term":"DeepSeek","doubtful":true}]}]}'
    const expected: VoiceHistoryGroup[] = [{ category: 'model', terms: [{ term: 'DeepSeek', sessions: 40, doubtful: true, inVocabulary: false }] }]
    expect(parsePickResponse('```json\n' + json + '\n```', candidates, new Set())).toEqual(expected)
    expect(parsePickResponse('好的，以下是结果：\n' + json + '\n希望有帮助', candidates, new Set())).toEqual(expected)
  })

  test('accepts the flat {"terms": [...]} shape as other', () => {
    expect(parsePickResponse('{"terms":["Codex","dont"]}', candidates, new Set())).toEqual([{
      category: 'other',
      terms: [
        { term: 'Codex', sessions: 90, doubtful: false, inVocabulary: false },
        { term: 'dont', sessions: 9, doubtful: true, inVocabulary: false },
      ],
    }])
  })

  test('caps the result at 100 terms', () => {
    const many: HistoryCandidate[] = Array.from({ length: 150 }, (_, index) => ({ term: `Term${index}`, sessions: 3, count: 3 }))
    const answer = JSON.stringify({ groups: [{ category: 'tool', terms: many.map(item => ({ term: item.term })) }] })
    expect(parsePickResponse(answer, many, new Set())![0]!.terms).toHaveLength(100)
  })

  test('returns null when there is no usable JSON, and no groups for an empty pick', () => {
    expect(parsePickResponse('I cannot help with that.', candidates, new Set())).toBeNull()
    expect(parsePickResponse('{"result": "none"}', candidates, new Set())).toBeNull()
    expect(parsePickResponse('{"groups": []}', candidates, new Set())).toEqual([])
  })
})

describe('local doubtful heuristic', () => {
  test('flags very short mixed-case words, contractions and known fragments', () => {
    expect(isLocallyDoubtful('Go')).toBe(true)
    expect(isLocallyDoubtful('AI')).toBe(false)
    expect(isLocallyDoubtful("don't")).toBe(true)
    expect(isLocallyDoubtful('e.g')).toBe(true)
    expect(isLocallyDoubtful('whats')).toBe(true)
    expect(isLocallyDoubtful('Codex')).toBe(false)
  })
})
