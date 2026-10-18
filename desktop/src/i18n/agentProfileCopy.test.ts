import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from './locales/en'
import { zh } from './locales/zh'
import { zh as zhTW } from './locales/zh-TW'
import { jp } from './locales/jp'
import { kr } from './locales/kr'

const LOCALES: Record<string, Record<string, string>> = { en, zh, 'zh-TW': zhTW, jp, kr }

// The one word each language uses for the lean mode. Korean used 경량, 간소 and
// 간소화 side by side and Japanese 軽量 and 簡易, so a user met three names for
// one mode depending on which message they happened to read.
const LEAN_WORD: Record<string, string> = { en: 'lean', zh: '精简', 'zh-TW': '精簡', jp: '軽量', kr: '경량' }
const OTHER_NAMES: Record<string, string[]> = { jp: ['簡易'], kr: ['간소', '간략'] }

const leanModeKeys = Object.keys(en).filter(key => key.startsWith('agentProfile.') || key.startsWith('settings.general.leanMode'))
// Messages that name the mode (the rest describe tools or timing).
const NAMING_KEYS = [
  'agentProfile.lean', 'agentProfile.leanShort', 'agentProfile.info', 'agentProfile.commandUnavailable',
  'agentProfile.draftCommandUnavailable', 'agentProfile.planUnavailable', 'agentProfile.planReset',
  'settings.general.leanModeEnabled', 'settings.general.leanModeDescription',
]

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'locales' && entry !== 'node_modules') sourceFiles(path, found)
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

describe('lean mode copy', () => {
  it.each(Object.keys(LOCALES))('%s names the mode with one word everywhere it is named', (locale) => {
    const strings = LOCALES[locale]!
    for (const key of NAMING_KEYS) {
      expect(strings[key], `${locale} ${key}`).toBeTruthy()
      expect(strings[key]!.toLowerCase(), `${locale} ${key}`).toContain(LEAN_WORD[locale]!)
    }
    for (const key of leanModeKeys) {
      for (const other of OTHER_NAMES[locale] ?? []) {
        expect(strings[key], `${locale} ${key}`).not.toContain(other)
      }
    }
  })

  it.each(Object.keys(LOCALES))('%s short chip label is the name part of the full label', (locale) => {
    const strings = LOCALES[locale]!
    expect(strings['agentProfile.leanShort'], locale).toBeTruthy()
    expect(strings['agentProfile.lean'], locale).toMatch(/ · /)
    expect(strings['agentProfile.lean']!.startsWith(strings['agentProfile.leanShort']!), locale).toBe(true)
    // Short enough to keep the toolbar's width for the project, branch and model.
    expect(strings['agentProfile.leanShort']!.length, locale).toBeLessThanOrEqual(5)
  })

  it('has no unused agentProfile strings', () => {
    const source = sourceFiles(join(__dirname, '..')).map(file => readFileSync(file, 'utf8')).join('\n')
    const unused = Object.keys(en).filter(key => key.startsWith('agentProfile.') && !source.includes(`'${key}'`))
    expect(unused).toEqual([])
  })
})
