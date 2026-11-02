import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { VOICE_HISTORY_SOURCE_IDS } from '../history/scan.js'
import { VOICE_DOWNLOAD_SOURCES, VOICE_LANGUAGES } from '../preferences.js'
import { VOICE_LIMITS } from '../types.js'
import { isVoiceVocabularySource } from '../vocabulary/store.js'
import { makeWav } from './fakeProvider.js'

// The desktop renderer keeps a hand-written mirror of the server contract. These
// tests read both source files and compare them so the two cannot drift apart.
const repoRoot = path.resolve(import.meta.dir, '../../../../..')
const serverSource = fs.readFileSync(path.join(repoRoot, 'src/server/services/voice/types.ts'), 'utf-8')
const desktopSource = fs.readFileSync(path.join(repoRoot, 'desktop/src/api/voice.ts'), 'utf-8')
const desktopPreferencesSource = fs.readFileSync(path.join(repoRoot, 'desktop/src/api/desktopUiPreferences.ts'), 'utf-8')

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function literalUnion(source: string, name: string): string[] {
  const text = stripComments(source)
  const start = text.indexOf(`export type ${name} =`)
  if (start < 0) throw new Error(`type ${name} not found`)
  const rest = text.slice(start)
  const end = rest.search(/\n\s*\n|\nexport /)
  const literals = [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/'([^']+)'/g)].map(item => item[1]!)
  if (literals.length === 0) throw new Error(`type ${name} has no string literals`)
  return literals.sort()
}

function objectFields(source: string, name: string): Record<string, string> {
  const match = stripComments(source).match(
    new RegExp(`export (?:interface ${name} |type ${name} = )\\{([\\s\\S]*?)\\n\\}`),
  )
  if (!match) throw new Error(`object type ${name} not found`)
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const field = line.trim().match(/^([A-Za-z]+\??):\s*(.+)$/)
    if (field) fields[field[1]!] = field[2]!.replace(/\s+/g, ' ')
  }
  if (Object.keys(fields).length === 0) throw new Error(`object type ${name} has no fields`)
  return fields
}

describe('voice contract parity (server types.ts vs desktop api/voice.ts)', () => {
  test.each([
    'VoiceLanguage',
    'VoiceDownloadSource',
    'VoicePreparationPhase',
    'VoicePreparationStep',
    'VoiceFailureReason',
    'VoiceErrorCode',
    'VoiceCorrectionFailureReason',
    'VoiceVocabularySource',
    'VoiceHistorySourceId',
    'VoiceHistoryCategory',
  ])('%s has the same literals on both sides', name => {
    expect(literalUnion(desktopSource, name)).toEqual(literalUnion(serverSource, name))
  })

  test.each([
    'VoiceFailure',
    'VoicePreparationState',
    'VoiceProviderInfo',
    'VoiceProviderStatus',
    'VoicePreferences',
    'VoiceLimits',
    'VoiceCatalog',
    'VoiceTranscript',
    'VoiceCorrectionTarget',
    'VoiceCorrectionInfo',
    'VoiceCorrectionChange',
    'VoiceCorrection',
    'VoiceVocabularyEntry',
    'VoiceVocabularySuggestion',
    'VoiceVocabularyHistory',
    'VoiceVocabulary',
    'VoiceVocabularyInput',
    'VoiceVocabularyAddResult',
    'VoiceHistorySource',
    'VoiceHistoryTerm',
    'VoiceHistoryGroup',
    'VoiceHistorySuggestions',
  ])('%s has the same fields and field types on both sides', name => {
    expect(objectFields(desktopSource, name)).toEqual(objectFields(serverSource, name))
  })

  test('the runtime lists the server validates against match their types', () => {
    expect<string[]>([...VOICE_HISTORY_SOURCE_IDS].sort()).toEqual(literalUnion(serverSource, 'VoiceHistorySourceId'))
    for (const source of literalUnion(serverSource, 'VoiceVocabularySource')) {
      expect(isVoiceVocabularySource(source)).toBe(true)
    }
    expect(isVoiceVocabularySource('robot')).toBe(false)
  })

  test('the desktop client takes the vocabulary size limit from the server instead of redefining it', () => {
    expect(stripComments(desktopSource)).not.toContain('VOICE_VOCABULARY_MAX_TERMS')
    expect(stripComments(desktopSource)).not.toMatch(/maxTerms\s*[:=]\s*\d/)
  })

  test('the desktop client posts to the routes the server serves', () => {
    for (const route of [
      "'/api/voice/correct'",
      "'/api/voice/vocabulary'",
      "'/api/voice/vocabulary/terms'",
      '`/api/voice/vocabulary/terms?${',
      "'/api/voice/vocabulary/suggestions/dismiss'",
      "'/api/voice/vocabulary/history/sources'",
      "'/api/voice/vocabulary/history/suggest'",
    ]) {
      expect(desktopSource).toContain(route)
    }
  })

  test('the runtime language list used to validate preferences matches the VoiceLanguage type', () => {
    expect([...VOICE_LANGUAGES].sort()).toEqual(literalUnion(serverSource, 'VoiceLanguage'))
  })

  test('the runtime download-source list matches the VoiceDownloadSource type', () => {
    expect([...VOICE_DOWNLOAD_SOURCES].sort()).toEqual(literalUnion(serverSource, 'VoiceDownloadSource'))
  })

  test('the desktop client takes upload limits from the catalog instead of redefining them', () => {
    expect(stripComments(desktopSource)).not.toMatch(/maxAudio(?:Seconds|Bytes)\s*[:=]\s*\d/)
    expect(stripComments(desktopSource)).not.toContain('VOICE_LIMITS')
  })

  test('the desktop preferences mirror carries the voiceInput section', () => {
    expect(objectFields(desktopPreferencesSource, 'DesktopUiPreferences')['voiceInput?']).toBe('VoicePreferences')
  })

  test('the default limits admit a full-length canonical recording', () => {
    expect(VOICE_LIMITS.maxAudioSeconds).toBe(120)
    expect(makeWav(VOICE_LIMITS.maxAudioSeconds).byteLength).toBeLessThanOrEqual(VOICE_LIMITS.maxAudioBytes)
  })
})
