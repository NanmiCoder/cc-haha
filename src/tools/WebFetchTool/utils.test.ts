import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  extractWebFetchPromptResult,
  resolveWebFetchProcessingModel,
  shouldSkipWebFetchPreflight,
} from './utils.js'

describe('shouldSkipWebFetchPreflight', () => {
  const originalDesktopServerUrl = process.env.CC_HAHA_DESKTOP_SERVER_URL

  beforeEach(() => {
    delete process.env.CC_HAHA_DESKTOP_SERVER_URL
  })

  afterEach(() => {
    if (originalDesktopServerUrl === undefined) {
      delete process.env.CC_HAHA_DESKTOP_SERVER_URL
    } else {
      process.env.CC_HAHA_DESKTOP_SERVER_URL = originalDesktopServerUrl
    }
  })

  test('respects explicit true from settings', () => {
    expect(
      shouldSkipWebFetchPreflight({ skipWebFetchPreflight: true }),
    ).toBe(true)
  })

  test('respects explicit false from settings even on desktop', () => {
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:3456'

    expect(
      shouldSkipWebFetchPreflight({ skipWebFetchPreflight: false }),
    ).toBe(false)
  })

  test('defaults to enabled for desktop sessions', () => {
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:3456'

    expect(shouldSkipWebFetchPreflight({})).toBe(true)
  })

  test('defaults to disabled outside desktop sessions', () => {
    expect(shouldSkipWebFetchPreflight({})).toBe(false)
  })
})

describe('resolveWebFetchProcessingModel', () => {
  const originalSmallFastModel = process.env.ANTHROPIC_SMALL_FAST_MODEL
  const originalDefaultHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL

  beforeEach(() => {
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  })

  afterEach(() => {
    if (originalSmallFastModel === undefined) {
      delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    } else {
      process.env.ANTHROPIC_SMALL_FAST_MODEL = originalSmallFastModel
    }

    if (originalDefaultHaikuModel === undefined) {
      delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    } else {
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = originalDefaultHaikuModel
    }
  })

  test('falls back to the active non-Claude model when no provider Haiku is configured', () => {
    expect(resolveWebFetchProcessingModel('gpt-5.5')).toEqual({
      model: 'gpt-5.5',
      useSmallFastModel: false,
    })
  })

  test('keeps the small fast model for Claude sessions', () => {
    const resolved = resolveWebFetchProcessingModel('claude-sonnet-4-6')

    expect(resolved.useSmallFastModel).toBe(true)
    expect(resolved.model).toContain('claude')
  })

  test('respects an explicitly configured provider Haiku model', () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'gpt-5.5-mini'

    expect(resolveWebFetchProcessingModel('gpt-5.5')).toEqual({
      model: 'gpt-5.5-mini',
      useSmallFastModel: true,
    })
  })

  test('respects an explicitly configured small fast model', () => {
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'provider-fast-model'

    expect(resolveWebFetchProcessingModel('gpt-5.5')).toEqual({
      model: 'provider-fast-model',
      useSmallFastModel: true,
    })
  })
})

describe('extractWebFetchPromptResult', () => {
  test('returns text even when provider reasoning arrives first', () => {
    expect(
      extractWebFetchPromptResult([
        { type: 'thinking', thinking: 'checking the page' } as never,
        { type: 'text', text: '帖子正文' } as never,
      ]),
    ).toBe('帖子正文')
  })

  test('keeps the existing fallback when the model returns no text', () => {
    expect(
      extractWebFetchPromptResult([
        { type: 'thinking', thinking: 'only reasoning' } as never,
      ]),
    ).toBe('No response from model')
  })
})
