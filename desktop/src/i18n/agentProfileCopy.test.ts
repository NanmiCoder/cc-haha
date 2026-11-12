import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from './locales/en'

const strings: Record<string, string> = en

// The one word used for the lean mode, so a user does not meet several names
// for one mode depending on which message they happened to read.
const LEAN_WORD = 'lean'

const leanModeKeys = Object.keys(en).filter(key => key.startsWith('agentProfile.') || key.startsWith('settings.general.leanMode'))
// Messages that name the mode (the rest describe tools or timing).
const NAMING_KEYS = [
  'agentProfile.lean', 'agentProfile.leanShort', 'agentProfile.teamReset', 'agentProfile.commandUnavailable',
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
  it('describes the expanded tools and remaining limits', () => {
    const available = ['web search', 'web fetch', 'sub-agents', 'task lists']
    const unavailable = ['MCP', 'Agent Teams', 'plan mode']
    for (const capability of available) {
      expect(strings['agentProfile.available']).toContain(capability)
      expect(strings['agentProfile.unavailable']).not.toContain(capability)
    }
    for (const capability of unavailable) {
      expect(strings['agentProfile.unavailable']).toContain(capability)
    }
  })

  it('names the mode with one word everywhere it is named', () => {
    for (const key of NAMING_KEYS) {
      expect(strings[key], key).toBeTruthy()
      expect(strings[key]!.toLowerCase(), key).toContain(LEAN_WORD)
    }
    for (const key of leanModeKeys) expect(strings[key], key).toBeTruthy()
  })

  it('short chip label is the name part of the full label', () => {
    expect(strings['agentProfile.leanShort']).toBeTruthy()
    expect(strings['agentProfile.lean']).toMatch(/ · /)
    expect(strings['agentProfile.lean']!.startsWith(strings['agentProfile.leanShort']!)).toBe(true)
    // Short enough to keep the toolbar's width for the project, branch and model.
    expect(strings['agentProfile.leanShort']!.length).toBeLessThanOrEqual(5)
  })

  it('has no unused agentProfile strings', () => {
    const source = sourceFiles(join(__dirname, '..')).map(file => readFileSync(file, 'utf8')).join('\n')
    const unused = Object.keys(en).filter(key => key.startsWith('agentProfile.') && !source.includes(`'${key}'`))
    expect(unused).toEqual([])
  })
})
