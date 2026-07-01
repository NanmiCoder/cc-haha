/**
 * Unit-locks the short-circuit equality used by `handleSetRuntimeConfig`
 * to decide whether a `set_runtime_config` message should respawn the CLI.
 *
 * The producer-side bug we're guarding against: a user edits provider
 * baseUrl / apiKey / apiFormat / model mapping. The desktop fan-out
 * re-emits `set_runtime_config` for every idle session on that provider,
 * but the (providerId, modelId, effort, thinkingEnabled) tuple is
 * identical to the running CLI's. Without `providerRevision` in the
 * comparison, the handler short-circuits and the running CLI keeps its
 * spawn-time `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / model env
 * forever — resulting in "There's an issue with the selected model (...)"
 * after a model rename.
 */
import { describe, expect, it } from 'bun:test'
import { runtimeOverridesMatch, type RuntimeOverride } from '../ws/handler.js'

const base: RuntimeOverride = {
  providerId: 'p1',
  modelId: 'mimo-v2.5-pro',
  effort: 'medium',
  thinkingEnabled: true,
  providerRevision: 1,
}

describe('runtimeOverridesMatch', () => {
  it('returns false when prev is undefined (first set_runtime_config)', () => {
    expect(runtimeOverridesMatch(undefined, base)).toBe(false)
  })

  it('returns true when every field matches', () => {
    expect(runtimeOverridesMatch({ ...base }, { ...base })).toBe(true)
  })

  it('forces a restart when providerRevision differs (PR-A regression)', () => {
    // The whole point: same tuple, bumped revision after updateProvider.
    expect(
      runtimeOverridesMatch(
        { ...base, providerRevision: 1 },
        { ...base, providerRevision: 2 },
      ),
    ).toBe(false)
  })

  it('treats absent providerRevision as 0 on both sides', () => {
    const { providerRevision: _a, ...prev } = base
    const { providerRevision: _b, ...next } = base
    expect(runtimeOverridesMatch(prev, next)).toBe(true)
  })

  it('treats absent providerRevision (legacy override loaded from disk) and revision=0 as equal', () => {
    const { providerRevision: _a, ...prev } = base
    expect(runtimeOverridesMatch(prev, { ...base, providerRevision: 0 })).toBe(true)
  })

  it('forces a restart when modelId differs', () => {
    expect(
      runtimeOverridesMatch(base, { ...base, modelId: 'sonnet-4.5' }),
    ).toBe(false)
  })

  it('forces a restart when providerId differs', () => {
    expect(
      runtimeOverridesMatch(base, { ...base, providerId: 'p2' }),
    ).toBe(false)
  })

  it('forces a restart when effort differs', () => {
    expect(
      runtimeOverridesMatch(base, { ...base, effort: 'high' }),
    ).toBe(false)
  })

  it('forces a restart when thinkingEnabled flips', () => {
    expect(
      runtimeOverridesMatch(base, { ...base, thinkingEnabled: false }),
    ).toBe(false)
  })

  it('treats null providerId on both sides as matching (no provider configured)', () => {
    const noProvider: RuntimeOverride = { providerId: null, modelId: 'x' }
    expect(runtimeOverridesMatch(noProvider, { ...noProvider })).toBe(true)
  })
})
