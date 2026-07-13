import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { feature } from 'bun:bundle'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../../utils/settings/settingsCache.js'

process.env.ANTHROPIC_API_KEY = 'test-key'

let capturedQuery: Record<string, unknown> | undefined
mock.module('../../utils/sideQuery.js', () => ({
  sideQuery: async (options: Record<string, unknown>) => {
    capturedQuery = options
    return {
      content: [{ type: 'text', text: 'critique complete' }],
    }
  },
}))

const transcriptClassifierEnabled = feature('TRANSCRIPT_CLASSIFIER')
  ? true
  : false
const autoModeTest = transcriptClassifierEnabled ? test : test.skip
const featureOffTest = transcriptClassifierEnabled ? test.skip : test

afterEach(() => {
  capturedQuery = undefined
  resetSettingsCache()
  mock.restore()
})

describe('auto-mode CLI handlers', () => {
  featureOffTest('keeps the handlers gated out of feature-off builds', () => {
    expect(transcriptClassifierEnabled).toBe(false)
  })

  autoModeTest('preserves empty replacements and expands $defaults', async () => {
    await import('../../utils/permissions/permissions.js')
    const { autoModeConfigHandler } = await import('./autoMode.js')
    const { getDefaultExternalAutoModeRules } = await import(
      '../../utils/permissions/yoloClassifier.js'
    )
    const defaults = getDefaultExternalAutoModeRules()
    setCachedSettingsForSource('userSettings', {
      autoMode: {
        allow: [],
        soft_deny: ['$defaults', 'custom soft deny'],
        hard_deny: [],
        environment: [],
      },
    } as never)
    let output = ''
    spyOn(process.stdout, 'write').mockImplementation(chunk => {
      output += String(chunk)
      return true
    })

    autoModeConfigHandler()

    expect(JSON.parse(output)).toEqual({
      allow: [],
      soft_deny: [...defaults.soft_deny, 'custom soft deny'],
      hard_deny: [],
      environment: [],
    })
  })

  autoModeTest('includes hard-deny rules in critique input', async () => {
    await import('../../utils/permissions/permissions.js')
    const { autoModeCritiqueHandler } = await import('./autoMode.js')
    setCachedSettingsForSource('userSettings', {
      autoMode: {
        hard_deny: ['never export private keys'],
      },
    } as never)
    spyOn(process.stdout, 'write').mockImplementation(() => true)

    await autoModeCritiqueHandler({ model: 'test-model' })

    expect(capturedQuery).toBeDefined()
    const serializedQuery = JSON.stringify(capturedQuery ?? {})
    expect(serializedQuery).toContain('hard_deny')
    expect(serializedQuery).toContain(
      'never export private keys',
    )
  })

  autoModeTest('shows an explicit empty hard-deny replacement for critique', async () => {
    await import('../../utils/permissions/permissions.js')
    const { autoModeCritiqueHandler } = await import('./autoMode.js')
    setCachedSettingsForSource('userSettings', {
      autoMode: {
        hard_deny: [],
      },
    } as never)
    spyOn(process.stdout, 'write').mockImplementation(() => true)

    await autoModeCritiqueHandler({ model: 'test-model' })

    const serializedQuery = JSON.stringify(capturedQuery ?? {})
    expect(serializedQuery).toContain('hard_deny')
    expect(serializedQuery).toContain('(explicitly empty)')
    expect(serializedQuery).toContain('Defaults being replaced')
  })

  autoModeTest('expands $defaults before presenting effective critique rules', async () => {
    await import('../../utils/permissions/permissions.js')
    const { autoModeCritiqueHandler } = await import('./autoMode.js')
    const { getDefaultExternalAutoModeRules } = await import(
      '../../utils/permissions/yoloClassifier.js'
    )
    const defaults = getDefaultExternalAutoModeRules()
    setCachedSettingsForSource('userSettings', {
      autoMode: {
        soft_deny: ['$defaults', 'custom soft deny'],
      },
    } as never)
    spyOn(process.stdout, 'write').mockImplementation(() => true)

    await autoModeCritiqueHandler({ model: 'test-model' })

    const messages = capturedQuery?.messages as
      | Array<{ content?: string }>
      | undefined
    const summary = messages?.[0]?.content?.split(
      "Here are the user's custom rules",
    )[1]
    expect(summary).toContain(defaults.soft_deny[0]!)
    expect(summary).toContain('custom soft deny')
    expect(summary).not.toContain('- $defaults')
  })
})
