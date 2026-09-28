import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNetworkManagerService } from './service'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})
async function fixture(platform = 'win32') {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'network-connections-test-'))
  directories.push(configDir)
  vi.stubEnv('SystemRoot', 'D:\\Fixture Windows')
  const openPath = vi.fn(async (_target: string) => '')
  const runner = vi.fn(async () => { throw new Error('Must not run a network command') })
  const openExternal = vi.fn(async (_url: string) => {})
  const resolveHost = vi.fn(async () => null)
  const service = createNetworkManagerService({ configDir, platform, openPath, runner, openExternal, resolveHost })
  return { configDir, service, openPath, runner, openExternal, resolveHost }
}

describe('open Windows Network Connections', () => {
  it('opens only the fixed system applet without a profile, elevation, shell or network writes', async () => {
    const f = await fixture()
    expect(await f.service.openNetworkConnections()).toEqual({ ok: true, data: null })
    expect(f.openPath).toHaveBeenCalledExactlyOnceWith('D:\\Fixture Windows\\System32\\ncpa.cpl')
    expect(f.runner).not.toHaveBeenCalled()
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(f.resolveHost).not.toHaveBeenCalled()
    expect(await fs.readdir(f.configDir)).toEqual([])
  })

  it.each(['linux', 'darwin'])('rejects %s before launching any process', async platform => {
    const f = await fixture(platform)
    expect(await f.service.openNetworkConnections()).toMatchObject({ ok: false, error: { code: 'WINDOWS_REQUIRED' } })
    expect(f.openPath).not.toHaveBeenCalled()
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('reports an OS association error and allows a retry without leaking native details', async () => {
    const f = await fixture()
    f.openPath.mockResolvedValueOnce('private native launch detail')
    expect(await f.service.openNetworkConnections()).toEqual({ ok: false, error: { code: 'NETWORK_CONNECTIONS_OPEN_FAILED', message: 'NETWORK_CONNECTIONS_OPEN_FAILED' } })
    expect(await f.service.openNetworkConnections()).toEqual({ ok: true, data: null })
    expect(f.openPath).toHaveBeenCalledTimes(2)
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('handles rejected launch promises as a stable public error', async () => {
    const f = await fixture()
    f.openPath.mockRejectedValueOnce(new Error('private native launch detail'))
    expect(await f.service.openNetworkConnections()).toEqual({ ok: false, error: { code: 'NETWORK_CONNECTIONS_OPEN_FAILED', message: 'NETWORK_CONNECTIONS_OPEN_FAILED' } })
  })

  it.each(['relative-path', '\\\\remote\\Windows'])('does not launch an applet from an invalid system directory: %s', async systemRoot => {
    const f = await fixture()
    vi.stubEnv('SystemRoot', systemRoot)
    expect(await f.service.openNetworkConnections()).toMatchObject({ ok: false, error: { code: 'NETWORK_CONNECTIONS_OPEN_FAILED' } })
    expect(f.openPath).not.toHaveBeenCalled()
  })

  it('documents the launch action without executing it or requiring editable parameters', async () => {
    const f = await fixture()
    const result = await f.service.executionCatalog()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.data.actions.find(action => action.id === 'openNetworkConnections')).toMatchObject({
      kind: 'launch', script: expect.stringContaining('ncpa.cpl'), functionName: expect.stringContaining('shell.openPath'),
    })
    expect(f.openPath).not.toHaveBeenCalled()
    expect(f.runner).not.toHaveBeenCalled()
  })
})
