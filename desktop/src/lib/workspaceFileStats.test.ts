import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { sessionsApi } from '../api/sessions'
import {
  createWorkspaceFileLinkVerifier,
  peekWorkspaceFileStats,
  resetWorkspaceFileStatsForTests,
  statWorkspacePaths,
} from './workspaceFileStats'

let statWorkspaceFiles: MockInstance<typeof sessionsApi.statWorkspaceFiles>

beforeEach(() => {
  resetWorkspaceFileStatsForTests()
  statWorkspaceFiles = vi.spyOn(sessionsApi, 'statWorkspaceFiles').mockImplementation(async (_sessionId, paths) => ({
    files: paths.map((path) => path.includes('gone/')
      ? { path, state: 'missing' as const }
      : { path, state: 'file' as const, mtimeMs: 1 }),
  }))
})

afterEach(() => {
  statWorkspaceFiles.mockRestore()
  vi.useRealTimers()
})

describe('statWorkspacePaths', () => {
  it('sends one request for every caller asking in the same tick', async () => {
    // A long history mounts many messages at once; each asks for its own paths.
    const [first, second] = await Promise.all([
      statWorkspacePaths('s1', ['a.ts', 'b.ts']),
      statWorkspacePaths('s1', ['b.ts', 'gone/c.ts']),
    ])

    expect(statWorkspaceFiles).toHaveBeenCalledTimes(1)
    expect(statWorkspaceFiles).toHaveBeenCalledWith('s1', ['a.ts', 'b.ts', 'gone/c.ts'])
    expect(first.get('b.ts')?.state).toBe('file')
    expect(second.get('gone/c.ts')?.state).toBe('missing')
  })

  it('keeps sessions apart and splits a batch to the route limit', async () => {
    const many = Array.from({ length: 45 }, (_, index) => `f${index}.ts`)
    await Promise.all([statWorkspacePaths('s1', many), statWorkspacePaths('s2', ['a.ts'])])

    expect(statWorkspaceFiles.mock.calls.map(([sessionId, paths]) => [sessionId, paths.length]))
      .toEqual([['s1', 20], ['s1', 20], ['s1', 5], ['s2', 1]])
  })

  it('answers from memory until the entry goes stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await statWorkspacePaths('s1', ['a.ts'])
    expect(peekWorkspaceFileStats('s1', ['a.ts'])?.get('a.ts')?.state).toBe('file')
    await statWorkspacePaths('s1', ['a.ts'])
    expect(statWorkspaceFiles).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 11_000)
    expect(peekWorkspaceFileStats('s1', ['a.ts'])).toBeUndefined()
    await statWorkspacePaths('s1', ['a.ts'])
    expect(statWorkspaceFiles).toHaveBeenCalledTimes(2)
  })

  it('peeks nothing while any path is still unanswered', () => {
    void statWorkspacePaths('s1', ['a.ts'])
    expect(peekWorkspaceFileStats('s1', ['a.ts'])).toBeUndefined()
  })

  it('reports a failed request as unknown, not as missing', async () => {
    statWorkspaceFiles.mockRejectedValue(new Error('offline'))
    const stats = await statWorkspacePaths('s1', ['a.ts'])
    expect(stats.get('a.ts')).toBeNull()
  })
})

describe('createWorkspaceFileLinkVerifier', () => {
  it('asks about the file a click would open and reports the written path', async () => {
    const verifier = createWorkspaceFileLinkVerifier('s1', (path) => `/root/${path}`)

    const missing = await verifier.findMissing(['src/a.ts', 'gone/b.md'])

    expect(statWorkspaceFiles).toHaveBeenCalledWith('s1', ['/root/src/a.ts', '/root/gone/b.md'])
    expect([...missing]).toEqual(['gone/b.md'])
    expect([...verifier.peekMissing(['gone/b.md'])!]).toEqual(['gone/b.md'])
  })

  it('never calls a file missing that it could not judge', async () => {
    statWorkspaceFiles.mockImplementation(async (_sessionId, paths) => ({
      files: paths.map((path) => ({ path, state: 'unavailable' as const })),
    }))
    const verifier = createWorkspaceFileLinkVerifier('s1', (path) => path)

    expect([...await verifier.findMissing(['/elsewhere/a.pdf'])]).toEqual([])
    // `~` is the opener's home, which the workspace route cannot see.
    expect([...verifier.peekMissing(['~/notes.md'])!]).toEqual([])
    expect(statWorkspaceFiles).toHaveBeenCalledTimes(1)
  })
})
