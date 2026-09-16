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

  test('keeps the Windows compatibility engine available without a macOS helper', () => {
    const result = setupComputerUseMCP({
      platform: 'win32',
      resolveMacosNativeBinary: () => {
        throw new Error('must not resolve a macOS helper on Windows')
      },
    })

    expect(Object.keys(result.mcpConfig)).toEqual(['computer-use'])
    expect(result.allowedTools).toContain('mcp__computer-use__screenshot')
    expect(result.allowedTools).not.toContain('mcp__computer-use__get_app_state')
    expect(result.allowedTools).not.toContain('mcp__computer-use__sequence')
    expect(result.allowedTools).not.toContain('mcp__computer-use__js')
  })

  test('does not resolve a helper or advertise tools on unsupported platforms', () => {
    expect(setupComputerUseMCP({
      platform: 'linux',
      resolveMacosNativeBinary: () => {
        throw new Error('must not resolve a macOS helper on Linux')
      },
    })).toEqual({ mcpConfig: {}, allowedTools: [] })
  })
})
