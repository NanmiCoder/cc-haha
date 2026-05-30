import { useMemo } from 'react'
import { extractAssistantOutputTargets } from '../../lib/assistantOutputTargets'
import { previewFsUrl } from '../../lib/handlePreviewLink'
import { getServerBaseUrl } from '../../lib/desktopRuntime'

type GalleryVideo = {
  src: string
  name: string
}

type Props = {
  text: string
  /**
   * Required to build a `/preview-fs/<sessionId>/...` URL. When absent (e.g.
   * tool-log usage) nothing renders — relative workspace videos can't be served
   * without a session, and we deliberately keep media out of tool logs.
   */
  sessionId?: string
  workDir?: string | null
}

/**
 * Renders AI-output video paths (mp4/webm/mov/m4v) inline, mirroring
 * {@link InlineImageGallery}. Only relative workspace paths are surfaced (via the
 * sandboxed target extractor + `/preview-fs`); videos are large so we use a
 * vertical stack, `preload="metadata"`, and never autoplay.
 */
export function InlineVideoGallery({ text, sessionId, workDir }: Props) {
  const videos = useMemo<GalleryVideo[]>(() => {
    if (!sessionId) {
      return []
    }

    const base = getServerBaseUrl()
    const targets = extractAssistantOutputTargets(text, { workDir }).filter(
      (target) => target.kind === 'video',
    )

    const seenSrc = new Set<string>()
    const result: GalleryVideo[] = []

    for (const target of targets) {
      const relPath = target.normalizedPath ?? target.href
      const src = previewFsUrl(base, sessionId, relPath)
      if (seenSrc.has(src)) {
        continue
      }
      seenSrc.add(src)
      result.push({ src, name: relPath.split('/').pop() ?? '' })
    }

    return result
  }, [sessionId, text, workDir])

  if (videos.length === 0) return null

  return (
    <div className="mt-3 space-y-2">
      {videos.map((video) => (
        <div
          key={video.src}
          className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] shadow-sm"
        >
          <video
            src={video.src}
            controls
            preload="metadata"
            playsInline
            className="w-full rounded-t-xl bg-black"
            style={{ maxHeight: 420 }}
            onError={(e) => {
              // Hide the whole container when the video can't be loaded.
              (e.target as HTMLVideoElement).closest('div')!.style.display = 'none'
            }}
          />
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
            <span className="material-symbols-outlined text-[12px]">movie</span>
            <span className="truncate">{video.name}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
