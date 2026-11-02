import { describe, expect, it } from 'vitest'
import type { ComputerUseStatus } from '@/api/computerUse'
import { needsComputerUsePermissionCard } from './computerUseEnable'

function status(platform: string, engine: ComputerUseStatus['engine']): ComputerUseStatus {
  return {
    platform,
    engine,
    supported: true,
    systemVersion: null,
    arch: 'x64',
    cuHelper: { available: true, supported: true, minimumMacosVersion: '14.4', reason: null },
    python: { installed: false, version: null, path: null, source: null, error: null },
    venv: { created: false, path: '/fixture/unused' },
    dependencies: { installed: false, requirementsFound: false },
    permissions: { accessibility: false, screenRecording: false },
  }
}

describe('Computer Use OS permission card', () => {
  it('opens only for the macOS native engine with a missing permission', () => {
    const macos = status('darwin', 'macos-native')
    expect(needsComputerUsePermissionCard(macos)).toBe(true)
    expect(needsComputerUsePermissionCard({
      ...macos,
      permissions: { accessibility: true, screenRecording: true },
    })).toBe(false)
  })

  it('never opens macOS TCC UI for Windows or Linux', () => {
    for (const platform of ['win32', 'linux']) {
      expect(needsComputerUsePermissionCard(status(platform, 'agent-desktop'))).toBe(false)
      expect(needsComputerUsePermissionCard(status(platform, 'macos-native'))).toBe(false)
    }
    expect(needsComputerUsePermissionCard(null)).toBe(false)
  })
})
