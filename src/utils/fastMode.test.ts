import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getClientType,
  getIsInteractive,
  setClientType,
  setIsInteractive,
} from '../bootstrap/state.js'
import {
  getFastModeState,
  getFastModeUnavailableReason,
  handleFastModeRejectedByAPI,
  isFastModeAvailable,
  isFastModeSupportedByModel,
  prefetchFastModeStatus,
  resetFastModeStateForTesting,
} from './fastMode.js'
import {
  COST_FABLE_52_FAST,
  COST_OPUS_55_FAST,
  COST_OPUS_5_FAST,
  COST_TIER_30_150,
  getModelCosts,
} from './modelCost.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const SAVED_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK',
  'CLAUDE_CODE_ENTRYPOINT',
  'CC_HAHA_TRANSCRIPT_ENTRYPOINT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_AZURE_OPENAI',
  'USER_TYPE',
] as const

describe('fastMode runtime & pricing', () => {
  let tempDir: string
  let savedEnv: Record<string, string | undefined>
  let savedInteractive: boolean
  let savedClientType: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-fastmode-test-'))
    savedEnv = {}
    for (const key of SAVED_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.CLAUDE_CONFIG_DIR = tempDir
    savedInteractive = getIsInteractive()
    savedClientType = getClientType()
    setIsInteractive(true)
    setClientType('cli')
    resetFastModeStateForTesting()
    resetSettingsCache()
  })

  afterEach(() => {
    for (const key of SAVED_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    setIsInteractive(savedInteractive)
    setClientType(savedClientType)
    resetFastModeStateForTesting()
    resetSettingsCache()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('supports Opus 5.5, Opus 5, Opus 4.8, Opus 4.6, and Fable 5.2 while rejecting Sonnet/Haiku', () => {
    expect(isFastModeSupportedByModel('claude-opus-5-5')).toBe(true)
    expect(isFastModeSupportedByModel('claude-opus-5')).toBe(true)
    expect(isFastModeSupportedByModel('claude-opus-4-8')).toBe(true)
    expect(isFastModeSupportedByModel('claude-opus-4-6')).toBe(true)
    expect(isFastModeSupportedByModel('claude-fable-5-2')).toBe(true)
    expect(isFastModeSupportedByModel('claude-sonnet-5-5')).toBe(false)
    expect(isFastModeSupportedByModel('claude-haiku-4-5')).toBe(false)
    expect(isFastModeSupportedByModel('claude-fable-5-1')).toBe(false)
  })

  test('disables fast mode when CLAUDE_CODE_DISABLE_FAST_MODE=1 or CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1', () => {
    process.env.CLAUDE_CODE_DISABLE_FAST_MODE = '1'
    expect(isFastModeSupportedByModel('claude-opus-5-5')).toBe(false)
    expect(isFastModeAvailable()).toBe(false)
    expect(getFastModeState('claude-opus-5-5', true)).toBe('off')

    delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(isFastModeSupportedByModel('claude-opus-5-5')).toBe(false)
    expect(isFastModeAvailable()).toBe(false)
    expect(getFastModeState('claude-opus-5-5', true)).toBe('off')
  })

  test('allows non-interactive claude-desktop sessions while still blocking generic Agent SDK without opt-in', () => {
    setIsInteractive(false)
    setClientType('sdk-cli')
    expect(getFastModeUnavailableReason()).toBe('Fast mode is not available in the Agent SDK')

    setClientType('claude-desktop')
    expect(getFastModeUnavailableReason()).toBeNull()
    expect(getFastModeState('claude-opus-5-5', true)).toBe('on')
  })

  test('CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK bypasses org prefetch probe but still honors real API 400 rejection', async () => {
    process.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = '1'
    await prefetchFastModeStatus()
    expect(getFastModeUnavailableReason()).toBeNull()
    expect(isFastModeAvailable()).toBe(true)

    handleFastModeRejectedByAPI()
    expect(isFastModeAvailable()).toBe(false)
    expect(getFastModeUnavailableReason()).toBe('Fast mode has been disabled by your organization')
  })

  test('applies fast-mode pricing tiers for all supported models when usage.speed is fast', () => {
    const fastUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      iterations: null,
      speed: 'fast',
    } as const

    expect(getModelCosts('claude-opus-5-5', fastUsage)).toEqual(COST_OPUS_55_FAST)
    expect(getModelCosts('claude-opus-5', fastUsage)).toEqual(COST_OPUS_5_FAST)
    expect(getModelCosts('claude-opus-4-8', fastUsage)).toEqual(COST_OPUS_5_FAST)
    expect(getModelCosts('claude-fable-5-2', fastUsage)).toEqual(COST_FABLE_52_FAST)
    expect(getModelCosts('claude-opus-4-6', fastUsage)).toEqual(COST_TIER_30_150)
    // claude-opus-4-7 is not a fast-mode supported model and must not use a fast-mode cost tier
    expect(isFastModeSupportedByModel('claude-opus-4-7')).toBe(false)
    expect(getModelCosts('claude-opus-4-7', fastUsage)).not.toEqual(COST_TIER_30_150)
    expect(getModelCosts('claude-opus-4-7', fastUsage)).not.toEqual(COST_OPUS_55_FAST)
  })
})
