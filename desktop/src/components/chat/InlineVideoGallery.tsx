import { useMemo, useState } from 'react'
import { Film } from 'lucide-react'
import { AssistantOutputTargetCard } from '@/components/chat/AssistantOutputTargetCard'
import { extractAssistantOutputTargets } from '../../lib/assistantOutputTargets'
import { isAbsoluteLocalPath, localFileUrl, previewFsUrl } from '../../lib/handlePreviewLink'
import { getServerBaseUrl } from '../../lib/desktopRuntime'

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v)$/i

function filePathComparisonKey(filePath: string): string {
  const normalized = filePath.trim().replaceAll('\\', '/')
  const isWindowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
  return isWindowsPath ? normalized.toLocaleLowerCase('en-US') : normalized
}

function targetPathComparisonKey(filePath: string, workDir?: string | null): string {
  if (isAbsoluteLocalPath(filePath) || !workDir) return filePathComparisonKey(filePath)
  return filePathComparisonKey(
    `${workDir.replace(/[\\/]+$/, '')}/${filePath.replace(/^[\\/]+/, '')}`,
  )
}

function isMentionedAbsoluteVideo(text: string, filePath: string): boolean {
  if (!isAbsoluteLocalPath(filePath) || !VIDEO_EXTENSIONS.test(filePath)) return false

  const normalizedPath = filePath.replaceAll('\\', '/')
  const normalizedText = text.replaceAll('\\', '/')
  const isWindowsPath = /^[A-Za-z]:\//.test(normalizedPath)
  return isWindowsPath
    ? normalizedText.toLocaleLowerCase('en-US').includes(normalizedPath.toLocaleLowerCase('en-US'))
    : normalizedText.includes(normalizedPath)
}

type GalleryVideo = {
  src: string
  name: string
  href: string
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
  changedFiles?: string[]
}

/**
 * Renders AI-output video paths (mp4/webm/mov/m4v) inline, mirroring
 * {@link InlineImageGallery}. Relative workspace paths use `/preview-fs`; absolute
 * paths confirmed by the turn checkpoint use `/local-file`. Videos are large, so
 * we use a vertical stack, `preload="metadata"`, and never autoplay.
 */
export function InlineVideoGallery({ text, sessionId, workDir, changedFiles }: Props) {
  const videos = useMemo<GalleryVideo[]>(() => {
    if (!sessionId) {
      return []
    }

    // An empty changedFiles only means "no TRACKED file changed" (Bash writes are
    // invisible to the checkpoint), so it is treated as "no evidence" and falls
    // back to text-only extraction instead of filtering every mention away.
    const changedFileEvidence =
      changedFiles !== undefined && changedFiles.length === 0 ? undefined : changedFiles

    const base = getServerBaseUrl()
    const targets = extractAssistantOutputTargets(text, { workDir, changedFiles: changedFileEvidence }).filter(
      (target) => target.kind === 'video',
    )
    const representedPathKeys = new Set(
      targets.map((target) =>
        targetPathComparisonKey(target.normalizedPath ?? target.href, workDir)
      ),
    )
    const seenSrc = new Set<string>()
    const result: GalleryVideo[] = []

    for (const filePath of changedFiles ?? []) {
      if (
        !isMentionedAbsoluteVideo(text, filePath) ||
        representedPathKeys.has(filePathComparisonKey(filePath))
      ) {
        continue
      }

      const src = localFileUrl(base, filePath)
      if (seenSrc.has(src)) continue
      seenSrc.add(src)
      result.push({ src, name: filePath.split(/[\\/]/).pop() ?? '', href: filePath })
    }

    for (const target of targets) {
      const relPath = target.normalizedPath ?? target.href
      const src = isAbsoluteLocalPath(relPath)
        ? localFileUrl(base, relPath)
        : previewFsUrl(base, sessionId, relPath)
      if (seenSrc.has(src)) {
        continue
      }
      seenSrc.add(src)
      result.push({ src, name: relPath.split('/').pop() ?? '', href: relPath })
    }

    return result
  }, [changedFiles, sessionId, text, workDir])

  if (videos.length === 0) return null

  return (
    <div className="mt-3 space-y-2">
      {videos.map((video) => (
        <VideoPreview key={video.src} video={video} sessionId={sessionId!} workDir={workDir ?? undefined} />
      ))}
    </div>
  )
}

function VideoPreview({ video, sessionId, workDir }: { video: GalleryVideo; sessionId: string; workDir?: string }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <AssistantOutputTargetCard
        target={{
          id: `file:${video.href}`,
          kind: 'file',
          title: video.name,
          href: video.href,
          normalizedPath: video.href,
          confidence: 'high',
          source: 'plain-path',
        }}
        sessionId={sessionId}
        workDir={workDir}
      />
    )
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <video
        src={video.src}
        controls
        preload="metadata"
        playsInline
        className="w-full bg-black"
        style={{ maxHeight: 420 }}
        onError={() => setFailed(true)}
      />
      <div className="flex h-[30px] items-center gap-1.5 border-t border-[var(--color-border)] px-3 text-[11px] text-[var(--color-text-tertiary)]">
        <Film size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{video.name}</span>
      </div>
    </div>
  )
}
