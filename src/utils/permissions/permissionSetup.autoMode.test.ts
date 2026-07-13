import { afterEach, describe, expect, it } from 'bun:test'
import { feature } from 'bun:bundle'
import { readFileSync } from 'node:fs'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { PERMISSION_MODES } from './PermissionMode.js'
import {
  findDangerousClassifierPermissions,
  getAutoModeEnabledState,
  initialPermissionModeFromCLI,
  reconcileAutoModePermissionsAfterSettingsChange,
  restoreDangerousPermissions,
} from './permissionSetup.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../settings/settingsCache.js'
import {
  getAutoModeConfig,
  hasAutoModeOptIn,
} from '../settings/settings.js'

afterEach(() => {
  resetSettingsCache()
})

const autoModeDescribe = feature('TRANSCRIPT_CLASSIFIER')
  ? describe
  : describe.skip

describe('auto mode feature guard', () => {
  const featureOffTest = feature('TRANSCRIPT_CLASSIFIER') ? it.skip : it

  featureOffTest('keeps Auto unavailable without the classifier feature', () => {
    expect(PERMISSION_MODES).not.toContain('auto')
  })
})

autoModeDescribe('local auto mode gate', () => {
  it('includes auto when the transcript classifier feature is enabled', () => {
    expect(PERMISSION_MODES).toContain('auto')
  })

  it('defaults to local opt-in when remote config has not loaded', () => {
    expect(getAutoModeEnabledState()).toBe('opt-in')
    expect(
      initialPermissionModeFromCLI({
        permissionModeCli: 'auto',
        dangerouslySkipPermissions: false,
      }).mode,
    ).toBe('auto')
  })
})

autoModeDescribe('trusted auto mode settings', () => {
  it('accepts hard_deny and classifyAllShell from trusted user settings', () => {
    setCachedSettingsForSource('userSettings', {
      autoMode: {
        hard_deny: ['never publish credentials'],
        classifyAllShell: true,
      },
    } as never)

    expect(getAutoModeConfig()).toEqual({
      hard_deny: ['never publish credentials'],
      classifyAllShell: true,
    })
  })

  it('preserves explicit empty rule arrays as default replacements', () => {
    setCachedSettingsForSource('userSettings', {
      autoMode: {
        allow: [],
        soft_deny: [],
        hard_deny: [],
        environment: [],
      },
    } as never)

    expect(getAutoModeConfig()).toEqual({
      allow: [],
      soft_deny: [],
      hard_deny: [],
      environment: [],
    })
  })

  it('accepts private local rules without accepting local consent', () => {
    setCachedSettingsForSource('localSettings', {
      skipAutoPermissionPrompt: true,
      autoMode: {
        allow: ['allow the private local workflow'],
      },
    } as never)

    expect(hasAutoModeOptIn()).toBe(false)
    expect(getAutoModeConfig()).toEqual({
      allow: ['allow the private local workflow'],
    })
  })

  it('ignores shared project classifier rules', () => {
    setCachedSettingsForSource('projectSettings', {
      autoMode: {
        allow: ['allow everything'],
      },
    } as never)

    expect(getAutoModeConfig()).toBeUndefined()
  })

  it('treats every shell allow rule as classifier-bypassing when requested', () => {
    setCachedSettingsForSource('userSettings', {
      autoMode: { classifyAllShell: true },
    } as never)

    const dangerous = findDangerousClassifierPermissions(
      [
        {
          source: 'userSettings',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'Bash', ruleContent: 'git status' },
        },
      ],
      ['Bash(git status)'],
    )

    expect(dangerous).toHaveLength(2)
  })
})

autoModeDescribe('auto mode settings reload reconciliation', () => {
  it('wires reconciliation into settings reload before plan transitions', () => {
    const source = readFileSync(
      new URL('../settings/applySettingsChange.ts', import.meta.url),
      'utf8',
    )
    const syncIndex = source.indexOf('syncPermissionRulesFromDisk(')
    const reconcileIndex = source.indexOf(
      'reconcileAutoModePermissionsAfterSettingsChange(',
      syncIndex,
    )
    const transitionIndex = source.indexOf(
      'transitionPlanAutoMode(',
      reconcileIndex,
    )

    expect(syncIndex).toBeGreaterThanOrEqual(0)
    expect(reconcileIndex).toBeGreaterThan(syncIndex)
    expect(transitionIndex).toBeGreaterThan(reconcileIndex)
  })

  it('does not restore a dangerous disk rule deleted while Auto is active', () => {
    const context = {
      ...getEmptyToolPermissionContext(),
      mode: 'auto' as const,
      strippedDangerousRules: {
        userSettings: ['Bash(python:*)'],
      },
    }

    const reconciled = reconcileAutoModePermissionsAfterSettingsChange(
      context,
      [],
    )
    const restored = restoreDangerousPermissions(reconciled)

    expect(restored.alwaysAllowRules.userSettings ?? []).not.toContain(
      'Bash(python:*)',
    )
  })

  it('restores only the latest disk rule once after a hot update', () => {
    const context = {
      ...getEmptyToolPermissionContext(),
      mode: 'auto' as const,
      alwaysAllowRules: {
        ...getEmptyToolPermissionContext().alwaysAllowRules,
        userSettings: ['Bash(node:*)'],
      },
      strippedDangerousRules: {
        userSettings: ['Bash(python:*)'],
      },
    }
    const diskRules = [
      {
        source: 'userSettings' as const,
        ruleBehavior: 'allow' as const,
        ruleValue: { toolName: 'Bash', ruleContent: 'node:*' },
      },
    ]

    const once = reconcileAutoModePermissionsAfterSettingsChange(
      context,
      diskRules,
    )
    const twice = reconcileAutoModePermissionsAfterSettingsChange(
      once,
      diskRules,
    )
    const restored = restoreDangerousPermissions(twice)

    expect(restored.alwaysAllowRules.userSettings).toEqual(['Bash(node:*)'])
  })

  it('preserves a stripped session rule without duplicating it', () => {
    const context = {
      ...getEmptyToolPermissionContext(),
      mode: 'auto' as const,
      strippedDangerousRules: {
        session: ['Bash(python:*)'],
      },
    }

    const once = reconcileAutoModePermissionsAfterSettingsChange(
      context,
      [],
    )
    const twice = reconcileAutoModePermissionsAfterSettingsChange(once, [])
    const restored = restoreDangerousPermissions(twice)

    expect(restored.alwaysAllowRules.session).toEqual(['Bash(python:*)'])
  })

  it('moves a newly added dangerous session rule into the Auto stash', () => {
    const context = {
      ...getEmptyToolPermissionContext(),
      mode: 'auto' as const,
      alwaysAllowRules: {
        ...getEmptyToolPermissionContext().alwaysAllowRules,
        session: ['Bash(python:*)'],
      },
    }

    const reconciled = reconcileAutoModePermissionsAfterSettingsChange(
      context,
      [],
    )

    expect(reconciled.alwaysAllowRules.session ?? []).not.toContain(
      'Bash(python:*)',
    )
    expect(reconciled.strippedDangerousRules?.session).toEqual([
      'Bash(python:*)',
    ])
  })
})
