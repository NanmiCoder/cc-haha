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
    await waitFor(() => expect(mcpApi.projectSharing).toHaveBeenCalledWith('old', [], undefined))
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
})
