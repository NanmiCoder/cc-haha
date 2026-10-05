import { useEffect, useState } from 'react'
import { AppWindow, Code2, ExternalLink, FolderOpen } from 'lucide-react'
import { apiGetBlob } from '../../api/client'
import type { OpenTarget } from '../../stores/openTargetStore'

export function getFallbackIcon(kind: OpenTarget['kind'], size = 16) {
  if (kind === 'file_manager') {
    return <FolderOpen size={size} strokeWidth={1.75} />
  }
  if (kind === 'application') return <AppWindow size={size} strokeWidth={1.75} />
  if (kind === 'system_default') return <ExternalLink size={size} strokeWidth={1.75} />
  return <Code2 size={size} strokeWidth={1.75} />
}

/**
 * Blob URL per icon path, or `null` for "this bundle has no icon we can render".
 *
 * Cached for the life of the page, and deliberately never revoked: the same
 * applications reappear in every menu, and a revoked URL would blank out any
 * icon still mounted elsewhere. The payloads are a few KB of PNG.
 *
 * The misses are cached too. Without that, every menu render re-requests the
 * bundles that have no icon, and each of those costs a `sips` run on the server.
 */
const iconUrlCache = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

async function loadTargetIconUrl(iconPath: string): Promise<string | null> {
  const cached = iconUrlCache.get(iconPath)
  if (cached !== undefined) return cached

  const pending = inFlight.get(iconPath) ?? (async () => {
    try {
      const blob = await apiGetBlob(iconPath)
      const objectUrl = URL.createObjectURL(blob)
      iconUrlCache.set(iconPath, objectUrl)
      return objectUrl
    } catch {
      // A bundle with no icon, or a target the server no longer knows about.
      // Either way the row renders its fallback glyph; nothing to report.
      iconUrlCache.set(iconPath, null)
      return null
    } finally {
      inFlight.delete(iconPath)
    }
  })()
  inFlight.set(iconPath, pending)
  return pending
}

/** Exposed for tests; the cache would otherwise leak between cases. */
export function resetTargetIconCache(): void {
  iconUrlCache.clear()
  inFlight.clear()
}

export function TargetIcon({ target, size = 18 }: { target: OpenTarget; size?: number }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(
    () => (target.iconUrl ? iconUrlCache.get(target.iconUrl) ?? null : null),
  )
  const iconPath = target.iconUrl

  useEffect(() => {
    if (!iconPath) {
      setObjectUrl(null)
      return
    }
    let active = true
    void loadTargetIconUrl(iconPath).then((url) => {
      if (active) setObjectUrl(url)
    })
    return () => {
      active = false
    }
  }, [iconPath])

  if (objectUrl) {
    return (
      <img
        src={objectUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="block shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
    )
  }

  return getFallbackIcon(target.kind, Math.min(18, Math.max(14, size)))
}
