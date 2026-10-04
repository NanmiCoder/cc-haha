import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { fetchServerImageBlobUrl } from './authedImage'

/**
 * Why an image did not load.
 *
 * `unavailable`: the local server answered that it will not serve the path — the
 * file is missing, outside what this client may read, or not an image it serves.
 * A path pulled from a reply often names nothing at all (a pattern, a web route,
 * a file cleaned out of /tmp since), so this is no fault and no retry fixes it.
 *
 * `failed`: something that should have worked did not — a server fault, a dropped
 * connection, a refused credential, or bytes that do not decode as an image.
 */
export type ImageFailure = 'unavailable' | 'failed'

// What the file routes answer for a path they will not serve: 404 missing, 403
// outside the allowed roots, 400 not an image or not a file, 413 too large.
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 413])

function classifyFailure(error: unknown): ImageFailure {
  return error instanceof ApiError && UNAVAILABLE_STATUSES.has(error.status) ? 'unavailable' : 'failed'
}

/**
 * Let an `<img>` that a plain request could not load try once more with the app's
 * credential (see {@link fetchServerImageBlobUrl}).
 *
 * Spread `src` and `onError` onto the image. `onFailure` runs only when the
 * authenticated attempt has also failed, and says why (see {@link ImageFailure}),
 * so callers keep their own failure notice for real failures and never flash it
 * for a request that was merely missing a header.
 */
export function useAuthedImageFallback(src: string | undefined, onFailure?: (failure: ImageFailure) => void, retryWithCredential = false) {
  const attempt = useRef({ src, state: 'idle' as 'idle' | 'fetching' | 'resolved' | 'failed' })
  if (attempt.current.src !== src) attempt.current = { src, state: 'idle' }
  const current = attempt.current
  const [resolved, setResolved] = useState<{ attempt: typeof current; url: string } | null>(null)
  const alive = useRef(true)
  const objectUrls = useRef<string[]>([])
  const onFailureRef = useRef(onFailure)
  onFailureRef.current = onFailure

  useEffect(() => {
    alive.current = true
    const owned = objectUrls.current
    return () => {
      alive.current = false
      for (const url of owned) URL.revokeObjectURL(url)
      owned.length = 0
    }
  }, [])

  const onError = useCallback(() => {
    if (attempt.current !== current || current.state === 'fetching' || current.state === 'failed') return
    if (!src || current.state === 'resolved') {
      current.state = 'failed'
      // No source names nothing to show. A copy the server did send that still
      // errors is a file that is there and does not decode.
      onFailureRef.current?.(src ? 'failed' : 'unavailable')
      return
    }
    current.state = 'fetching'
    const request = retryWithCredential ? fetchServerImageBlobUrl(src, true) : fetchServerImageBlobUrl(src)
    void request.then((url) => {
      if (!alive.current || attempt.current !== current) {
        URL.revokeObjectURL(url)
        return
      }
      current.state = 'resolved'
      objectUrls.current.push(url)
      setResolved({ attempt: current, url })
    }).catch((error: unknown) => {
      if (alive.current && attempt.current === current) {
        current.state = 'failed'
        onFailureRef.current?.(classifyFailure(error))
      }
    })
  }, [src, current, retryWithCredential])

  useEffect(() => {
    if (retryWithCredential) onError()
  }, [retryWithCredential, onError])

  return { src: resolved?.attempt === current ? resolved.url : retryWithCredential ? undefined : src, onError }
}
