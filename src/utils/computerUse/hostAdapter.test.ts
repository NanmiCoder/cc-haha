import { expect, test } from 'bun:test'
import { createComputerUseHostAdapter } from './hostAdapter.js'
import type { ComputerExecutor } from '../../vendor/computer-use-mcp/executor.js'
import { bindSessionContext } from '../../vendor/computer-use-mcp/mcpServer.js'
import type { ComputerUseSessionContext } from '../../vendor/computer-use-mcp/types.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getComputerUseConfigPath } from './preauthorizedConfig.js'
import { invalidateComputerUseSkillGate, isComputerUseSkillEnabled } from './skillGate.js'
import { createAgentDesktopBackend } from './agentDesktopBridge.js'

test.each(['win32', 'linux'] as const)('%s host routes through native desktop and rechecks saved enablement', async platform => {
  let enabled = false
  let calls = 0
  const host = createComputerUseHostAdapter({
    platform,
    executor: { capabilities: { platform, screenshotFiltering: 'none', hostBundleId: 'fixture', agentDesktop: true } } as ComputerExecutor,
    agentDesktop: {
      execute: async () => { ++calls; return { content: [{ type: 'text', text: 'native' }] } },
      cleanup: async () => {},
    },
    enabled: () => enabled,
  })
  const dispatch = bindSessionContext(host, 'pixels', {} as ComputerUseSessionContext)
  expect((await dispatch('desktop', { command: 'status' })).isError).toBe(true)
  expect(calls).toBe(0)
  enabled = true
  expect((await dispatch('desktop', { command: 'status' })).content).toEqual([{ type: 'text', text: 'native' }])
  expect(calls).toBe(1)
  enabled = false
  expect((await dispatch('desktop', { command: 'click' })).isError).toBe(true)
  expect(calls).toBe(1)
})

test('a saved disablement stops the next native call even while skill visibility is cached', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cu-dispatch-consent-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousEnabled = process.env.CLAUDE_COMPUTER_USE_ENABLED
  try {
    process.env.CLAUDE_CONFIG_DIR = root
    process.env.CLAUDE_COMPUTER_USE_ENABLED = 'true'
    const filename = getComputerUseConfigPath()
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(filename, '{"enabled":true}')
    invalidateComputerUseSkillGate()
    expect(isComputerUseSkillEnabled()).toBe(true)
    let calls = 0
    const host = createComputerUseHostAdapter({
      platform: 'linux',
      executor: { capabilities: { platform: 'linux', screenshotFiltering: 'none', hostBundleId: 'fixture', agentDesktop: true } } as ComputerExecutor,
      agentDesktop: {
        execute: async () => { ++calls; return { content: [{ type: 'text', text: 'delivered' }] } },
        cleanup: async () => {},
      },
    })
    const dispatch = bindSessionContext(host, 'pixels', {} as ComputerUseSessionContext)
    expect((await dispatch('desktop', { command: 'click' })).isError).not.toBe(true)
    writeFileSync(filename, '{"enabled":false}')
    expect((await dispatch('desktop', { command: 'click' })).isError).toBe(true)
    expect(calls).toBe(1)
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousEnabled === undefined) delete process.env.CLAUDE_COMPUTER_USE_ENABLED
    else process.env.CLAUDE_COMPUTER_USE_ENABLED = previousEnabled
    invalidateComputerUseSkillGate()
    rmSync(root, { recursive: true, force: true })
  }
})

test('saving disablement during native initialization stops the same pending host call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cu-initializing-consent-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousEnabled = process.env.CLAUDE_COMPUTER_USE_ENABLED
  try {
    process.env.CLAUDE_CONFIG_DIR = root
    process.env.CLAUDE_COMPUTER_USE_ENABLED = 'true'
    const filename = getComputerUseConfigPath()
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(filename, '{"enabled":true}')
    const calls: string[][] = []
    const backend = createAgentDesktopBackend({
      configRoot: root, binaryPath: process.execPath, registerCleanup: () => () => {},
      runner: async request => {
        calls.push(request.args)
        writeFileSync(filename, '{"enabled":false}')
        return { stdout: '{"ok":true,"command":"session","data":{"session_id":"owned"}}', stderr: '', exitCode: 0 }
      },
    })
    const host = createComputerUseHostAdapter({
      platform: 'linux', agentDesktop: backend,
      executor: { capabilities: { platform: 'linux', screenshotFiltering: 'none', hostBundleId: 'fixture', agentDesktop: true } } as ComputerExecutor,
    })
    const result = await bindSessionContext(host, 'pixels', {} as ComputerUseSessionContext)('desktop', { command: 'click', args: ['@s:e1'] })
    expect(result.isError).toBe(true)
    expect(host.isDisabled()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 2)).toEqual(['session', 'start'])
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousEnabled === undefined) delete process.env.CLAUDE_COMPUTER_USE_ENABLED
    else process.env.CLAUDE_COMPUTER_USE_ENABLED = previousEnabled
    invalidateComputerUseSkillGate()
    rmSync(root, { recursive: true, force: true })
  }
})
