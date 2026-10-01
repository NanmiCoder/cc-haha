import { apiGetBlob, getBaseUrl } from '../api/client'

/**
 * Fetch a local-server image with the app's credential and hand back a `blob:` URL.
 *
 * A bare `<img src>` cannot send `Authorization`, and the server refuses a
 * credential-less cross-site subresource load (it cannot tell the page from a
 * hostile one). The packaged desktop shell works around that by injecting the
 * header for an allowlist of media routes; a plain browser tab — the web UI, a LAN
 * or remote H5 client — has no such hook, so its images go through this fetch.
 *
 * Only URLs on the local server's own origin are fetched: the credential must not
 * follow an arbitrary image URL to another host.
 */
export async function fetchServerImageBlobUrl(src: string): Promise<string> {
  const base = new URL(getBaseUrl())
  const target = new URL(src, base)
  if (target.origin !== base.origin) throw new Error('Not a local-server image URL')
  const blob = await apiGetBlob(`${target.pathname}${target.search}`)
  return URL.createObjectURL(blob)
}

/**
 * The same fallback for images that arrive as sanitized HTML (rendered Markdown),
 * where there is no component to hang `onError` on: one capturing listener on the
 * container retries a failed `<img>` per element, once. Returns the detach function,
 * which also frees the object URLs it handed out.
 */
export function attachAuthedImageFallback(container: HTMLElement): () => void {
  const objectUrls: string[] = []
  let detached = false

  const onError = (event: Event) => {
    const image = event.target
    if (!(image instanceof HTMLImageElement) || image.dataset.authedFallback) return
    const src = image.getAttribute('src')
    if (!src || src.startsWith('blob:') || src.startsWith('data:')) return
    image.dataset.authedFallback = '1'
    void fetchServerImageBlobUrl(src).then((url) => {
      if (detached) {
        URL.revokeObjectURL(url)
        return
      }
      objectUrls.push(url)
      image.src = url
    }).catch(() => {
      // Not a local-server image, or refused: the browser's own broken-image state stands.
    })
  }

  // `error` does not bubble, so the listener has to capture.
  container.addEventListener('error', onError, true)
  return () => {
    detached = true
    container.removeEventListener('error', onError, true)
    for (const url of objectUrls) URL.revokeObjectURL(url)
  }
}
