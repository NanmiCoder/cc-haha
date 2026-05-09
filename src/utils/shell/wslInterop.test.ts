import { describe, expect, test } from 'bun:test'
import {
  commandInvokesWsl,
  getWslInteropEnvironmentOverrides,
} from './wslInterop.js'

describe('wsl interop environment', () => {
  test('detects direct wsl invocations', () => {
    expect(commandInvokesWsl('wsl ls /home/lenovo')).toBe(true)
    expect(commandInvokesWsl('echo ok && wsl.exe -e bash -lc pwd')).toBe(true)
    expect(commandInvokesWsl('echo browser-wsl-helper')).toBe(false)
  })

  test('disables MSYS path conversion for Windows wsl commands', () => {
    expect(
      getWslInteropEnvironmentOverrides({
        platform: 'windows',
        command: 'wsl ls /home/lenovo',
        currentEnv: {},
      }),
    ).toEqual({
      MSYS2_ARG_CONV_EXCL: '*',
      WSL_UTF8: '1',
    })
  })

  test('also handles shell prefixes that route commands through WSL', () => {
    expect(
      getWslInteropEnvironmentOverrides({
        platform: 'windows',
        command: 'node --version',
        shellPrefix: 'wsl -e bash -lc',
        currentEnv: { MSYS2_ARG_CONV_EXCL: '/mnt/*' },
      }),
    ).toEqual({
      MSYS2_ARG_CONV_EXCL: '/mnt/*',
      WSL_UTF8: '1',
    })
  })

  test('does nothing away from Windows', () => {
    expect(
      getWslInteropEnvironmentOverrides({
        platform: 'wsl',
        command: 'wsl ls /home/lenovo',
        currentEnv: {},
      }),
    ).toEqual({})
  })
})
