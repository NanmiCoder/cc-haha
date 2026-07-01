import { describe, expect, it } from 'bun:test'
import {
  buildSoloSuggestions,
  type SoloSignalsTier1,
  _SOLO_SUGGESTIONS_INTERNALS,
} from './soloSuggestions'
import type { RecentActivityResult } from './projectActivityService'

const FROZEN_NOW = Date.parse('2026-06-11T12:00:00Z')

/** Minimal activity fixture — clean repo, no session, no signals. */
function emptyActivity(): RecentActivityResult {
  return {
    hasActivity: false,
    workDir: '/repo',
  }
}

/** Fixture with a recent session + git context, no dirty work. */
function quietActivity(overrides: Partial<RecentActivityResult> = {}): RecentActivityResult {
  return {
    hasActivity: true,
    workDir: '/repo',
    lastSession: {
      sessionId: 'sess-1',
      title: 'previous work',
      modifiedAt: new Date(FROZEN_NOW - 60 * 60 * 1000).toISOString(), // 1h ago
      messageCount: 12,
      filesEditedCount: 2,
      filesEditedSample: ['src/foo.ts', 'src/bar.ts'],
    },
    git: {
      branch: 'feat/x',
      defaultBranch: 'main',
      aheadCount: 0,
      behindCount: 0,
      dirtyCount: 0,
      dirtyFiles: [],
    },
    ...overrides,
  }
}

describe('buildSoloSuggestions — fallback behavior', () => {
  it('returns ONLY the generic fallback when no signals fire', () => {
    const out = buildSoloSuggestions(emptyActivity(), {}, { now: FROZEN_NOW })
    expect(out).toHaveLength(1)
    expect(out[0]!.category).toBe('generic')
    expect(out[0]!.id).toBe('generic')
    expect(out[0]!.entryStage).toBe('plan')
  })

  it('drops the generic fallback once any specific suggestion fires', () => {
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 0,
        behindCount: 0,
        dirtyCount: 2,
        dirtyFiles: ['src/foo.ts', 'src/bar.ts'],
      },
    })
    const out = buildSoloSuggestions(activity, {}, { now: FROZEN_NOW })
    expect(out.find((s) => s.category === 'generic')).toBeUndefined()
    expect(out.find((s) => s.category === 'finish-wip')).toBeDefined()
  })

  it('is fully deterministic — same inputs produce identical output', () => {
    const a = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 3,
        behindCount: 0,
        dirtyCount: 1,
        dirtyFiles: ['src/foo.ts'],
      },
    })
    const t1: SoloSignalsTier1 = {
      stashCount: 1,
      missingTestFiles: ['src/foo.ts'],
    }
    const a1 = buildSoloSuggestions(a, t1, { now: FROZEN_NOW })
    const a2 = buildSoloSuggestions(a, t1, { now: FROZEN_NOW })
    expect(a1.map((s) => s.id)).toEqual(a2.map((s) => s.id))
    expect(a1.map((s) => s.score)).toEqual(a2.map((s) => s.score))
  })
})

describe('buildSoloSuggestions — rule: finish-wip', () => {
  it('fires on dirtyCount > 0, embedding count + sample in params', () => {
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 0,
        behindCount: 0,
        dirtyCount: 3,
        dirtyFiles: ['src/foo.ts', 'src/bar.ts', 'README.md'],
      },
    })
    const out = buildSoloSuggestions(activity, {}, { now: FROZEN_NOW })
    const wip = out.find((s) => s.category === 'finish-wip')
    expect(wip).toBeDefined()
    expect(wip!.title.params!.count).toBe(3)
    expect(wip!.taskPrompt.params!.count).toBe(3)
    expect(String(wip!.taskPrompt.params!.files)).toContain('src/foo.ts')
  })

  it('downscores when dirty files look foreign vs the last session', () => {
    // Session edited foo.ts/bar.ts, but the dirty set is dominated
    // by unrelated files (likely another agent's parked work).
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 0,
        behindCount: 0,
        dirtyCount: 4,
        dirtyFiles: [
          'src/other-ai-1.ts',
          'src/other-ai-2.ts',
          'src/other-ai-3.ts',
          'src/other-ai-4.ts',
        ],
      },
    })
    const out = buildSoloSuggestions(activity, {}, { now: FROZEN_NOW })
    const wip = out.find((s) => s.category === 'finish-wip')!
    // Foreign-dominated → detail copy switches AND score drops by 15.
    expect(wip.detail!.key).toBe('solo.suggest.finishWip.detailForeign')
    // Base 30 + recency 15 (1h ago) + sample-bonus 10 - foreign 15 = 40
    expect(wip.score).toBe(40)
  })

  it('does NOT fire when dirtyCount is 0', () => {
    const out = buildSoloSuggestions(quietActivity(), {}, { now: FROZEN_NOW })
    expect(out.find((s) => s.category === 'finish-wip')).toBeUndefined()
  })
})

