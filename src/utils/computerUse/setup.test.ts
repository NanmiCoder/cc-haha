import { describe, expect, test } from 'bun:test'

import { setupComputerUseMCP } from './setup.js'

describe('setupComputerUseMCP runtime capability', () => {
  test('does not expose tools when the canonical macOS helper is unavailable', () => {
    expect(setupComputerUseMCP({
      platform: 'darwin',
      resolveMacosNativeBinary: () => null,
    })).toEqual({ mcpConfig: {}, allowedTools: [] })
  })

  test('exposes the native tools only after the macOS helper is launchable', () => {
    const result = setupComputerUseMCP({
      platform: 'darwin',
      resolveMacosNativeBinary: () => '/cfg/cu-helper/helper',
    })

    expect(Object.keys(result.mcpConfig)).toEqual(['computer-use'])
    expect(result.allowedTools).toEqual(['mcp__computer-use__js', 'mcp__computer-use__js_reset'])
  })

  test('advertises the complete native desktop dispatcher on Windows', () => {
    const result = setupComputerUseMCP({
      platform: 'win32',
      resolveAgentDesktopBinary: () => '/bin/agent-desktop.exe',
      resolveMacosNativeBinary: () => {
        throw new Error('must not resolve a macOS helper on Windows')
      },
    })

    expect(Object.keys(result.mcpConfig)).toEqual(['computer-use'])
    expect(result.allowedTools).toEqual(['mcp__computer-use__desktop'])
  })

  test('requires the native runtime on both Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(setupComputerUseMCP({ platform, resolveAgentDesktopBinary: () => null }))
        .toEqual({ mcpConfig: {}, allowedTools: [] })
      expect(setupComputerUseMCP({ platform, resolveAgentDesktopBinary: () => '/bin/agent-desktop' }).allowedTools)
        .toEqual(['mcp__computer-use__desktop'])
    }
  })

  test('does not resolve a helper or advertise tools on unsupported platforms', () => {
    expect(setupComputerUseMCP({
      platform: 'freebsd',
      resolveMacosNativeBinary: () => {
        throw new Error('must not resolve a macOS helper on Linux')
      },
    })).toEqual({ mcpConfig: {}, allowedTools: [] })
  })
})
