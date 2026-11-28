import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionsApi, type WorkspaceFileStat } from '@/api/sessions'
import { resetWorkspaceFileStatsForTests } from '@/lib/workspaceFileStats'
import { useWorkspacePathAliases } from './useWorkspacePathAliases'

const root = '/projects/429-Hy4-Flash-新模型测试'
const preview = '结尾重录_预览1080p_带口播.mp4'
const authored = `429-Hy4-Flash-新模型测试/${preview}`

beforeEach(resetWorkspaceFileStatsForTests)
afterEach(() => { vi.restoreAllMocks() })

function onDisk(states: Record<string, WorkspaceFileStat['state']>) {
  return vi.spyOn(sessionsApi, 'statWorkspaceFiles').mockImplementation(async (_session, paths) => ({
    files: paths.map((path) => ({ path, state: states[path] ?? 'missing' })),
  }))
}

describe('useWorkspacePathAliases', () => {
  it('opens the workspace-root preview only after confirming the authored path is missing', async () => {
    const stat = onDisk({ [`${root}/${preview}`]: 'file' })
    const { result } = renderHook(() => useWorkspacePathAliases('s1', root, [authored, authored, preview]))
    expect([...result.current.pending]).toEqual([authored])
    expect(result.current.aliases.size).toBe(0)
    await waitFor(() => expect([...result.current.aliases]).toEqual([[authored, preview]]))
    expect(result.current.pending.size).toBe(0)
    expect(stat.mock.calls).toEqual([['s1', [`${root}/${authored}`, `${root}/${preview}`]]])
  })

  it('reuses cached aliases at first paint and only marks new paths pending', async () => {
    const stat = onDisk({ [`${root}/${preview}`]: 'file' })
    const first = renderHook(() => useWorkspacePathAliases('s1', root, [authored]))
    const second = renderHook(() => useWorkspacePathAliases('s1', root, [authored]))
    await waitFor(() => expect(second.result.current.aliases.get(authored)).toBe(preview))
    expect(first.result.current.pending.size).toBe(0)
    first.unmount()
    second.unmount()

    const next = '429-Hy4-Flash-新模型测试/next.mp4'
    const { result, rerender } = renderHook(
      (paths: string[]) => useWorkspacePathAliases('s1', root, paths), { initialProps: [authored] },
    )
    expect(result.current.aliases.get(authored)).toBe(preview)
    expect(result.current.pending.size).toBe(0)
    expect(stat).toHaveBeenCalledTimes(1)
    rerender([authored, next])
    expect(result.current.aliases.get(authored)).toBe(preview)
    expect([...result.current.pending]).toEqual([next])
    await waitFor(() => expect(result.current.pending.size).toBe(0))
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('preserves existing nested files and unavailable paths even when an alternative exists', async () => {
    onDisk({
      '/proj/proj/nested.md': 'file',
      '/proj/nested.md': 'file',
      '/proj/proj/private.md': 'unavailable',
      '/proj/private.md': 'file',
      '/proj/answer.md': 'file',
    })
    const { result } = renderHook(() => useWorkspacePathAliases('s', '/proj', [
      'proj/nested.md', 'proj/private.md', 'proj/gone.md', 'proj/answer.md',
    ]))
    await waitFor(() => expect(Object.fromEntries(result.current.aliases)).toEqual({
      'proj/nested.md': 'proj/nested.md',
      'proj/answer.md': 'answer.md',
    }))
  })

  it('does not probe explicit, unrelated, empty, or unsafe paths', async () => {
    const stat = onDisk({})
    renderHook(() => useWorkspacePathAliases('s', '/proj', [
      '/proj/file.md', './proj/file.md', '~/proj/file.md', 'C:\\proj\\file.md',
      'https://proj/file.md', 'file:///proj/file.md', 'other/file.md', 'file.md', 'proj/',
      'proj//file.md', 'proj/../file.md', 'proj/a/../file.md', 'proj/./file.md',
      'proj/~/file.md', 'proj/C:\\file.md', 'proj/https://example.com/file.md', 'proj/x\u0000y.md',
    ]))
    await act(async () => {})
    expect(stat).not.toHaveBeenCalled()
  })

  it('matches Windows separators, case, and Unicode normalization without decoding percent escapes', async () => {
    const name = 'RÉSUMÉ'.normalize('NFD')
    const path = `${name}\\out\\100%25.txt`
    const stat = onDisk({ 'D:/résumé/out/100%25.txt': 'file' })
    const { result } = renderHook(() => useWorkspacePathAliases('win', 'D:\\résumé\\', [path]))
    await waitFor(() => expect([...result.current.aliases]).toEqual([[path, 'out/100%25.txt']]))
    expect(stat).toHaveBeenCalledWith('win', [`D:/résumé/${name}/out/100%25.txt`, 'D:/résumé/out/100%25.txt'])
  })

  it('drops old aliases immediately when the session, workspace, or paths change', async () => {
    onDisk({
      '/a/proj/one.md': 'file',
      '/b/proj/two.md': 'file',
    })
    const { result, rerender } = renderHook(
      ({ session, dir, path }) => useWorkspacePathAliases(session, dir, [path]),
      { initialProps: { session: 's1', dir: '/a/proj', path: 'proj/one.md' } },
    )
    await waitFor(() => expect(result.current.aliases.get('proj/one.md')).toBe('one.md'))
    rerender({ session: 's1', dir: '/b/proj', path: 'proj/one.md' })
    expect(result.current.aliases.size).toBe(0)
    rerender({ session: 's1', dir: '/b/proj', path: 'proj/two.md' })
    await waitFor(() => expect([...result.current.aliases]).toEqual([['proj/two.md', 'two.md']]))
    rerender({ session: 's2', dir: '/b/proj', path: 'proj/two.md' })
    expect([...result.current.pending]).toEqual(['proj/two.md'])
    expect(result.current.aliases.size).toBe(0)
    await waitFor(() => expect(result.current.aliases.get('proj/two.md')).toBe('two.md'))
  })
})
