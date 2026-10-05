import { describe, expect, it } from 'vitest'
import type { SessionListItem } from '../../types/session'
import { resolveNewTaskWorkDir } from './mobileNewTask'

function session(id: string, createdAt: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: id,
    createdAt,
    modifiedAt: createdAt,
    messageCount: 1,
    projectPath: `/work/${id}`,
    projectRoot: `/work/${id}`,
    workDir: `/work/${id}`,
    workDirExists: true,
    ...overrides,
  }
}

describe('resolveNewTaskWorkDir', () => {
  const sessions = [
    session('older', '2026-10-01T10:00:00.000Z'),
    session('newer', '2026-10-05T10:00:00.000Z'),
  ]

  it('starts in the filtered project', () => {
    expect(resolveNewTaskWorkDir(sessions, '/work/older')).toBe('/work/older')
  })

  it('otherwise starts where the newest task was created', () => {
    expect(resolveNewTaskWorkDir(sessions, null)).toBe('/work/newer')
  })

  it('starts a task last run in a worktree in the repository itself', () => {
    const worktree = session('repo', '2026-10-06T10:00:00.000Z', {
      projectRoot: '/work/repo',
      workDir: '/work/repo/.claude/worktrees/fix',
    })
    expect(resolveNewTaskWorkDir([...sessions, worktree], null)).toBe('/work/repo')
  })

  it('passes over folders that are gone and sessions with no folder', () => {
    const gone = session('gone', '2026-10-06T10:00:00.000Z', { workDirExists: false })
    const unknown = session('unknown', '2026-10-07T10:00:00.000Z', { projectRoot: null, workDir: null, projectPath: '' })
    expect(resolveNewTaskWorkDir([...sessions, gone, unknown], null)).toBe('/work/newer')
    expect(resolveNewTaskWorkDir([unknown], 'unknown')).toBe('')
  })

  it('leaves the choice open when there is nothing to go on', () => {
    expect(resolveNewTaskWorkDir([], null)).toBe('')
  })
})
