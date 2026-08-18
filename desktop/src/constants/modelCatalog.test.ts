import { describe, expect, it } from 'vitest'
import { OFFICIAL_DEFAULT_MODEL_ID, OFFICIAL_MODELS } from './modelCatalog'

/**
 * The effort levels a model may declare.
 *
 * Duplicated deliberately rather than imported: the point of these tests is to
 * catch this list drifting apart from its other copies, so importing one of
 * them would defeat the check. Keep in step with EFFORT_LEVELS in
 * src/server/api/models.ts, VALID_SESSION_EFFORT_LEVELS in
 * src/server/services/sessionService.ts, and EFFORT_LEVELS in
 * desktop/src/lib/persistenceMigrations.ts.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

describe('OFFICIAL_MODELS', () => {
  it('lists the current Opus alongside the previous one', () => {
    const ids = OFFICIAL_MODELS.map((model) => model.id)
    expect(ids).toContain('claude-opus-5')
    expect(ids).toContain('claude-opus-4-8')
  })

  it('has no duplicate model ids', () => {
    const ids = OFFICIAL_MODELS.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('points the default at a model that is actually listed', () => {
    expect(OFFICIAL_MODELS.map((model) => model.id)).toContain(OFFICIAL_DEFAULT_MODEL_ID)
  })

  it('offers every effort level on models that support reasoning effort', () => {
    // A model missing from this catalog falls back to a level list that drops
    // xhigh (see runtimeEffortOptions in components/controls/ModelSelector.tsx),
    // so an unlisted model silently loses a level that the runtime accepts.
    const reasoningModels = OFFICIAL_MODELS.filter(
      (model) => model.supportedReasoningEfforts !== undefined,
    )
    expect(reasoningModels.length).toBeGreaterThan(0)

    for (const model of reasoningModels) {
      expect(model.supportedReasoningEfforts, `${model.id} effort levels`)
        .toEqual([...EFFORT_LEVELS])
    }
  })

  it('keeps each declared default effort within that model own supported set', () => {
    for (const model of OFFICIAL_MODELS) {
      if (!model.defaultReasoningEffort) continue
      expect(model.supportedReasoningEfforts, `${model.id} declares a default but no set`)
        .toBeDefined()
      expect(model.supportedReasoningEfforts, `${model.id} default effort`)
        .toContain(model.defaultReasoningEffort)
    }
  })
})
