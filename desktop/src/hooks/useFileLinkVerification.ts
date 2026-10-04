import { useEffect, useMemo, useState } from 'react'
import type { FileLinkVerifier } from '@/lib/markdownAutolink'

const PATH_SEPARATOR = '\u0000'
const NONE_MISSING: ReadonlySet<string> = new Set()

/**
 * Which of `paths` are missing, or `null` while that is not known yet.
 *
 * Without a verifier, or with nothing to ask about, nothing is missing.
 */
export function useFileLinkVerification(
  verifier: FileLinkVerifier | undefined,
  paths: string[],
): ReadonlySet<string> | null {
  const unique = useMemo(() => [...new Set(paths)].sort(), [paths])
  const key = unique.join(PATH_SEPARATOR)
  const known = useMemo(
    () => verifier && unique.length > 0 ? verifier.peekMissing(unique) : NONE_MISSING,
    [unique, verifier],
  )
  const [fetched, setFetched] = useState<{ verifier: FileLinkVerifier; key: string; missing: ReadonlySet<string> } | null>(null)

  useEffect(() => {
    if (!verifier || known) return
    let current = true
    void verifier.findMissing(unique).then((missing) => {
      if (current) setFetched({ verifier, key, missing })
    })
    return () => {
      current = false
    }
    // `key` stands for `unique`; `known` only short-cuts the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifier, key])

  if (known) return known
  return fetched && fetched.verifier === verifier && fetched.key === key ? fetched.missing : null
}
