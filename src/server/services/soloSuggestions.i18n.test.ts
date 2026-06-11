import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  buildSoloSuggestions,
  type SoloSignalsTier1,
} from './soloSuggestions'
import type { RecentActivityResult } from './projectActivityService'

/**
 * Cross-module contract test: every i18n key emitted by the
 * suggestion engine MUST exist in `desktop/src/i18n/locales/en.ts`
 * (the source of truth). Catches the easy mistake of adding a new
 * rule + forgetting to add the corresponding solo.suggest.* keys to
 * the locale files — symptom in production would be the desktop
 * rendering the literal key string in the welcome chip.
 *
 * Other locales are checked structurally by tsc via
 * `Record<TranslationKey, string>` in their declarations, so we
 * only need to lock en.ts here.
 */

const EN_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'desktop',
  'src',
  'i18n',
  'locales',
  'en.ts',
)

const enSource = readFileSync(EN_PATH, 'utf-8')

function fixtureWithEverySignal(): {
  activity: RecentActivityResult
  tier1: SoloSignalsTier1
} {
  return {
    activity: {
      hasActivity: true,
      workDir: '/repo',
      lastSession: {
        sessionId: 'sess-1',
        title: 'previous',
        modifiedAt: new Date().toISOString(),
        messageCount: 5,
        filesEditedCount: 2,
        filesEditedSample: ['src/foo.ts'],
      },
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 3,
        behindCount: 2,
        dirtyCount: 2,
        dirtyFiles: ['src/foo.ts', 'src/bar.ts'],
      },
    },
    tier1: {
      stashCount: 1,
      missingTestFiles: ['src/foo.ts'],
      todoHits: [{ path: 'src/foo.ts', excerpt: 'TODO: handle null' }],
      releaseMismatch: {
        desktopVersion: '0.5.10',
        latestNotes: '0.5.9',
        kind: 'notes-missing',
      },
      // gitInProgress would dominate scoring; we cycle the three
      // variants in the loop below to make sure all locales are
      // checked against all three rendering paths.
    },
  }
}

describe('solo.suggest.* i18n contract — en.ts is the source of truth', () => {
  it('every i18n key emitted by the engine exists in en.ts', () => {
    const { activity, tier1 } = fixtureWithEverySignal()

    // Run the engine in three different "git in progress" modes
    // to surface the merge / rebase / cherry-pick variants too.
    const variants: Array<SoloSignalsTier1['gitInProgress']> = [
      undefined,
      'merge',
      'rebase',
      'cherry-pick',
    ]

    const seen = new Set<string>()
    for (const gip of variants) {
      const t1: SoloSignalsTier1 = { ...tier1 }
      if (gip) t1.gitInProgress = gip
      const out = buildSoloSuggestions(activity, t1, {
        now: Date.parse('2026-06-11T12:00:00Z'),
      })
      for (const s of out) {
        seen.add(s.title.key)
        if (s.detail) seen.add(s.detail.key)
        seen.add(s.taskPrompt.key)
      }
    }

    // Every emitted key must appear as a literal string in en.ts.
    // We grep rather than import the locale module to avoid the
    // server-side test pulling in browser deps via the desktop
    // tree.
    const missing: string[] = []
    for (const key of seen) {
      // Quoted match to avoid false positives from string fragments.
      const needle = `'${key}'`
      if (!enSource.includes(needle)) missing.push(key)
    }

    expect(missing).toEqual([])
    // Also assert we DID see at least one key per category
    // (defensive — guards against fixture regressions silently
    // disabling rules and leaving the assertion vacuous).
    expect(seen.size).toBeGreaterThan(10)
  })

  it('the generic fallback key exists even though it is rarely emitted', () => {
    // Generic fallback drops out as soon as another rule fires, so
    // the per-fixture test above won't include it. Pin it here
    // explicitly so adding/renaming the generic rule + forgetting
    // the locale entries can't slip past code review.
    expect(enSource).toContain("'solo.suggest.generic.title'")
    expect(enSource).toContain("'solo.suggest.generic.detail'")
    expect(enSource).toContain("'solo.suggest.generic.taskPrompt'")
  })
})
