import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  GROK_DEFAULT_MAIN_MODEL,
  GROK_MODEL_CATALOG,
  GROK_MODEL_CATALOG_ENV_KEY,
  getGrokContextWindowForModel,
  getGrokModelCatalogEntry,
  getGrokRuntimeModelCatalog,
  resolveGrokModel,
  resolveGrokReasoningEffort,
  setGrokRuntimeModelCatalog,
} from './models.js'

describe('Grok model catalog', () => {
  let originalSnapshot: string | undefined
  let originalProvider: string | undefined
  beforeEach(() => {
    originalSnapshot = process.env[GROK_MODEL_CATALOG_ENV_KEY]
    originalProvider = process.env.CC_HAHA_GROK_OAUTH_PROVIDER
    delete process.env[GROK_MODEL_CATALOG_ENV_KEY]
    delete process.env.CC_HAHA_GROK_OAUTH_PROVIDER
  })
  afterEach(() => {
    setGrokRuntimeModelCatalog(GROK_MODEL_CATALOG)
    if (originalSnapshot === undefined) delete process.env[GROK_MODEL_CATALOG_ENV_KEY]
    else process.env[GROK_MODEL_CATALOG_ENV_KEY] = originalSnapshot
    if (originalProvider === undefined) delete process.env.CC_HAHA_GROK_OAUTH_PROVIDER
    else process.env.CC_HAHA_GROK_OAUTH_PROVIDER = originalProvider
  })

  test('mirrors the live picker fallback and defaults to Grok 4.7', () => {
    expect(GROK_MODEL_CATALOG.map((model) => model.value)).toEqual([
      'grok-4.7',
      'grok-4.7-build-fast',
      'grok-4.6',
      'grok-4.5',
    ])
    expect(GROK_DEFAULT_MAIN_MODEL).toBe('grok-4.7')
    expect(resolveGrokModel('claude-opus-4-1')).toBe(GROK_DEFAULT_MAIN_MODEL)
  })

  test('preserves remote model IDs and resolves only Claude compatibility aliases', () => {
    expect(resolveGrokModel('grok')).toBe(GROK_DEFAULT_MAIN_MODEL)
    expect(resolveGrokModel('grok-next-preview')).toBe('grok-next-preview')
    expect(resolveGrokModel('unknown-model')).toBe('unknown-model')
    expect(getGrokContextWindowForModel('grok-4.7')).toBe(500_000)
    expect(getGrokContextWindowForModel('grok-4.7-build-fast')).toBe(500_000)
    expect(getGrokContextWindowForModel('grok-4.6')).toBe(500_000)
    expect(getGrokContextWindowForModel('grok-4.5')).toBe(500_000)
    expect(getGrokContextWindowForModel('grok-build-0.1')).toBe(256_000)
    expect(getGrokContextWindowForModel('grok-4.3')).toBe(1_000_000)
    expect(getGrokContextWindowForModel('claude-opus-4-1')).toBeNull()
    expect(getGrokContextWindowForModel('unknown-model')).toBeNull()
  })

  test('resolves context window and ceiling from an explicit catalog without leaking global runtime state', () => {
    const liveCatalog = [
      {
        value: 'grok-4.7',
        label: 'Grok 4.7',
        description: '',
        contextWindow: 750_000,
        maxContextWindow: 1_000_000,
      },
      {
        value: 'grok-4.8',
        label: 'Grok 4.8',
        description: '',
        contextWindow: 1_000_000,
      },
    ]
    setGrokRuntimeModelCatalog(liveCatalog)
    // Without an explicit catalog (or a Grok OAuth CLI launch env), global runtimeCatalog
    // must not leak another account's windows into generic context lookups.
    expect(getGrokContextWindowForModel('grok-4.7')).toBe(500_000)
    expect(getGrokContextWindowForModel('grok-4.8')).toBeNull()
    expect(getGrokModelCatalogEntry('grok-4.7')?.maxContextWindow).toBeUndefined()

    // Explicit catalog lookup honors live windows and ceilings, falling back to bundled entries.
    expect(getGrokContextWindowForModel('grok-4.7', liveCatalog)).toBe(750_000)
    expect(getGrokContextWindowForModel('grok-4.8', liveCatalog)).toBe(1_000_000)
    expect(getGrokContextWindowForModel('grok-4.5', liveCatalog)).toBe(500_000)
    expect(getGrokModelCatalogEntry('GROK-4.7', liveCatalog)?.maxContextWindow).toBe(1_000_000)
    expect(getGrokModelCatalogEntry('claude-sonnet-4-6', liveCatalog)).toBeUndefined()

    // Inside a Grok OAuth CLI subprocess, its own process-scoped launch snapshot applies.
    process.env.CC_HAHA_GROK_OAUTH_PROVIDER = '1'
    process.env[GROK_MODEL_CATALOG_ENV_KEY] = JSON.stringify(liveCatalog)
    expect(getGrokContextWindowForModel('grok-4.8')).toBe(1_000_000)
  })

  test('normalizes reasoning effort through the bundled catalog', () => {
    expect(resolveGrokReasoningEffort('grok-4.7', 'xhigh')).toBe('xhigh')
    expect(resolveGrokReasoningEffort('grok-4.7', 'max')).toBe('high')
    expect(resolveGrokReasoningEffort('grok-4.5', 'low')).toBe('low')
    expect(resolveGrokReasoningEffort('grok-4.5', 'max')).toBe('high')
  })

  test('resolves effort for a model only the live catalog describes', () => {
    // Regression: a model newer than this build is absent from the bundled
    // catalog, so resolving against bundled entries alone returned undefined and
    // the request transform deleted the whole reasoning block.
    setGrokRuntimeModelCatalog([
      {
        value: 'grok-4.8',
        label: 'Grok 4.8',
        description: '',
        contextWindow: 500_000,
        supportsReasoningEffort: true,
        reasoningEffort: 'high',
        reasoningEfforts: ['xhigh', 'high', 'low'],
      },
    ])
    const catalog = getGrokRuntimeModelCatalog()
    expect(resolveGrokReasoningEffort('grok-4.8', 'xhigh', catalog)).toBe('xhigh')
    expect(resolveGrokReasoningEffort('grok-4.8', 'low', catalog)).toBe('low')
    expect(resolveGrokReasoningEffort('grok-4.8', 'medium', catalog)).toBe('high')
  })

  test('honors a live declaration that a model rejects reasoning effort', () => {
    setGrokRuntimeModelCatalog([
      {
        value: 'grok-4.8',
        label: 'Grok 4.8',
        description: '',
        supportsReasoningEffort: false,
      },
    ])
    expect(
      resolveGrokReasoningEffort('grok-4.8', 'high', getGrokRuntimeModelCatalog()),
    ).toBeUndefined()
  })

  test('forwards the requested effort for a model neither catalog describes', () => {
    expect(resolveGrokReasoningEffort('grok-4.9-preview', 'xhigh')).toBe('xhigh')
    expect(resolveGrokReasoningEffort('grok-4.9-preview', undefined)).toBeUndefined()
  })

  test('loads launch capabilities only for Grok and prefers a subsequently accepted live catalog', () => {
    const snapshot = [{
      value: 'grok-future-release', label: 'Future', description: '',
      supportsReasoningEffort: true, reasoningEffort: 'low', reasoningEfforts: ['low', 'max'],
    }]
    process.env[GROK_MODEL_CATALOG_ENV_KEY] = JSON.stringify(snapshot)
    expect(getGrokRuntimeModelCatalog()).toBe(GROK_MODEL_CATALOG)
    process.env.CC_HAHA_GROK_OAUTH_PROVIDER = '1'
    expect(getGrokRuntimeModelCatalog()).toEqual(snapshot)

    const live = [{ ...snapshot[0]!, supportsReasoningEffort: false }]
    setGrokRuntimeModelCatalog(live)
    expect(getGrokRuntimeModelCatalog()).toBe(live)
    expect(resolveGrokReasoningEffort('grok-future-release', 'max', getGrokRuntimeModelCatalog())).toBeUndefined()
  })

  test('ignores invalid launch snapshots without losing the bundled fallback', () => {
    process.env.CC_HAHA_GROK_OAUTH_PROVIDER = '1'
    for (const raw of [
      '{', 'null', '{}', '[]', '[null]',
      JSON.stringify([{ value: ' ' }]),
      JSON.stringify([{ value: 'grok-future', supportsReasoningEffort: 'false' }]),
      JSON.stringify([{ value: 'grok-future', reasoningEfforts: ['max', 1] }]),
      JSON.stringify([{ value: 'grok-future', reasoningEffort: {} }]),
      JSON.stringify([{ value: 'grok-future', contextWindow: -1 }]),
      JSON.stringify([{ value: 'grok-future', maxContextWindow: 0 }]),
    ]) {
      process.env[GROK_MODEL_CATALOG_ENV_KEY] = raw
      expect(getGrokRuntimeModelCatalog()).toBe(GROK_MODEL_CATALOG)
    }
  })
})
