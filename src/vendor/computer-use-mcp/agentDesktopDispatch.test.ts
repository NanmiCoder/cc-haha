import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, mock, test } from 'bun:test'
import { bindSessionContext, buildPlatformComputerUseTools } from './mcpServer.js'
import { AGENT_DESKTOP_COMMANDS, parseAgentDesktopInput } from './agentDesktopProtocol.js'
import type { ComputerUseHostAdapter, ComputerUseSessionContext } from './types.js'
import type { ComputerExecutor } from './executor.js'

function fixture(platform: 'win32' | 'linux' = 'win32') {
  const execute = mock(async () => ({ content: [
    { type: 'text' as const, text: '{"ok":true,"data":{"disposition":{"delivery":"delivered_unverified"}}}' },
    { type: 'image' as const, mimeType: 'image/png', data: 'fixture' },
  ] }))
  const adapter = {
    executor: { capabilities: { platform, agentDesktop: true, screenshotFiltering: 'none', hostBundleId: 'fixture' } } as ComputerExecutor,
    agentDesktop: { execute, cleanup: async () => {} },
    isDisabled: () => false,
  } as unknown as ComputerUseHostAdapter
  const context: ComputerUseSessionContext = {
    getAllowedApps: () => { throw new Error('must not request per-app grants') },
    getGrantFlags: () => ({ clipboardRead: true, clipboardWrite: true, systemKeyCombos: true }),
    getUserDeniedBundleIds: () => [], getSelectedDisplayId: () => undefined,
  }
  return { adapter, context, execute }
}

describe('native desktop MCP path', () => {
  test.each(['win32', 'linux'] as const)('%s exposes the native command surface and retains receipts/images', async platform => {
    const { adapter, context, execute } = fixture(platform)
    const tools = buildPlatformComputerUseTools(adapter.executor.capabilities, 'pixels')
    expect(tools.map(tool => tool.name)).toEqual(['desktop'])
    expect((tools[0]!.inputSchema.properties!.command as { enum: string[] }).enum).toEqual([...AGENT_DESKTOP_COMMANDS])
    const dispatch = bindSessionContext(adapter, 'pixels', context)
    const result = await dispatch('desktop', { command: 'set-value', args: ['@snap:e1', 'hello'] })
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('delivered_unverified') })
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(execute).toHaveBeenCalledWith({ command: 'set-value', args: ['@snap:e1', 'hello'] }, undefined, 'main')
  })

  test('rejects malformed commands, legacy tools, disablement and cancellation before native dispatch', async () => {
    const { adapter, context, execute } = fixture()
    const dispatch = bindSessionContext(adapter, 'pixels', context)
    for (const args of [{ command: 'sh' }, { command: 'click', args: 'shell text' }, { command: 'click', unexpected: true }]) {
      expect((await dispatch('desktop', args)).isError).toBe(true)
    }
    expect((await dispatch('left_click', { x: 1, y: 2 })).isError).toBe(true)
    adapter.isDisabled = () => true
    expect((await dispatch('desktop', { command: 'click' })).isError).toBe(true)
    adapter.isDisabled = () => false
    expect((await dispatch('desktop', { command: 'click' }, AbortSignal.abort())).isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  test('checks ownership again after acquiring and never dispatches across a lost lock', async () => {
    const { adapter, context, execute } = fixture()
    context.checkCuLock = mock(async () => ({ holder: undefined as string | undefined, isSelf: false }))
    context.acquireCuLock = mock(async () => {})
    const result = await bindSessionContext(adapter, 'pixels', context)('desktop', { command: 'click' })
    expect(result.isError).toBe(true)
    expect(context.acquireCuLock).toHaveBeenCalledTimes(1)
    expect(context.checkCuLock).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
  })

  test('serializes complete calls while preserving each subagent identity and queued cancellation', async () => {
    const { adapter, context } = fixture()
    const identities = new AsyncLocalStorage<string>()
    context.getAgentId = () => identities.getStore()!
    let unblock!: () => void
    const waiting = new Promise<void>(resolve => { unblock = resolve })
    const calls: string[] = []
    adapter.agentDesktop!.execute = async (_input, _signal, id) => {
      calls.push(id!)
      if (id === 'first') await waiting
      return { content: [{ type: 'text', text: id! }] }
    }
    const dispatch = bindSessionContext(adapter, 'pixels', context)
    const first = identities.run('first', () => dispatch('desktop', { command: 'click' }))
    await Promise.resolve()
    const cancelled = new AbortController()
    const second = identities.run('cancelled', () => dispatch('desktop', { command: 'click' }, cancelled.signal))
    const third = identities.run('third', () => dispatch('desktop', { command: 'click' }))
    cancelled.abort()
    expect(calls).toEqual(['first'])
    unblock()
    await first
    expect((await second).isError).toBe(true)
    expect((await third).content).toEqual([{ type: 'text', text: 'third' }])
    expect(calls).toEqual(['first', 'third'])
  })

  test('the command parser refuses shell-like payloads and preserves literal text arguments', () => {
    expect(() => parseAgentDesktopInput({ command: 'click', args: ['\0'] })).toThrow()
    expect(parseAgentDesktopInput({ command: 'set-value', args: ['@snap:e1', '$(literal); text'] }).args)
      .toEqual(['@snap:e1', '$(literal); text'])
  })
})
