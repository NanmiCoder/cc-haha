import { describe, expect, test } from 'bun:test'
import {
  EFFORT_LEVELS,
  getEffortLevelDescription,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
  parseEffortValue,
  resolveAppliedEffort,
  toPersistableEffort,
} from './effort.js'
import {
  GROK_MODEL_CATALOG,
  setGrokRuntimeModelCatalog,
} from 'src/services/grokAuth/models.js'

describe('agent effort values', () => {
  test('accepts all named agent effort levels including xhigh', () => {
    expect(EFFORT_LEVELS).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])

    for (const level of EFFORT_LEVELS) {
      expect(parseEffortValue(level)).toBe(level)
      expect(getEffortLevelDescription(level)).toBeTruthy()
    }
  })

  test('rejects partially numeric effort strings instead of truncating them', () => {
    expect(parseEffortValue(' 7 ')).toBe(7)
    expect(parseEffortValue('7oops')).toBeUndefined()
    expect(parseEffortValue('7.5')).toBeUndefined()
  })

  test('does not persist agent-only xhigh as a global Claude setting', () => {
    expect(toPersistableEffort('xhigh')).toBeUndefined()
  })

  test('normalizes agent effort against the resolved model capability', () => {
    const originalOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    try {
      expect(modelSupportsXHighEffort('claude-opus-4-7')).toBe(true)
      expect(modelSupportsMaxEffort('claude-opus-4-7')).toBe(true)
      expect(resolveAppliedEffort('claude-opus-4-7', 'xhigh')).toBe('xhigh')
      expect(resolveAppliedEffort('claude-sonnet-4-6', 'xhigh')).toBe('high')
      expect(modelSupportsMaxEffort('claude-sonnet-4-6')).toBe(true)
      expect(resolveAppliedEffort('claude-sonnet-4-6', 'max')).toBe('max')
      expect(resolveAppliedEffort('claude-opus-4-5', 'max')).toBe('high')
      expect(resolveAppliedEffort('gpt-5.6-sol', 'xhigh')).toBe('xhigh')
      expect(resolveAppliedEffort('gpt-5.6-luna', 'max')).toBe('max')
      // Keep the request-scoped value intact. The OpenAI provider catalog
      // skips unsupported max and then uses the transformed high fallback.
      expect(resolveAppliedEffort('gpt-5.5', 'max')).toBe('max')
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CODE_EFFORT_LEVEL
      } else {
        process.env.CLAUDE_CODE_EFFORT_LEVEL = originalOverride
      }
    }
  })

  test('resolves Grok effort from the bundled Grok catalog', () => {
    const originalOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    try {
      expect(modelSupportsEffort('grok-4.7')).toBe(true)
      expect(modelSupportsXHighEffort('grok-4.7')).toBe(true)
      expect(resolveAppliedEffort('grok-4.7', 'xhigh')).toBe('xhigh')
      expect(resolveAppliedEffort('grok-4.7', 'max')).toBe('high')
      expect(modelSupportsXHighEffort('grok-4.7-build-fast')).toBe(true)
      expect(modelSupportsXHighEffort('grok-4.5')).toBe(false)
      expect(resolveAppliedEffort('grok-4.5', 'xhigh')).toBe('high')
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CODE_EFFORT_LEVEL
      } else {
        process.env.CLAUDE_CODE_EFFORT_LEVEL = originalOverride
      }
    }
  })

  test('reads Grok effort capability from the live catalog for an unknown model', () => {
    // Regression: an ID absent from the bundled catalog used to fall through to
    // the Claude heuristics, which report a third-party model as
    // effort-incapable and strip the parameter entirely.
    const originalOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setGrokRuntimeModelCatalog([
      {
        value: 'grok-4.8',
        label: 'Grok 4.8',
        description: '',
        supportsReasoningEffort: true,
        reasoningEffort: 'high',
        reasoningEfforts: ['xhigh', 'high', 'low'],
      },
      {
        value: 'grok-4.8-non-reasoning',
        label: 'Grok 4.8 Non-Reasoning',
        description: '',
        supportsReasoningEffort: false,
      },
    ])
    try {
      expect(modelSupportsEffort('grok-4.8')).toBe(true)
      expect(modelSupportsXHighEffort('grok-4.8')).toBe(true)
      expect(resolveAppliedEffort('grok-4.8', 'xhigh')).toBe('xhigh')
      expect(modelSupportsEffort('grok-4.8-non-reasoning')).toBe(false)
    } finally {
      setGrokRuntimeModelCatalog(GROK_MODEL_CATALOG)
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CODE_EFFORT_LEVEL
      } else {
        process.env.CLAUDE_CODE_EFFORT_LEVEL = originalOverride
      }
    }
  })

  test('lets request-scoped Agent effort override session env only when marked', () => {
    const originalOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
    try {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'

      expect(resolveAppliedEffort('gpt-5.6-luna', 'xhigh')).toBe('high')
      expect(
        resolveAppliedEffort('gpt-5.6-luna', 'xhigh', {
          effortValueOverridesEnv: true,
        }),
      ).toBe('xhigh')

      process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
      expect(resolveAppliedEffort('gpt-5.6-luna', 'xhigh')).toBeUndefined()
      expect(
        resolveAppliedEffort('gpt-5.6-luna', 'xhigh', {
          effortValueOverridesEnv: true,
        }),
      ).toBe('xhigh')
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CODE_EFFORT_LEVEL
      } else {
        process.env.CLAUDE_CODE_EFFORT_LEVEL = originalOverride
      }
    }
  })

  test('matches the Claude effort capability table', () => {
    const effortModels = [
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-mythos-preview',
    ]
    const xhighModels = [
      'claude-opus-4-7',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
    ]
    const maxModels = [
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-mythos-preview',
    ]

    for (const model of effortModels) expect(modelSupportsEffort(model)).toBe(true)
    for (const model of xhighModels) expect(modelSupportsXHighEffort(model)).toBe(true)
    for (const model of maxModels) expect(modelSupportsMaxEffort(model)).toBe(true)

    expect(modelSupportsEffort('claude-haiku-4-5')).toBe(false)
    expect(modelSupportsXHighEffort('claude-sonnet-4-6')).toBe(false)
    expect(modelSupportsXHighEffort('claude-mythos-preview')).toBe(false)
    expect(modelSupportsMaxEffort('claude-opus-4-5')).toBe(false)
  })

  test('uses the OpenAI catalog while leaving unknown GPT models provider-owned', () => {
    expect(modelSupportsEffort('gpt-5.6-sol')).toBe(true)
    expect(modelSupportsXHighEffort('gpt-5.6-sol')).toBe(true)
    expect(modelSupportsMaxEffort('gpt-5.6-luna')).toBe(true)
    expect(modelSupportsMaxEffort('gpt-5.5')).toBe(false)

    expect(modelSupportsXHighEffort('o9-experimental')).toBe(true)
    expect(modelSupportsMaxEffort('o9-experimental')).toBe(true)
  })

})