describe('buildSoloSuggestions — rule: ship-ahead', () => {
  it('routes "review" entry stage when ahead > 0 on a feature branch', () => {
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 5,
        behindCount: 0,
        dirtyCount: 0,
        dirtyFiles: [],
      },
    })
    const out = buildSoloSuggestions(activity, {}, { now: FROZEN_NOW })
    const ship = out.find((s) => s.category === 'ship')!
    expect(ship).toBeDefined()
    expect(ship.entryStage).toBe('review')
    expect(ship.title.params!.branch).toBe('feat/x')
    expect(ship.title.params!.count).toBe(5)
  })

  it('does NOT fire when on the default branch (ahead on main is suspicious, not ready-to-ship)', () => {
    const activity = quietActivity({
      git: {
        branch: 'main',
        defaultBranch: 'main',
        aheadCount: 3,
        behindCount: 0,
        dirtyCount: 0,
        dirtyFiles: [],
      },
    })
    const out = buildSoloSuggestions(activity, {}, { now: FROZEN_NOW })
    expect(out.find((s) => s.category === 'ship')).toBeUndefined()
  })

  it('does NOT fire when ahead is 0', () => {
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 0,
        behindCount: 0,
        dirtyCount: 0,
        dirtyFiles: [],
      },
    })
    const out = buildSoloSuggestions(activity, {}, { now: FROZEN_NOW })
    expect(out.find((s) => s.category === 'ship')).toBeUndefined()
  })
})

describe('buildSoloSuggestions — rule: test-gap', () => {
  it('fires for the first source file in missingTestFiles, plan entry', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      { missingTestFiles: ['src/lib/foo.ts'] },
      { now: FROZEN_NOW },
    )
    const gap = out.find((s) => s.category === 'test-gap')!
    expect(gap).toBeDefined()
    expect(gap.entryStage).toBe('plan')
    expect(gap.taskPrompt.params!.file).toBe('src/lib/foo.ts')
  })

  it('skips obvious test files in the missing list (defensive — caller may pass them by accident)', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      { missingTestFiles: ['src/lib/foo.test.ts', 'src/lib/bar.spec.ts'] },
      { now: FROZEN_NOW },
    )
    expect(out.find((s) => s.category === 'test-gap')).toBeUndefined()
  })

  it('outranks ship-ahead when both fire (test gap is more easily ignored)', () => {
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 5,
        behindCount: 0,
        dirtyCount: 0,
        dirtyFiles: [],
      },
    })
    const out = buildSoloSuggestions(
      activity,
      { missingTestFiles: ['src/lib/foo.ts'] },
      { now: FROZEN_NOW },
    )
    expect(out[0]!.category).toBe('test-gap')
  })
})

describe('buildSoloSuggestions — rule: todo-marker', () => {
  it('fires on first todoHit, embedding excerpt in detail', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      {
        todoHits: [
          { path: 'src/foo.ts', excerpt: 'TODO: handle null case' },
          { path: 'src/bar.ts', excerpt: 'FIXME: leak' },
        ],
      },
      { now: FROZEN_NOW },
    )
    const todo = out.find((s) => s.category === 'cleanup')!
    expect(todo).toBeDefined()
    expect(todo.taskPrompt.params!.file).toBe('src/foo.ts')
    expect(String(todo.detail!.params!.excerpt)).toContain('handle null case')
  })
})

