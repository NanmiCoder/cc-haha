import { describe, expect, it } from 'bun:test'
import { ALL_MODEL_CONFIGS } from './model/configs.js'
import { firstPartyNameToCanonical } from './model/model.js'
import { MODEL_COSTS } from './modelCost.js'
import { resolveModelCosts } from './usageAccounting.js'

// Two independent tables price Claude models: `MODEL_COSTS` (canonical-name lookup, used for the
// CLI's /cost) and the indexer's prefix table in usageAccounting (activity stats). A model added to
// only one, or a shorter prefix such as `claude-sonnet-5` shadowing `claude-sonnet-5-5`, misprices
// it without any error, so the two must agree for every model the app registers.
const claudeModels = Object.entries(ALL_MODEL_CONFIGS).filter(([, config]) =>
  config.firstParty.startsWith('claude-'),
)

describe('Claude model pricing tables', () => {
  it.each(claudeModels)('%s is priced by both tables, identically', (_key, config) => {
    const canonical = firstPartyNameToCanonical(config.firstParty)
    expect(MODEL_COSTS[canonical]).toBeDefined()
    expect(resolveModelCosts(config.firstParty)).toEqual(MODEL_COSTS[canonical]!)
  })

  // https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-29), $ per MTok.
  it.each([
    ['claude-fable-5-1', 10, 50, 0.25],
    ['claude-fable-5', 10, 50, 1],
    ['claude-opus-5-5', 4, 20, 0.2],
    ['claude-opus-5', 5, 25, 0.5],
    ['claude-opus-4-8', 5, 25, 0.5],
    ['claude-sonnet-5-5', 2, 10, 0.2],
    ['claude-sonnet-5', 2, 10, 0.2],
    ['claude-sonnet-4-6', 3, 15, 0.3],
    ['claude-haiku-5-5', 0.1, 0.5, 0.01],
    ['claude-haiku-4-5', 1, 5, 0.1],
  ])('%s matches the published input/output/cache-read prices', (model, input, output, cacheRead) => {
    for (const costs of [MODEL_COSTS[firstPartyNameToCanonical(model)], resolveModelCosts(model)]) {
      expect(costs).toMatchObject({
        inputTokens: input,
        outputTokens: output,
        promptCacheReadTokens: cacheRead,
      })
    }
  })
})
