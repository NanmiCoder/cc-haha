import '@testing-library/jest-dom'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTarget } from '@/api/openTargets'

const fixture = vi.hoisted(() => ({
  targets: [] as OpenTarget[],
  editorTargetId: null as string | null,
  lastSuccessfulTargetId: null as string | null,
  getTargetsForPath: vi.fn<(path: string) => Promise<OpenTarget[]>>(),
  openTarget: vi.fn<(id: string, path: string) => Promise<void>>(),
}))
const reportFailure = vi.hoisted(() => vi.fn())
vi.mock('@/stores/openTargetStore', () => ({
  useOpenTargetStore: Object.assign((selector: (state: typeof fixture) => unknown) => selector(fixture), { getState: () => fixture }),
}))
vi.mock('@/lib/systemFileOpen', () => ({ reportOpenFailure: reportFailure }))

import { fileApplicationTargets, useWorkspaceFileOpenTargets } from './workspaceFileOpenTargets'

const code: OpenTarget = { id: 'code', kind: 'ide', label: 'VS Code', icon: 'code', platform: 'darwin', bundleId: 'test.code' }
const cursor: OpenTarget = { ...code, id: 'cursor', label: 'Cursor', bundleId: 'test.cursor' }
const preview: OpenTarget = { id: 'preview', kind: 'application', label: 'Preview', icon: 'application', platform: 'darwin', isDefault: true }
const system: OpenTarget = { id: 'system-default', kind: 'system_default', label: 'Default app', icon: 'system', platform: 'darwin' }
const finder: OpenTarget = { id: 'finder', kind: 'file_manager', label: 'Finder', icon: 'folder', platform: 'darwin' }

beforeEach(() => {
  vi.clearAllMocks()
  fixture.targets = []
  fixture.editorTargetId = null
  fixture.lastSuccessfulTargetId = null
  fixture.getTargetsForPath.mockResolvedValue([code, cursor, system, finder])
  fixture.openTarget.mockResolvedValue(undefined)
})

describe('workspace file application targets', () => {
  it('shows detected application identities once, retaining the separate system default action', () => {
    expect(fileApplicationTargets('/fixture/file.ts', [code, { ...code, id: 'application:code' }, system, finder]))
      .toEqual([code, system])
  })

  it('preserves the existing binary-document capability gate for code editors', () => {
    expect(fileApplicationTargets('/fixture/report.pdf', [code, preview, system, finder])).toEqual([preview, system])
  })
})

describe('useWorkspaceFileOpenTargets', () => {
  it('shares one discovery for a stable path and opens the selected editor against that exact file', async () => {
    fixture.editorTargetId = 'cursor'
    const { result, rerender } = renderHook(() => useWorkspaceFileOpenTargets('/fixture/src/app.ts'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.primaryTarget).toEqual(cursor)
    rerender()
    expect(fixture.getTargetsForPath).toHaveBeenCalledExactlyOnceWith('/fixture/src/app.ts')
    act(() => result.current.openTarget(cursor))
    expect(fixture.openTarget).toHaveBeenCalledExactlyOnceWith('cursor', '/fixture/src/app.ts')
  })

  it('uses the last successful available application but falls back when it is not available for the file', async () => {
    fixture.editorTargetId = 'cursor'
    fixture.lastSuccessfulTargetId = 'code'
    const { result, rerender } = renderHook(() => useWorkspaceFileOpenTargets('/fixture/src/app.ts'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.primaryTarget).toEqual(code)
    fixture.lastSuccessfulTargetId = 'uninstalled'
    rerender()
    expect(result.current.primaryTarget).toEqual(cursor)
  })

  it('ignores a late discovery from the previously selected file', async () => {
    let resolveOld: (targets: OpenTarget[]) => void = () => {}
    fixture.getTargetsForPath.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    fixture.getTargetsForPath.mockResolvedValueOnce([preview, system])
    const { result, rerender } = renderHook(({ path }) => useWorkspaceFileOpenTargets(path), { initialProps: { path: '/fixture/a.ts' } })
    rerender({ path: '/fixture/photo.png' })
    await waitFor(() => expect(result.current.primaryTarget).toEqual(preview))
    await act(async () => resolveOld([code]))
    expect(result.current.targets).toEqual([preview, system])
    act(() => result.current.openTarget(preview))
    expect(fixture.openTarget).toHaveBeenCalledWith('preview', '/fixture/photo.png')
  })

  it('stops exposing cached global targets after discovery fails and reports the real failure', async () => {
    fixture.targets = [code]
    fixture.getTargetsForPath.mockRejectedValueOnce(new Error('Unavailable file'))
    const { result } = renderHook(() => useWorkspaceFileOpenTargets('/fixture/missing.ts'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.targets).toEqual([])
    expect(result.current.primaryTarget).toBeNull()
    expect(result.current.error).toBe('Unavailable file')
  })

  it.each([null, '', 'src/app.ts'])('waits for an absolute path instead of opening unresolved %s', (path) => {
    fixture.targets = [code]
    const { result } = renderHook(() => useWorkspaceFileOpenTargets(path))
    expect(result.current.primaryTarget).toBeNull()
    expect(result.current.loading).toBe(false)
    act(() => result.current.openTarget(code))
    expect(fixture.getTargetsForPath).not.toHaveBeenCalled()
    expect(fixture.openTarget).not.toHaveBeenCalled()
  })

  it('reports a rejected native open without an unhandled rejection', async () => {
    fixture.openTarget.mockRejectedValueOnce(new Error('Missing application'))
    const { result } = renderHook(() => useWorkspaceFileOpenTargets('/fixture/app.ts'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.openTarget(code))
    await waitFor(() => expect(reportFailure).toHaveBeenCalledExactlyOnceWith('/fixture/app.ts'))
  })
})
