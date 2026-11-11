import { expect, it, vi } from 'vitest'
import { LoginStartupService } from './loginStartup'

it('reads actual system state after setting login startup and reports macOS approval', () => {
  const api = { isPackaged: true, getPath: () => '/fixture/cc-haha', getLoginItemSettings: vi.fn(() => ({ openAtLogin: false, status: 'requires-approval' })), setLoginItemSettings: vi.fn() }
  const service = new LoginStartupService(api, 'darwin')
  expect(service.set(true)).toEqual({ supported: true, enabled: false, requiresApproval: true })
  expect(api.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  expect(service.get().enabled).toBe(false)
})
it('uses identical executable selection for Windows reads and writes', () => {
  const api = { isPackaged: true, getPath: () => 'C:\\fixture\\cc-haha.exe', getLoginItemSettings: vi.fn(() => ({ openAtLogin: true })), setLoginItemSettings: vi.fn() }
  const service = new LoginStartupService(api, 'win32')
  expect(service.set(false).enabled).toBe(true)
  expect(api.getLoginItemSettings).toHaveBeenCalledWith({ path: 'C:\\fixture\\cc-haha.exe', args: [] })
  expect(api.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, path: 'C:\\fixture\\cc-haha.exe', args: [] })
})
it('never registers a development Electron binary or changes unsupported platforms', () => {
  for (const [isPackaged, platform] of [[false, 'darwin'], [true, 'linux']] as const) {
    const api = { isPackaged, getPath: vi.fn(), getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() }
    expect(new LoginStartupService(api, platform).set(true)).toEqual({ supported: false, enabled: false, requiresApproval: false })
    expect(api.setLoginItemSettings).not.toHaveBeenCalled()
    expect(api.getLoginItemSettings).not.toHaveBeenCalled()
  }
})
it('returns a bounded error without leaking system exception details', () => {
  const api = { isPackaged: true, getPath: () => '/fixture/app', getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })), setLoginItemSettings: vi.fn(() => { throw new Error('private system path') }) }
  expect(new LoginStartupService(api, 'darwin').set(true)).toEqual({ supported: true, enabled: false, requiresApproval: false, error: 'unavailable' })
})
it('reports Windows Task Manager disablement even when the login registry entry exists', () => {
  const api = { isPackaged: true, getPath: () => 'C:\\fixture\\app.exe', getLoginItemSettings: vi.fn(() => ({ openAtLogin: true, executableWillLaunchAtLogin: false })), setLoginItemSettings: vi.fn() }
  expect(new LoginStartupService(api, 'win32').get().enabled).toBe(false)
})
