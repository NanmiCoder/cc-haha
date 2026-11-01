import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { mcpApi } from '@/api/mcp'
import { useMcpProjectSharing } from './useMcpProjectSharing'
import type { McpProjectSharingSnapshot } from '@/types/mcp'

vi.mock('@/api/mcp', () => ({ mcpApi: { projectSharing: vi.fn() } }))
vi.mock('@/api/sessions', () => ({ sessionsApi: { getRecentProjects: vi.fn().mockResolvedValue({ projects: [] }) } }))

describe('useMcpProjectSharing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('selects a canonical target once when the folder picker returns a symlink alias', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValueOnce({ projects: [
      { projectPath: '/private/tmp/project', revision: null, selected: false },
    ] }).mockResolvedValueOnce({ projects: [
      { projectPath: '/private/tmp/project', requestedPath: '/tmp/project', revision: null, selected: false },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await result.current.addProject('/tmp/project') })
    expect(result.current.targets).toEqual([{ projectPath: '/private/tmp/project', selected: true, expectedRevision: null }])
    expect(result.current.projects).toHaveLength(1)
  })

  it('ignores an obsolete preview when the server name changes', async () => {
    let finishOld!: (snapshot: McpProjectSharingSnapshot) => void
    vi.mocked(mcpApi.projectSharing).mockImplementation(async name => name === 'old'
      ? new Promise(resolve => { finishOld = resolve })
      : { projects: [{ projectPath: '/new-project', revision: null, selected: false }] })
    const { result, rerender } = renderHook(({ name }) => useMcpProjectSharing({ enabled: true, name, onSourceConfig: vi.fn() }), { initialProps: { name: 'old' } })
    await waitFor(() => expect(mcpApi.projectSharing).toHaveBeenCalledWith('old', [], undefined, []))
    rerender({ name: 'new' })
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { finishOld({ projects: [{ projectPath: '/old-project', revision: null, selected: true }] }) })
    expect(result.current.projects.map(project => project.projectPath)).toEqual(['/new-project'])
  })

  it('updates the revision after a persisted write whose discovery registration failed', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({ projects: [
      { projectPath: 'C:/Work/Project', revision: null, selected: false },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.toggle('c:\\work\\project'))
    act(() => result.current.applyResults({ results: [{
      projectPath: 'c:/work/project', selected: true, success: false, persisted: true, revision: 'written-revision', error: 'Saved, discovery failed',
    }] }))
    expect(result.current.targets).toEqual([{ projectPath: 'C:/Work/Project', selected: true, expectedRevision: 'written-revision' }])
    expect(result.current.projects[0]?.saveError).toBe('Saved, discovery failed')
  })

  it('never adopts an externally replaced failed removal as the original source', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValueOnce({ projects: [
      { projectPath: '/a', revision: 'a1', selected: true, configHash: 'original' },
      { projectPath: '/b', revision: 'b1', selected: true, configHash: 'original' },
    ] }).mockResolvedValueOnce({ projects: [
      { projectPath: '/a', revision: 'a2', selected: false, configHash: null },
      { projectPath: '/b', revision: 'b2', selected: false, conflict: true, configHash: 'external-replacement' },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', sourceCwd: '/a', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => { result.current.toggle('/a'); result.current.toggle('/b') })
    act(() => result.current.applyResults({ results: [
      { projectPath: '/a', selected: false, success: true, revision: 'a2', configHash: null },
      { projectPath: '/b', selected: false, success: false, error: 'Changed' },
    ] }))
    await act(async () => { await result.current.reload() })
    expect(mcpApi.projectSharing).toHaveBeenLastCalledWith('shared', ['/a', '/b'], '/a', ['original'])
    expect(result.current.projects.find(project => project.projectPath === '/b')).toMatchObject({ checked: false, conflict: true })
    expect(result.current.targets).toEqual([])
    expect(result.current.canSave).toBe(false)
  })

  it('retains both original and successfully edited membership when refreshing a partial update', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValueOnce({ projects: [
      { projectPath: '/a', revision: 'a1', selected: true, configHash: 'original' },
      { projectPath: '/b', revision: 'b1', selected: true, configHash: 'original' },
    ] }).mockResolvedValueOnce({ projects: [
      { projectPath: '/a', revision: 'a2', selected: true, configHash: 'edited' },
      { projectPath: '/b', revision: 'b2', selected: true, configHash: 'original' },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', sourceCwd: '/a', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.applyResults({ results: [
      { projectPath: '/a', selected: true, success: true, revision: 'a2', configHash: 'edited' },
      { projectPath: '/b', selected: true, success: false, error: 'Sibling changed' },
    ] }))
    await act(async () => { await result.current.reload() })
    expect(mcpApi.projectSharing).toHaveBeenLastCalledWith('shared', ['/a', '/b'], '/a', ['original', 'edited'])
    expect(result.current.targets).toEqual([
      { projectPath: '/a', selected: true, expectedRevision: 'a2' },
      { projectPath: '/b', selected: true, expectedRevision: 'b2' },
    ])
  })

  it('keeps the raw copy snapshot and failed selection after the original source was removed', async () => {
    const raw = { type: 'http', url: 'http://127.0.0.1/fixture', futureField: { keep: true }, oauth: { xaa: true } }
    vi.mocked(mcpApi.projectSharing).mockResolvedValueOnce({ sourceConfig: raw, projects: [
      { projectPath: '/a', revision: 'a1', selected: true, configHash: 'original' },
      { projectPath: '/b', revision: null, selected: false },
    ] }).mockResolvedValueOnce({ projects: [
      { projectPath: '/a', revision: 'a2', selected: false, configHash: null },
      { projectPath: '/b', revision: 'b2', selected: false },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', sourceCwd: '/a', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => { result.current.toggle('/a'); result.current.toggle('/b') })
    act(() => result.current.applyResults({ results: [
      { projectPath: '/a', selected: false, success: true, revision: 'a2', configHash: null },
      { projectPath: '/b', selected: true, success: false, error: 'Target unavailable' },
    ] }))
    await act(async () => { await result.current.reload() })
    expect(result.current.sourceConfig).toEqual(raw)
    expect(result.current.targets).toEqual([{ projectPath: '/b', selected: true, expectedRevision: 'b2' }])
  })

  it('changes only the chosen POSIX target when another path differs by a literal backslash', async () => {
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({ projects: [
      { projectPath: '/projects/a\\b', revision: null, selected: false },
      { projectPath: '/projects/a/b', revision: null, selected: false },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.toggle('/projects/a\\b'))
    expect(result.current.targets).toEqual([{ projectPath: '/projects/a\\b', selected: true, expectedRevision: null }])
  })

  it('surfaces the directory identity error when the picker selects an existing unavailable target', async () => {
    const error = 'Project directory identity could not be verified'
    vi.mocked(mcpApi.projectSharing).mockResolvedValue({ projects: [
      { projectPath: '/projects/a\\b', revision: null, selected: false, error },
      { projectPath: '/projects/a/b', revision: null, selected: false },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await result.current.addProject('/projects/a\\b') })
    expect(result.current.error).toBe(error)
    expect(result.current.targets).toEqual([])
    expect(result.current.projects.every(project => !project.checked)).toBe(true)
    expect(mcpApi.projectSharing).toHaveBeenCalledTimes(1)
  })

  it('keeps a rejected picker path visible without selecting the distinct nested target', async () => {
    const error = 'Project directory identity could not be verified'
    vi.mocked(mcpApi.projectSharing).mockResolvedValueOnce({ projects: [
      { projectPath: '/projects/a/b', revision: null, selected: false },
    ] }).mockResolvedValueOnce({ projects: [
      { projectPath: '/projects/a\\b', revision: null, selected: false, error },
      { projectPath: '/projects/a/b', revision: null, selected: false },
    ] })
    const { result } = renderHook(() => useMcpProjectSharing({ enabled: true, name: 'shared', onSourceConfig: vi.fn() }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await result.current.addProject('/projects/a\\b') })
    expect(result.current.error).toBe(error)
    expect(result.current.projects.find(project => project.projectPath === '/projects/a\\b')).toMatchObject({ checked: false, error })
    expect(result.current.projects.find(project => project.projectPath === '/projects/a/b')?.checked).toBe(false)
    expect(result.current.targets).toEqual([])
    expect(result.current.canSave).toBe(false)
  })
})
