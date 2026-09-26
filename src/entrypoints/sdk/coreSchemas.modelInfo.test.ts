import { describe, expect, test } from 'bun:test'
import { getSupportedEffortLevelsForModel } from '../../utils/effort.js'
import { ModelInfoSchema } from './coreSchemas.js'

describe('ModelInfoSchema effort capabilities', () => {
  test('accepts model-specific effort levels emitted by CLI initialization', () => {
    // These models resolve their effort levels from the built-in Claude
    // capability list, which is only trusted when no third-party
    // ANTHROPIC_BASE_URL is configured. A developer shell that points the
    // provider at a proxy would otherwise report no effort for these models,
    // so pin a first-party base URL for the test and restore it after.
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

    const cases = [
      {
        value: 'sonnet',
        model: 'claude-sonnet-4-6',
        expected: ['low', 'medium', 'high', 'max'],
      },
      {
        value: 'fable',
        model: 'claude-fable-5',
        expected: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ]

    try {
      for (const { value, model, expected } of cases) {
        const supportedEffortLevels = getSupportedEffortLevelsForModel(model)
        expect(supportedEffortLevels).toEqual(expected)
        expect(
          ModelInfoSchema().safeParse({
            value,
            displayName: value,
            description: `${value} model`,
            supportsEffort: true,
            supportedEffortLevels,
          }).success,
        ).toBe(true)
      }
    } finally {
      if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
    }
  })

  test('rejects unknown effort capabilities', () => {
    expect(
      ModelInfoSchema().safeParse({
        value: 'fable',
        displayName: 'Fable',
        description: 'Most capable for complex agent tasks',
        supportsEffort: true,
        supportedEffortLevels: ['extreme'],
      }).success,
    ).toBe(false)
  })
})