describe('buildSoloSuggestions — rule: release-mismatch', () => {
  it('routes to "land" entry stage with the kind-specific i18n keys', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      {
        releaseMismatch: {
          desktopVersion: '0.5.10',
          latestNotes: '0.5.9',
          kind: 'notes-missing',
        },
      },
      { now: FROZEN_NOW },
    )
    const rel = out.find((s) => s.category === 'release')!
    expect(rel).toBeDefined()
    expect(rel.entryStage).toBe('land')
    expect(rel.id).toBe('release-notes-missing')
    expect(rel.title.key).toBe('solo.suggest.releaseMismatch.notes-missing.title')
    expect(rel.title.params!.desktopVersion).toBe('0.5.10')
  })
})

describe('buildSoloSuggestions — rule: resolve-conflict', () => {
  it('beats every other suggestion in score', () => {
    const out = buildSoloSuggestions(
      quietActivity({
        git: {
          branch: 'feat/x',
          defaultBranch: 'main',
          aheadCount: 5,
          behindCount: 0,
          dirtyCount: 3,
          dirtyFiles: ['src/foo.ts'],
        },
      }),
      { gitInProgress: 'merge', missingTestFiles: ['src/foo.ts'] },
      { now: FROZEN_NOW },
    )
    expect(out[0]!.category).toBe('resolve-conflict')
    expect(out[0]!.title.key).toBe('solo.suggest.resolveConflict.merge.title')
  })
})

describe('buildSoloSuggestions — capping + per-category dedup', () => {
  it('caps at 5 entries even if many rules fire', () => {
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 5,
        behindCount: 3,
        dirtyCount: 3,
        dirtyFiles: ['src/foo.ts'],
      },
    })
    const tier1: SoloSignalsTier1 = {
      stashCount: 1,
      missingTestFiles: ['src/foo.ts'],
      todoHits: [{ path: 'src/foo.ts', excerpt: 'TODO' }],
      releaseMismatch: {
        desktopVersion: '0.5.10',
        latestNotes: '0.5.9',
        kind: 'notes-missing',
      },
      gitInProgress: 'rebase',
    }
    const out = buildSoloSuggestions(activity, tier1, { now: FROZEN_NOW })
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('keeps only the highest-scoring entry per category (e.g. fresh dirty over stash)', () => {
    // Both finish-wip rules fire (dirty + stash). Dirty has base 30 +
    // sample-bonus + recency, stash is base 30 - 12 → dirty wins.
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 0,
        behindCount: 0,
        dirtyCount: 1,
        dirtyFiles: ['src/foo.ts'],
      },
    })
    const out = buildSoloSuggestions(
      activity,
      { stashCount: 2 },
      { now: FROZEN_NOW },
    )
    const wips = out.filter((s) => s.category === 'finish-wip')
    expect(wips).toHaveLength(1)
    expect(wips[0]!.id).toBe('finish-wip')
  })
})

describe('recencyBoost', () => {
  const { recencyBoost } = _SOLO_SUGGESTIONS_INTERNALS
  it('returns +15 within 24h', () => {
    expect(recencyBoost(new Date(FROZEN_NOW - 60 * 60 * 1000).toISOString(), FROZEN_NOW)).toBe(15)
  })
  it('returns +5 within a week', () => {
    expect(recencyBoost(new Date(FROZEN_NOW - 3 * 24 * 60 * 60 * 1000).toISOString(), FROZEN_NOW)).toBe(5)
  })
  it('returns 0 beyond a week, missing, or future', () => {
    expect(recencyBoost(new Date(FROZEN_NOW - 30 * 24 * 60 * 60 * 1000).toISOString(), FROZEN_NOW)).toBe(0)
    expect(recencyBoost(undefined, FROZEN_NOW)).toBe(0)
    expect(recencyBoost(new Date(FROZEN_NOW + 60_000).toISOString(), FROZEN_NOW)).toBe(0)
    expect(recencyBoost('not a date', FROZEN_NOW)).toBe(0)
  })
})

