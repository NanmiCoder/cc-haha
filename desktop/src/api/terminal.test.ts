import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserHost } from '../lib/desktopHost/browserHost'

// 浏览器端 terminal 命名空间底层是 /ws/terminal 的 WS 客户端；测试里 mock 掉，
// 只验证 terminalApi → browserHost.terminal → terminalWs 的委托链。
const terminalWsMock = vi.hoisted(() => ({
  client: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onOutput: vi.fn(),
    onExit: vi.fn(),
  },
  getTerminalWsClient: vi.fn(),
}))

vi.mock('../lib/desktopHost/terminalWs', () => ({
  getTerminalWsClient: terminalWsMock.getTerminalWsClient,
}))

describe('terminalApi desktop host bridge', () => {
  beforeEach(() => {
    vi.resetModules()
    terminalWsMock.getTerminalWsClient.mockReturnValue(terminalWsMock.client)
    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  it('routes terminal commands through an injected desktop host', async () => {
    const spawn = vi.fn().mockResolvedValue({
      session_id: 9,
      shell: '/bin/zsh',
      cwd: '/tmp/project',
    })
    const write = vi.fn().mockResolvedValue(undefined)
    const resize = vi.fn().mockResolvedValue(undefined)
    const kill = vi.fn().mockResolvedValue(undefined)
    const onOutput = vi.fn().mockResolvedValue(() => {})
    const onExit = vi.fn().mockResolvedValue(() => {})
    const getBashPath = vi.fn().mockResolvedValue('/bin/bash')
    const setBashPath = vi.fn().mockResolvedValue(undefined)

    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        terminal: true,
      },
      terminal: {
        spawn,
        write,
        resize,
        kill,
        onOutput,
        onExit,
        getBashPath,
        setBashPath,
      },
    }

    const { terminalApi } = await import('./terminal')
    const outputHandler = vi.fn()
    const exitHandler = vi.fn()

    await expect(terminalApi.spawn({ cols: 80, rows: 24, cwd: '/tmp/project' })).resolves.toEqual({
      session_id: 9,
      shell: '/bin/zsh',
      cwd: '/tmp/project',
    })
    await terminalApi.write(9, 'ls\n')
    await terminalApi.resize(9, 100, 30)
    await terminalApi.kill(9)
    await terminalApi.onOutput(outputHandler)
    await terminalApi.onExit(exitHandler)
    await expect(terminalApi.getBashPath()).resolves.toBe('/bin/bash')
    await terminalApi.setBashPath('/opt/bash')

    expect(terminalApi.isAvailable()).toBe(true)
    expect(spawn).toHaveBeenCalledWith({ cols: 80, rows: 24, cwd: '/tmp/project' })
    // New hot renderer must remain usable with an older, strict native preload.
    spawn.mockClear()
    await terminalApi.spawn({ cols: 80, rows: 24, requestId: 'early-event' })
    expect(spawn).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    window.desktopHost.terminal.supportsStartupCorrelation = true
    await terminalApi.spawn({ cols: 80, rows: 24, requestId: 'early-event' })
    expect(spawn).toHaveBeenLastCalledWith({ cols: 80, rows: 24, requestId: 'early-event' })
    expect(write).toHaveBeenCalledWith(9, 'ls\n')
    expect(resize).toHaveBeenCalledWith(9, 100, 30)
    expect(kill).toHaveBeenCalledWith(9)
    expect(onOutput).toHaveBeenCalledWith(outputHandler)
    expect(onExit).toHaveBeenCalledWith(exitHandler)
    expect(setBashPath).toHaveBeenCalledWith('/opt/bash')
  })

  it('routes the browser fallback through the terminal websocket client', async () => {
    const unlisten = vi.fn()
    terminalWsMock.client.spawn.mockResolvedValue({
      session_id: 4,
      shell: '/bin/bash',
      cwd: '/home/user',
    })
    terminalWsMock.client.onOutput.mockReturnValue(unlisten)
    terminalWsMock.client.onExit.mockReturnValue(unlisten)

    const { terminalApi } = await import('./terminal')

    expect(terminalApi.isAvailable()).toBe(true)
    const result = await terminalApi.spawn({ cols: 80, rows: 24, requestId: 'req-1' })
    expect(result).toEqual({ session_id: 4, shell: '/bin/bash', cwd: '/home/user' })
    expect(terminalWsMock.client.spawn).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      requestId: 'req-1',
    })

    await terminalApi.write(4, 'ls\n')
    await terminalApi.resize(4, 100, 30)
    await terminalApi.kill(4)
    expect(terminalWsMock.client.write).toHaveBeenCalledWith(4, 'ls\n')
    expect(terminalWsMock.client.resize).toHaveBeenCalledWith(4, 100, 30)
    expect(terminalWsMock.client.kill).toHaveBeenCalledWith(4)

    const outputHandler = vi.fn()
    const exitHandler = vi.fn()
    const off = await terminalApi.onOutput(outputHandler)
    const offExit = await terminalApi.onExit(exitHandler)
    expect(terminalWsMock.client.onOutput).toHaveBeenCalledWith(outputHandler)
    expect(terminalWsMock.client.onExit).toHaveBeenCalledWith(exitHandler)
    off()
    offExit()
  })
})
