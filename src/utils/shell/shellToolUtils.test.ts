import { describe, expect, test } from 'bun:test'
import {
  resolveAvailableShellTool,
  resolveShellToolAvailability,
} from './shellToolUtils.js'

describe('resolveShellToolAvailability', () => {
  test('falls back to PowerShell when Git Bash is unavailable on Windows', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'windows',
        gitBashPath: null,
        powerShellSetting: undefined,
      }),
    ).toEqual({ bash: false, powershell: true })
  })

  test('offers native PowerShell alongside an available Git Bash on Windows', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'windows',
        gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
        powerShellSetting: undefined,
      }),
    ).toEqual({ bash: true, powershell: true })
  })

  test('honors an explicit PowerShell opt-out', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'windows',
        gitBashPath: null,
        powerShellSetting: '0',
      }),
    ).toEqual({ bash: false, powershell: false })
  })

  test('keeps Bash available on non-Windows platforms', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'macos',
        gitBashPath: null,
        powerShellSetting: undefined,
      }),
    ).toEqual({ bash: true, powershell: false })
  })
})

describe('resolveAvailableShellTool', () => {
  test('keeps the preferred shell when it is available', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: true, powershell: true },
      }),
    ).toBe('bash')
  })

  test('falls back to PowerShell when Bash is unavailable', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: false, powershell: true },
      }),
    ).toBe('powershell')
  })

  test('does not reinterpret an explicit shell syntax contract', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: false, powershell: true },
        allowFallback: false,
      }),
    ).toBeNull()
  })

  test('returns null when neither shell is available', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: false, powershell: false },
      }),
    ).toBeNull()
  })
})
