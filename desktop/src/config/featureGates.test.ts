import { describe, expect, test } from 'vitest'
import { FEATURE_MODES, isFeatureEnabledInMode } from './featureGates'
import { parseDeploymentMode } from '../types/deploymentMode'

describe('featureGates registry', () => {
  test('every feature is enabled in public mode', () => {
    for (const feature of Object.keys(FEATURE_MODES) as (keyof typeof FEATURE_MODES)[]) {
      expect(isFeatureEnabledInMode(feature, 'public')).toBe(true)
    }
  })

  test('every feature is disabled in private-cloud mode', () => {
    // MVP: all features are public-only. This test documents that invariant.
    for (const feature of Object.keys(FEATURE_MODES) as (keyof typeof FEATURE_MODES)[]) {
      expect(isFeatureEnabledInMode(feature, 'private-cloud')).toBe(false)
    }
  })

  test('covers all expected feature keys', () => {
    expect(Object.keys(FEATURE_MODES).sort()).toEqual([
      'auto-update-check',
      'claude-in-chrome',
      'im-telegram',
      'im-wechat',
      'im-whatsapp',
      'official-mcp-registry',
      'official-oauth',
      'official-plugin-market',
      'skill-market',
    ])
  })
})

describe('parseDeploymentMode backward compatibility', () => {
  test('returns public for undefined', () => {
    expect(parseDeploymentMode(undefined)).toBe('public')
  })

  test('returns public for null', () => {
    expect(parseDeploymentMode(null)).toBe('public')
  })

  test('returns public for an illegal string', () => {
    expect(parseDeploymentMode('on-prem')).toBe('public')
    expect(parseDeploymentMode('')).toBe('public')
  })

  test('returns the mode for valid values', () => {
    expect(parseDeploymentMode('public')).toBe('public')
    expect(parseDeploymentMode('private-cloud')).toBe('private-cloud')
  })

  test('simulates an old-fixture settings.json without the field', () => {
    // An existing user's settings predates this feature entirely.
    const oldSettings: Record<string, unknown> = { theme: 'dark', alwaysThinkingEnabled: true }
    const mode = parseDeploymentMode(oldSettings.deploymentMode)
    expect(mode).toBe('public')
  })
})
