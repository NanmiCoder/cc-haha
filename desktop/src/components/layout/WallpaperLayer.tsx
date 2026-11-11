import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useTranslation } from '@/i18n'
import {
  applyDynamicWallpaper,
  clearDynamicWallpaper,
  isDynamicWallpaperActive,
  videoWallpaperUrl,
  webWallpaperUrl,
} from '@/lib/dynamicWallpaper'
import { applyWallpaper, clearWallpaper } from '@/lib/wallpaper'
import { useDynamicWallpaperStore } from '@/stores/dynamicWallpaperStore'
import { useWallpaperStore } from '@/stores/wallpaperStore'

const PLAYBACK_MESSAGE = 'cc-wallpaper:state'

function windowIsActive(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Hosts the local video or sandboxed web pack behind the app. The image
 * wallpaper keeps painting through `body::before`; this layer is only mounted
 * for the two dynamic kinds.
 */
export function WallpaperLayer() {
  const t = useTranslation()
  const status = useDynamicWallpaperStore((state) => state.status)
  const imagePreferences = useWallpaperStore((state) => state.preferences)
  const objectUrl = useWallpaperStore((state) => state.objectUrl)
  const [focused, setFocused] = useState(windowIsActive)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const preferences = status.preferences
  const kind = preferences.kind
  const active = isDynamicWallpaperActive(status)
  const video = active && kind === 'video'
  const web = active && kind === 'web'

  useEffect(() => {
    if (kind === 'image') {
      clearDynamicWallpaper()
      applyWallpaper(imagePreferences, objectUrl)
      return
    }
    // Clear the previous kind before painting the new one; both helpers are
    // intentionally conservative about not stomping on each other.
    clearDynamicWallpaper()
    clearWallpaper()
    if (active) applyDynamicWallpaper(preferences)
  }, [kind, active, preferences, imagePreferences, objectUrl])

  useEffect(() => {
    const update = () => setFocused(windowIsActive())
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (focused) void element.play().catch(() => undefined)
    else element.pause()
  }, [focused, video, preferences.revision])

  useEffect(() => {
    if (!web) return
    frameRef.current?.contentWindow?.postMessage(
      { type: PLAYBACK_MESSAGE, playing: focused },
      '*',
    )
  }, [focused, web, preferences.revision])

  if ((!video && !web) || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="wallpaper-media-layer"
      data-testid="wallpaper-media-layer"
      aria-hidden="true"
    >
      {video ? (
        <video
          key={`video-${preferences.revision}`}
          ref={videoRef}
          data-testid="wallpaper-video"
          className="wallpaper-media"
          src={videoWallpaperUrl(preferences.revision)}
          style={{
            objectPosition: `${preferences.focusX}% ${preferences.focusY}%`,
          }}
          muted
          loop
          autoPlay
          playsInline
        />
      ) : null}
      {web ? (
        <iframe
          key={`web-${preferences.revision}`}
          ref={frameRef}
          data-testid="wallpaper-web-pack"
          className="wallpaper-media"
          title={t('settings.wallpaper.title')}
          src={webWallpaperUrl(preferences.revision)}
          sandbox="allow-scripts"
          tabIndex={-1}
          onLoad={() => {
            frameRef.current?.contentWindow?.postMessage(
              { type: PLAYBACK_MESSAGE, playing: focused },
              '*',
            )
          }}
        />
      ) : null}
    </div>,
    document.body,
  )
}