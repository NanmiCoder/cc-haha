import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(),
  listForPath: vi.fn(),
  openTarget: vi.fn(),
}))

vi.mock('./desktopHost', () => ({
  getDesktopHost: () => ({ shell: { openPath: mocks.openPath } }),
}))

vi.mock('../api/openTargets', () => ({
  openTargetsApi: {
    listForPath: mocks.listForPath,
    open: mocks.openTarget,
  },
}))

import { openLocalFileWithSystem, resolveAbsoluteOpenPath } from './systemFileOpen'

describe('systemFileOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openPath.mockResolvedValue(undefined)
  })

  it('resolves relative files against the session work directory', () => {
    expect(resolveAbsoluteOpenPath('reports/brief.docx', '/work/project')).toBe('/work/project/reports/brief.docx')
    expect(resolveAbsoluteOpenPath('/tmp/brief.docx', '/work/project')).toBe('/tmp/brief.docx')
  })

  it('uses the guarded Electron shell bridge when available', async () => {
    await openLocalFileWithSystem('/tmp/brief.docx')

    expect(mocks.openPath).toHaveBeenCalledWith('/tmp/brief.docx')
    expect(mocks.listForPath).not.toHaveBeenCalled()
  })

  it('falls back to the validated server system target outside Electron', async () => {
    mocks.openPath.mockRejectedValue(new Error('desktop unavailable'))
    mocks.listForPath.mockResolvedValue({
      targets: [{ id: 'system-default', kind: 'system_default' }],
    })
    mocks.openTarget.mockResolvedValue({ ok: true })

    await openLocalFileWithSystem('/tmp/brief.docx')

    expect(mocks.listForPath).toHaveBeenCalledWith('/tmp/brief.docx')
    expect(mocks.openTarget).toHaveBeenCalledWith('system-default', '/tmp/brief.docx')
  })
})