describe('isCodeSource', () => {
  const { isCodeSource } = _SOLO_SUGGESTIONS_INTERNALS
  it('classifies typical source files', () => {
    expect(isCodeSource('src/foo.ts')).toBe(true)
    expect(isCodeSource('packages/x/src/main.go')).toBe(true)
  })
  it('rejects test files by extension and folder convention', () => {
    expect(isCodeSource('src/foo.test.ts')).toBe(false)
    expect(isCodeSource('src/foo.spec.tsx')).toBe(false)
    expect(isCodeSource('src/foo_test.go')).toBe(false)
    expect(isCodeSource('src/__tests__/foo.ts')).toBe(false)
    expect(isCodeSource('tests/foo.ts')).toBe(false)
  })
  it('rejects non-code files', () => {
    expect(isCodeSource('README.md')).toBe(false)
    expect(isCodeSource('package.json')).toBe(false)
    expect(isCodeSource('')).toBe(false)
  })
})

describe('buildSoloSuggestions — rule: lsp-error (Phase 5)', () => {
  it('does NOT fire when lspErrorCount is undefined', () => {
    const out = buildSoloSuggestions(quietActivity(), {}, { now: FROZEN_NOW })
    expect(out.find((s) => s.id === 'lsp-error')).toBeUndefined()
  })

  it('does NOT fire when lspErrorCount is 0', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      { lspErrorCount: 0 },
      { now: FROZEN_NOW },
    )
    expect(out.find((s) => s.id === 'lsp-error')).toBeUndefined()
  })

  it('does NOT fire when lspErrorCount is a non-integer', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      { lspErrorCount: 1.5 as unknown as number },
      { now: FROZEN_NOW },
    )
    expect(out.find((s) => s.id === 'lsp-error')).toBeUndefined()
  })

  it('does NOT fire when lspErrorCount is negative (defensive)', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      { lspErrorCount: -3 },
      { now: FROZEN_NOW },
    )
    expect(out.find((s) => s.id === 'lsp-error')).toBeUndefined()
  })

  it('fires a single cleanup-category suggestion when lspErrorCount > 0', () => {
    const out = buildSoloSuggestions(
      quietActivity(),
      { lspErrorCount: 7 },
      { now: FROZEN_NOW },
    )
    const lsp = out.find((s) => s.id === 'lsp-error')
    expect(lsp).toBeDefined()
    expect(lsp!.category).toBe('cleanup')
    expect(lsp!.score).toBe(80)
    expect(lsp!.title.params!.count).toBe(7)
    expect(lsp!.taskPrompt.params!.count).toBe(7)
    expect(lsp!.title.key).toBe('solo.suggest.lspError.title')
    expect(lsp!.detail!.key).toBe('solo.suggest.lspError.detail')
    expect(lsp!.taskPrompt.key).toBe('solo.suggest.lspError.taskPrompt')
  })

  it('outranks the other cleanup rules (todo / sync-upstream) via per-category dedup', () => {
    const activity = quietActivity({
      git: {
        branch: 'feat/x',
        defaultBranch: 'main',
        aheadCount: 0,
        behindCount: 5, // would otherwise fire sync-upstream
        dirtyCount: 0,
        dirtyFiles: [],
      },
    })
    const out = buildSoloSuggestions(
      activity,
      {
        lspErrorCount: 3,
        todoHits: [{ path: 'src/foo.ts', excerpt: 'TODO: x' }],
      },
      { now: FROZEN_NOW },
    )
    const cleanup = out.filter((s) => s.category === 'cleanup')
    expect(cleanup.length).toBe(1)
    expect(cleanup[0]!.id).toBe('lsp-error')
  })
})

