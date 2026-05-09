import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DESKTOP_GRANT_FLAGS,
  resolveStoredComputerUseConfig,
} from './preauthorizedConfig.js'

describe('resolveStoredComputerUseConfig', () => {
  test('keeps desktop grant flags enabled by default even without authorized apps', () => {
    expect(resolveStoredComputerUseConfig()).toEqual({
      enabled: true,
      authorizedApps: [],
      grantFlags: DEFAULT_DESKTOP_GRANT_FLAGS,
    })
  })

  test('preserves an explicit disabled state', () => {
    expect(resolveStoredComputerUseConfig({ enabled: false })).toMatchObject({
      enabled: false,
      authorizedApps: [],
    })
  })

  test('merges stored grant flags without discarding unspecified defaults', () => {
    expect(
      resolveStoredComputerUseConfig({
        grantFlags: {
          clipboardRead: false,
        },
      }),
    ).toEqual({
      enabled: true,
      authorizedApps: [],
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
    })
  })
})
