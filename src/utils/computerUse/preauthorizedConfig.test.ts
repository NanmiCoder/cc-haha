import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DESKTOP_GRANT_FLAGS,
  resolveStoredComputerUseConfig,
} from './preauthorizedConfig.js'

describe('resolveStoredComputerUseConfig', () => {
  test('keeps desktop grant flags enabled by default even without authorized apps', () => {
    expect(resolveStoredComputerUseConfig()).toEqual({
      authorizedApps: [],
      grantFlags: DEFAULT_DESKTOP_GRANT_FLAGS,
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
      authorizedApps: [],
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
    })
  })
})

