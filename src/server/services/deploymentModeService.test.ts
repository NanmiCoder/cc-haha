import { describe, expect, test, beforeEach } from 'bun:test'
import { deploymentModeService } from './deploymentModeService.js'

beforeEach(() => {
  deploymentModeService.reset()
})

describe('deploymentModeService', () => {
  test('defaults to public when uninitialized', () => {
    expect(deploymentModeService.getMode()).toBe('public')
    expect(deploymentModeService.isPrivateCloud()).toBe(false)
  })

  test('defaults to public when deploymentMode is missing (backward compat)', () => {
    deploymentModeService.init({})
    expect(deploymentModeService.getMode()).toBe('public')
    expect(deploymentModeService.isPrivateCloud()).toBe(false)
  })

  test('initializes to private-cloud when explicitly set', () => {
    deploymentModeService.init({
      deploymentMode: 'private-cloud',
      privateCloud: { providerGatewayBaseUrl: 'https://gw.intra' },
    })
    expect(deploymentModeService.getMode()).toBe('private-cloud')
    expect(deploymentModeService.isPrivateCloud()).toBe(true)
    expect(deploymentModeService.getPrivateCloudConfig()).toEqual({
      providerGatewayBaseUrl: 'https://gw.intra',
    })
  })

  test('degrades to public for an illegal value', () => {
    deploymentModeService.init({ deploymentMode: 'on-prem' })
    expect(deploymentModeService.getMode()).toBe('public')
    expect(deploymentModeService.isPrivateCloud()).toBe(false)
  })

  test('ignores privateCloud config in public mode', () => {
    deploymentModeService.init({
      deploymentMode: 'public',
      privateCloud: { providerGatewayBaseUrl: 'https://gw.intra' },
    })
    expect(deploymentModeService.getMode()).toBe('public')
    expect(deploymentModeService.getPrivateCloudConfig()).toEqual({})
  })

  test('parses privateCloud config block with all known fields', () => {
    deploymentModeService.init({
      deploymentMode: 'private-cloud',
      privateCloud: {
        providerGatewayBaseUrl: 'https://gw.intra',
        dingtalkEndpoint: 'https://dt.intra',
        feishuEndpoint: 'https://fs.intra',
        updateServerUrl: 'https://up.intra',
        internalSkillSource: 'https://sk.intra',
        telemetryEndpoint: 'https://tm.intra',
      },
    })
    const config = deploymentModeService.getPrivateCloudConfig()
    expect(config.providerGatewayBaseUrl).toBe('https://gw.intra')
    expect(config.dingtalkEndpoint).toBe('https://dt.intra')
    expect(config.feishuEndpoint).toBe('https://fs.intra')
    expect(config.updateServerUrl).toBe('https://up.intra')
    expect(config.internalSkillSource).toBe('https://sk.intra')
    expect(config.telemetryEndpoint).toBe('https://tm.intra')
  })

  test('trims whitespace from privateCloud config values', () => {
    deploymentModeService.init({
      deploymentMode: 'private-cloud',
      privateCloud: {
        providerGatewayBaseUrl: '  https://gw.intra  ',
        dingtalkEndpoint: '\thttps://dt.intra\n',
      },
    })
    const config = deploymentModeService.getPrivateCloudConfig()
    expect(config.providerGatewayBaseUrl).toBe('https://gw.intra')
    expect(config.dingtalkEndpoint).toBe('https://dt.intra')
  })

  test('skips empty-string privateCloud config values', () => {
    deploymentModeService.init({
      deploymentMode: 'private-cloud',
      privateCloud: {
        providerGatewayBaseUrl: '',
        dingtalkEndpoint: '   ',
        feishuEndpoint: 'https://fs.intra',
      },
    })
    const config = deploymentModeService.getPrivateCloudConfig()
    expect(config.providerGatewayBaseUrl).toBeUndefined()
    expect(config.dingtalkEndpoint).toBeUndefined()
    expect(config.feishuEndpoint).toBe('https://fs.intra')
  })

  test('isFeatureEnabled returns true for public-only features in public mode', () => {
    deploymentModeService.init({ deploymentMode: 'public' })
    expect(deploymentModeService.isFeatureEnabled('skill-market')).toBe(true)
    expect(deploymentModeService.isFeatureEnabled('official-oauth')).toBe(true)
    expect(deploymentModeService.isFeatureEnabled('auto-update-check')).toBe(true)
  })

  test('isFeatureEnabled returns false for public-only features in private-cloud mode', () => {
    deploymentModeService.init({ deploymentMode: 'private-cloud' })
    expect(deploymentModeService.isFeatureEnabled('skill-market')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('official-oauth')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('official-mcp-registry')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('official-plugin-market')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('claude-in-chrome')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('im-telegram')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('im-whatsapp')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('im-wechat')).toBe(false)
    expect(deploymentModeService.isFeatureEnabled('auto-update-check')).toBe(false)
  })
})

describe('old-fixture backward compatibility', () => {
  test('settings without deploymentMode field defaults to public', () => {
    // Simulates an existing user's settings.json that predates this feature.
    const oldSettings = {
      // Typical fields that exist in current settings.json, minus deploymentMode.
      alwaysThinkingEnabled: true,
      skipWebFetchPreflight: true,
      theme: 'dark',
      chatSendBehavior: 'enter',
    }
    deploymentModeService.init(oldSettings)
    expect(deploymentModeService.getMode()).toBe('public')
    expect(deploymentModeService.isPrivateCloud()).toBe(false)
    expect(deploymentModeService.getPrivateCloudConfig()).toEqual({})
    // All features remain enabled — zero impact on existing users.
    expect(deploymentModeService.isFeatureEnabled('skill-market')).toBe(true)
  })

  test('settings with null/undefined deploymentMode defaults to public', () => {
    deploymentModeService.init({ deploymentMode: null })
    expect(deploymentModeService.getMode()).toBe('public')
    deploymentModeService.reset()
    deploymentModeService.init({ deploymentMode: undefined })
    expect(deploymentModeService.getMode()).toBe('public')
  })
})
