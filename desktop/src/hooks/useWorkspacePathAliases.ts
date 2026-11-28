import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceFileStat } from '@/api/sessions'
import { basenameOf } from '@/lib/workspace/types'
import { peekWorkspaceFileStats, statWorkspacePaths } from '@/lib/workspaceFileStats'

type Aliases = { aliases: ReadonlyMap<string, string>; pending: ReadonlySet<string> }
type Candidate = { path: string; suffix: string; literalStat: string; suffixStat: string }

const EMPTY: Aliases = { aliases: new Map(), pending: new Set() }

function confirmAlias(aliases: Map<string, string>, candidate: Candidate, stats: Map<string, WorkspaceFileStat | null>) {
  const literal = stats.get(candidate.literalStat)?.state
  // Pin a real nested file too, before checkpoint basename matching can move it.
  if (literal === 'file') {
    aliases.set(candidate.path, candidate.path.replaceAll('\\', '/'))
  } else if (literal === 'missing' && stats.get(candidate.suffixStat)?.state === 'file') {
    aliases.set(candidate.path, candidate.suffix)
  }
}

function comparableName(name: string, windows: boolean) {
  const normalized = name.normalize('NFC')
  return windows ? normalized.toLowerCase() : normalized
}

/** A reply may display the workspace folder along with a workspace-relative file. */
export function useWorkspacePathAliases(
  sessionId: string | undefined,
  workDir: string | null | undefined,
  paths: readonly string[],
): Aliases {
  const root = workDir?.replaceAll('\\', '/').replace(/\/+$/, '') ?? ''
  const windows = /^[A-Za-z]:\//.test(root) || root.startsWith('//')
  const workspaceName = comparableName(basenameOf(root), windows)
  // Exclude explicit paths (including ./), and never reinterpret a stripped
  // suffix as a home, drive, scheme, traversal, or absolute path.
  const candidateKey = useMemo(() => {
    if (!sessionId || !workspaceName || !(root.startsWith('/') || windows)) return ''
    return [...new Set(paths)].filter((path) => {
      const [first, ...rest] = path.replaceAll('\\', '/').split('/')
      if (!first || comparableName(first, windows) !== workspaceName || !rest[0]) return false
      const rooted = /^(?:~$|[a-z][a-z\d+.-]*:)/i
      return !rooted.test(first) && !rooted.test(rest[0]) && !path.includes('\u0000')
        && ![first, ...rest].some((part) => part === '' || part === '.' || part === '..')
    }).sort().join('\u0000')
  }, [paths, root, sessionId, windows, workspaceName])
  const request = useMemo(() => {
    if (!candidateKey || !sessionId) return null
    const aliases = new Map<string, string>()
    const pending = new Set<string>()
    const unresolved: Candidate[] = []
    for (const path of candidateKey.split('\u0000')) {
      const literal = path.replaceAll('\\', '/')
      const suffix = literal.slice(literal.indexOf('/') + 1)
      const candidate = { path, suffix, literalStat: `${root}/${literal}`, suffixStat: `${root}/${suffix}` }
      const known = peekWorkspaceFileStats(sessionId, [candidate.literalStat, candidate.suffixStat])
      if (known) {
        confirmAlias(aliases, candidate, known)
      } else {
        unresolved.push(candidate)
        pending.add(path)
      }
    }
    return { sessionId, unresolved, initial: { aliases, pending } }
  }, [candidateKey, root, sessionId])
  const [result, setResult] = useState<{ request: typeof request; value: Aliases }>()
  useEffect(() => {
    if (!request?.unresolved.length) return
    let current = true
    const probes = request.unresolved.flatMap(({ literalStat, suffixStat }) => [literalStat, suffixStat])
    void statWorkspacePaths(request.sessionId, probes).then((stats) => {
      if (!current) return
      const aliases = new Map(request.initial.aliases)
      for (const candidate of request.unresolved) confirmAlias(aliases, candidate, stats)
      setResult({ request, value: { aliases, pending: EMPTY.pending } })
    })
    return () => { current = false }
  }, [request])
  return result?.request === request ? result.value : request?.initial ?? EMPTY
}
