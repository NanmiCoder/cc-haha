import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchServerImageBlobUrl } from './authedImage'

/**
 * Let an `<img>` that a plain request could not load try once more with the app's
 * credential (see {@link fetchServerImageBlobUrl}).
 *
 * Spread `src` and `onError` onto the image. `onFailure` runs only when the
 * authenticated attempt has also failed — a missing or denied file, or a body that
 * is not an image — so callers keep their own failure notice for real failures and
 * never flash it for a request that was merely missing a header.
 */
export function useAuthedImageFallback(src: string | undefined, onFailure?: () => void) {
  const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null)
  const triedSource = useRef<string | undefined>(undefined)
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
    if (!src || triedSource.current === src) {
      onFailureRef.current?.()
      return
    }
    triedSource.current = src
    void fetchServerImageBlobUrl(src).then((url) => {
      if (!alive.current) {
        URL.revokeObjectURL(url)
        return
      }
      objectUrls.current.push(url)
      setResolved({ source: src, url })
    }).catch(() => {
      if (alive.current && triedSource.current === src) onFailureRef.current?.()
    })
  }, [src])

  return { src: resolved && resolved.source === src ? resolved.url : src, onError }
}
