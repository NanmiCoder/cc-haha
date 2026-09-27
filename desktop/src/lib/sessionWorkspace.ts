import type { SessionListItem, SessionWorkspaceState } from '../types/session'

type SessionWorkspaceFields = Pick<
  SessionListItem,
  'workDirExists' | 'workspaceState' | 'workDir' | 'projectRoot'
>

export function getSessionWorkspaceState(
  session: SessionWorkspaceFields | null | undefined,
): SessionWorkspaceState {
  if (!session) return 'available'
  return session.workspaceState ?? (session.workDirExists ? 'available' : 'missing')
}

export function getSessionBrowsablePath(
  session: SessionWorkspaceFields | null | undefined,
): string | undefined {
  if (!session) return undefined
  const state = getSessionWorkspaceState(session)
  if (state === 'available') return session.workDir ?? session.projectRoot ?? undefined
  if (state === 'worktree_removed') return session.projectRoot ?? undefined
  return undefined
}

const DESKTOP_WORKTREE_MARKER = '/.claude/worktrees/'

type SessionSeedFields = Pick<SessionListItem, 'workDir' | 'projectRoot' | 'workspaceState'>

/**
 * Directory to seed new work (a new session or scheduled task) from an existing
 * session. Sessions that ran inside an isolated worktree keep their workDir
 * pointing at `.claude/worktrees/<slug>` forever, so seeding from workDir would
 * plant the new session inside a stale worktree where the project branch is
 * already checked out elsewhere. Those sessions seed from the project root;
 * every other session keeps its own workDir (including intentional
 * subdirectories of a repo).
 */
export function getSessionSeedWorkDir(
  session: SessionSeedFields | null | undefined,
): string | undefined {
  if (!session) return undefined
  const workDir = session.workDir ?? undefined
  const projectRoot = session.projectRoot ?? undefined
  if (!projectRoot) return workDir
  if (!workDir) return projectRoot
  const isWorktreeSession =
    session.workspaceState === 'worktree_removed' ||
    (workDir !== projectRoot && workDir.includes(DESKTOP_WORKTREE_MARKER))
  return isWorktreeSession ? projectRoot : workDir
}
