import { describe, expect, it } from 'vitest'
import { getSessionBrowsablePath, getSessionSeedWorkDir, getSessionWorkspaceState } from './sessionWorkspace'

describe('session workspace state', () => {
  it('keeps legacy missing sessions classified as missing', () => {
    const session = {
      workDir: '/repo/deleted',
      projectRoot: '/repo/deleted',
      workDirExists: false,
    }

    expect(getSessionWorkspaceState(session)).toBe('missing')
    expect(getSessionBrowsablePath(session)).toBeUndefined()
  })

  it('uses the original project as a safe browse target for cleaned worktrees', () => {
    const session = {
      workDir: '/repo/.claude/worktrees/desktop-main-12345678',
      projectRoot: '/repo',
      workDirExists: false,
      workspaceState: 'worktree_removed' as const,
    }

    expect(getSessionWorkspaceState(session)).toBe('worktree_removed')
    expect(getSessionBrowsablePath(session)).toBe('/repo')
  })
})

describe('getSessionSeedWorkDir', () => {
  it('seeds new work from the project root for isolated worktree sessions', () => {
    const session = {
      workDir: '/repo/.claude/worktrees/desktop-main-12345678',
      projectRoot: '/repo',
      workDirExists: true,
    }

    expect(getSessionSeedWorkDir(session)).toBe('/repo')
  })

  it('seeds new work from the project root for removed worktrees', () => {
    const session = {
      workDir: '/repo/.claude/worktrees/desktop-main-12345678',
      projectRoot: '/repo',
      workDirExists: false,
      workspaceState: 'worktree_removed' as const,
    }

    expect(getSessionSeedWorkDir(session)).toBe('/repo')
  })

  it('keeps the session workDir for intentional repo subdirectories', () => {
    const session = {
      workDir: '/repo/packages/app',
      projectRoot: '/repo',
      workDirExists: true,
    }

    expect(getSessionSeedWorkDir(session)).toBe('/repo/packages/app')
  })

  it('keeps the session workDir when no project root is known', () => {
    expect(getSessionSeedWorkDir({
      workDir: '/standalone/dir',
      projectRoot: null,
    })).toBe('/standalone/dir')
  })

  it('falls back to the project root when the session has no workDir', () => {
    expect(getSessionSeedWorkDir({
      workDir: null,
      projectRoot: '/repo',
    })).toBe('/repo')
  })

  it('returns undefined without a session', () => {
    expect(getSessionSeedWorkDir(null)).toBeUndefined()
    expect(getSessionSeedWorkDir(undefined)).toBeUndefined()
  })
})
