import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  listForPath: vi.fn(),
  open: vi.fn(),
}))

vi.mock('../api/openTargets', () => ({
  openTargetsApi: apiMocks,
}))

describe('openTargetStore', () => {
  beforeEach(async () => {
    vi.resetModules()
    apiMocks.list.mockReset()
    apiMocks.listForPath.mockReset()
    apiMocks.open.mockReset()
  })

  it('caches detected targets inside the TTL', async () => {
    const { useOpenTargetStore } = await import('./openTargetStore')
    apiMocks.list.mockResolvedValue({
      platform: 'darwin',
      targets: [{ id: 'finder', kind: 'file_manager', label: 'Finder', icon: 'finder', platform: 'darwin' }],
      primaryTargetId: 'finder',
      cachedAt: 1,
      ttlMs: 60_000,
    })

    await useOpenTargetStore.getState().refreshTargets()
    await useOpenTargetStore.getState().ensureTargets()

    expect(apiMocks.list).toHaveBeenCalledTimes(1)
    expect(useOpenTargetStore.getState().primaryTargetId).toBe('finder')
  })

  it('remembers the last successful target for this runtime', async () => {
    const { useOpenTargetStore } = await import('./openTargetStore')
    apiMocks.list.mockResolvedValue({
      platform: 'darwin',
      targets: [{ id: 'vscode', kind: 'ide', label: 'VS Code', icon: 'vscode', platform: 'darwin' }],
      primaryTargetId: 'vscode',
      cachedAt: 1,
      ttlMs: 60_000,
    })
    apiMocks.open.mockResolvedValue({ ok: true, targetId: 'vscode', path: '/repo' })

    await useOpenTargetStore.getState().refreshTargets()
    await useOpenTargetStore.getState().openTarget('vscode', '/repo')

    expect(useOpenTargetStore.getState().lastSuccessfulTargetId).toBe('vscode')
  })

  it('queries targets for the concrete path without replacing project targets', async () => {
    const { useOpenTargetStore } = await import('./openTargetStore')
    apiMocks.listForPath.mockResolvedValue({
      targets: [{ id: 'application:pages', kind: 'application', label: 'Pages', icon: 'application', platform: 'darwin' }],
    })

    await expect(useOpenTargetStore.getState().getTargetsForPath('/tmp/brief.docx'))
      .resolves.toMatchObject([{ kind: 'application', label: 'Pages' }])
    expect(apiMocks.listForPath).toHaveBeenCalledWith('/tmp/brief.docx')
  })
})
