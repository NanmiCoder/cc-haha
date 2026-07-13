import { describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { PermissionsSchema } from '../settings/types.js'
import {
  EXTERNAL_PERMISSION_MODES,
  isExternalPermissionMode,
  permissionModeFromString,
  toExternalPermissionMode,
} from './PermissionMode.js'

describe('external Auto permission mode', () => {
  const autoModeTest = feature('TRANSCRIPT_CLASSIFIER') ? test : test.skip
  const featureOffTest = feature('TRANSCRIPT_CLASSIFIER') ? test.skip : test

  autoModeTest('preserves Auto through external conversion and settings', () => {
    expect(EXTERNAL_PERMISSION_MODES).toContain('auto')
    expect(isExternalPermissionMode('auto')).toBe(true)
    expect(toExternalPermissionMode('auto')).toBe('auto')
    expect(PermissionsSchema().parse({ defaultMode: 'auto' })).toEqual({
      defaultMode: 'auto',
    })
  })

  featureOffTest('keeps Auto unavailable without the classifier feature', () => {
    expect(EXTERNAL_PERMISSION_MODES).not.toContain('auto')
    expect(isExternalPermissionMode('auto')).toBe(false)
    expect(permissionModeFromString('auto')).toBe('default')
    expect(() =>
      PermissionsSchema().parse({ defaultMode: 'auto' }),
    ).toThrow()
  })
})
