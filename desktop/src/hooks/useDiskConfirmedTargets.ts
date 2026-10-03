import { useEffect, useMemo, useState } from 'react'
import { sessionsApi } from '@/api/sessions'
import type { AssistantOutputTarget } from '@/lib/assistantOutputTargets'

type Listing = { key: string; namesByDir: Map<string, Set<string>> }

const DIR_SEPARATOR = '\u0000'
const LISTING_TTL_MS = 5_000

// A long reply history mounts many messages naming files in the same folder; one
// listing serves them all for a few seconds, then a fresh one sees new files.
const listingCache = new Map<string, { at: number; names: Promise<Set<string> | null> }>()

export function resetDiskListingCacheForTests() {
  listingCache.clear()
}

function listFileNames(sessionId: string, directory: string): Promise<Set<string> | null> {
  const cacheKey = `${sessionId}${DIR_SEPARATOR}${directory}`
  const cached = listingCache.get(cacheKey)
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.names

  const names = sessionsApi.getWorkspaceTree(sessionId, directory)
    .then((tree) => tree.state === 'ok'
      ? new Set(tree.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name.normalize('NFC')))
      : null)
    .catch(() => null)
  listingCache.set(cacheKey, { at: Date.now(), names })
  return names
}

function splitDirectory(path: string): [string, string] {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? ['', path] : [path.slice(0, cut), path.slice(cut + 1)]
}

/**
 * Let the disk settle names the text could not bound.
 *
 * A bare prose mention such as `报告v2.docx` reaches the card as the scan's best
 * reading (`v2.docx`) plus the other readings it may be. One workspace listing of
 * each directory involved tells which of them exists; the longest that does wins,
 * as it is the one the prose spelled out in full. Without an answer — no session,
 * a failed listing, no reading on disk — the card keeps the scan's reading, and a
 * target that {@link AssistantOutputTarget.awaitsConfirmation awaits confirmation}
 * (`开题报告.docx`, which reads like `后缀为.docx的文件`) is not shown at all.
 */
export function useDiskConfirmedTargets(
  sessionId: string | undefined,
  targets: AssistantOutputTarget[],
): AssistantOutputTarget[] {
  const directories = useMemo(() => [...new Set(
    targets
      .filter((target) => target.nameCandidates?.length || target.awaitsConfirmation)
      .map((target) => splitDirectory(target.normalizedPath ?? target.href)[0]),
  )].sort(), [targets])
  const key = sessionId && directories.length > 0 ? `${sessionId}${DIR_SEPARATOR}${directories.join(DIR_SEPARATOR)}` : ''
  const [listing, setListing] = useState<Listing | null>(null)

  useEffect(() => {
    if (!key || !sessionId) return
    let current = true
    void Promise.all(directories.map(async (directory) => {
      const names = await listFileNames(sessionId, directory)
      return names ? [directory, names] as const : null
    })).then((results) => {
      if (!current) return
      setListing({ key, namesByDir: new Map(results.filter((result) => result !== null)) })
    })
    return () => {
      current = false
    }
    // `key` encodes the session and every directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => {
    if (!listing || listing.key !== key) return targets.filter((target) => !target.awaitsConfirmation)
    const seen = new Set<string>()
    return targets.map((target): AssistantOutputTarget | null => {
      if (!target.nameCandidates?.length && !target.awaitsConfirmation) return target
      const [directory, name] = splitDirectory(target.normalizedPath ?? target.href)
      const names = listing.namesByDir.get(directory)
      const confirmed = names && [...(target.nameCandidates ?? []), name]
        .sort((left, right) => right.length - left.length)
        .find((candidate) => names.has(candidate.normalize('NFC')))
      // A name only the disk could vouch for is not shown on a guess.
      if (!confirmed) return target.awaitsConfirmation ? null : target

      const { awaitsConfirmation: _awaitsConfirmation, ...settled } = target
      if (confirmed === name) return settled
      const corrected = directory ? `${directory}/${confirmed}` : confirmed
      return {
        ...settled,
        id: `${target.kind}:${corrected}`,
        title: confirmed,
        href: corrected,
        normalizedPath: corrected,
        subtitle: corrected,
      }
    }).filter((target): target is AssistantOutputTarget => {
      if (!target) return false
      // `v2.docx` and `报告v2.docx` in one reply can settle on the same file.
      if (seen.has(target.id)) return false
      seen.add(target.id)
      return true
    })
  }, [key, listing, targets])
}
