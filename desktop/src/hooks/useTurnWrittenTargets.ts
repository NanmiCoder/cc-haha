import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceFileStat } from '@/api/sessions'
import type { AssistantOutputTarget } from '@/lib/assistantOutputTargets'
import { peekWorkspaceFileStats, statWorkspacePaths } from '@/lib/workspaceFileStats'

const PATH_SEPARATOR = '\u0000'
// File systems round mtimes (FAT to 2 s); a write in the turn's first moment
// must not read as older than the prompt that asked for it.
const MTIME_TOLERANCE_MS = 2_000

type Stats = { key: string; byPath: Map<string, WorkspaceFileStat | null> }

function targetPath(target: AssistantOutputTarget): string {
  return target.normalizedPath ?? target.href
}

/**
 * Keep an output only once the disk shows this turn wrote it.
 *
 * The checkpoint lists what editing tools wrote; a shell command's output is
 * invisible to it, so such a file is named by the reply and marked
 * {@link AssistantOutputTarget.awaitsTurnWrite}. It is an output when it exists
 * and was modified since the turn began (`startedAt`, server clock, compared
 * with server mtimes). Without a start time, existing is all that can be asked.
 * Until the answer arrives, or when it cannot be had, the file is not shown: a
 * card claims the turn produced it, and a guess that turns out wrong opens
 * "file not found".
 */
export function useTurnWrittenTargets(
  sessionId: string | undefined,
  targets: AssistantOutputTarget[],
  startedAt: number | undefined,
): AssistantOutputTarget[] {
  const paths = useMemo(() => [...new Set(
    targets.filter((target) => target.awaitsTurnWrite).map(targetPath),
  )].sort(), [targets])
  const key = sessionId && paths.length > 0 ? `${sessionId}${PATH_SEPARATOR}${paths.join(PATH_SEPARATOR)}` : ''
  const [fetched, setFetched] = useState<Stats | null>(null)
  // A remount answers from what is already known, so the card does not blink.
  const known = useMemo(() => {
    const byPath = key && sessionId ? peekWorkspaceFileStats(sessionId, paths) : undefined
    return byPath ? { key, byPath } : null
  }, [key, paths, sessionId])
  const stats = fetched?.key === key ? fetched : known

  useEffect(() => {
    if (!key || !sessionId || known) return
    let current = true
    void statWorkspacePaths(sessionId, paths).then((byPath) => {
      if (current) setFetched({ key, byPath })
    })
    return () => {
      current = false
    }
    // `key` encodes the session and every path; `known` only short-cuts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => targets.flatMap((target): AssistantOutputTarget[] => {
    if (!target.awaitsTurnWrite) return [target]
    const stat = stats?.byPath.get(targetPath(target))
    if (stat?.state !== 'file') return []
    if (startedAt !== undefined && (stat.mtimeMs === undefined || stat.mtimeMs < startedAt - MTIME_TOLERANCE_MS)) {
      return []
    }
    const { awaitsTurnWrite: _awaitsTurnWrite, ...written } = target
    return [written]
  }), [startedAt, stats, targets])
}
