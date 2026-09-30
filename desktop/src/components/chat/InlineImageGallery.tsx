import { useMemo, useState } from 'react'
import { ImageGalleryModal } from './ImageGalleryModal'
import { isManagedGeneratedImagePath, localImageFileUrl } from '../../lib/attachmentImages'
import {
  extractAssistantOutputTargets,
  extractMarkdownImageSources,
} from '../../lib/assistantOutputTargets'
import { isAbsoluteLocalPath, previewFsUrl } from '../../lib/handlePreviewLink'
import { getServerBaseUrl } from '../../lib/desktopRuntime'

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i

/**
 * Extracts absolute image file paths from text content.
 * Matches paths like /Users/.../image.png, /tmp/output.jpg, etc.
 */
export function extractImagePaths(text: string): string[] {
  // Match absolute paths ending with image extensions
  // Handles paths that may be wrapped in backticks, quotes, or standalone
  const regex = /(?:^|[\s`"'(])(\/?(?:[A-Za-z]:[\\/]|\/)[^\s`"')<>]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico))/gim
  const paths: string[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const p = match[1]!.trim()
    if (!seen.has(p) && IMAGE_EXTENSIONS.test(p)) {
      seen.add(p)
      paths.push(p)
    }
  }

  return paths
}

function fileName(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function normalizeImageReference(value: string): string {
  const withoutSuffix = value.trim().split('#')[0]!.split('?')[0]!
  let decoded = withoutSuffix
  try {
    decoded = decodeURIComponent(withoutSuffix)
  } catch {
    // Keep malformed escapes comparable without turning them into a URL.
  }
  return decoded.replaceAll('\\', '/').replace(/^\.\//, '')
}

type GalleryImage = {
  src: string
  name: string
}

/**
 * Stand-in shown when a referenced image fails to load (typically a 403 from
 * the file endpoints for paths outside the session-allowed roots — issue
 * #1401). The card previously disappeared silently; keeping a visible card
 * with the file name tells the user *which* reference broke without changing
 * any request boundary: we never widen what may be fetched, we only stop
 * hiding the refusal.
 */
function ImageLoadErrorCard({ name }: { name: string }) {
  return (
    <div className="flex min-h-[96px] flex-col items-center justify-center gap-1 overflow-hidden rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-4 text-center">
      <span className="material-symbols-outlined text-[20px] text-[var(--color-outline)]">broken_image</span>
      <span className="max-w-full truncate text-[10px] font-medium text-[var(--color-text-primary)]" title={name}>
        {name}
      </span>
      <span className="text-[10px] text-[var(--color-outline)]">图片无法显示</span>
    </div>
  )
}

type Props = {
  text: string
  /**
   * When provided, relative workspace image paths (e.g. `outputs/foo/frame.png`)
   * are also rendered inline, served via `/preview-fs/<sessionId>/...`. Absent
   * (ToolResult/ToolCall usage) keeps the legacy absolute-path-only behavior.
   */
  sessionId?: string
  workDir?: string | null
  changedFiles?: string[]
  /** ImageGen outputs already have a dedicated placeholder/result card. */
  suppressManagedGeneratedImages?: boolean
}

export function InlineImageGallery({ text, sessionId, workDir, changedFiles, suppressManagedGeneratedImages = false }: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(() => new Set())

  const markdownImageSources = useMemo(
    () => new Set(extractMarkdownImageSources(text).map(normalizeImageReference)),
    [text],
  )

  // Absolute paths are explicitly written out in the prose (not guessed), and the
  // turn checkpoint can't see files written via Bash or outside its tracking scope
  // — so they keep the legacy behavior and render unconditionally (a load that
  // the server refuses stays visible as an error card, issue #1401). changedFiles
  // only steers the relative-target extraction below, where mentions genuinely
  // need to be reconciled against what the turn actually wrote.
  const imagePaths = useMemo(
    () => extractImagePaths(text).filter(
      (imagePath) => (
        !markdownImageSources.has(normalizeImageReference(imagePath)) &&
        (!suppressManagedGeneratedImages || !isManagedGeneratedImagePath(imagePath))
      ),
    ),
    [markdownImageSources, suppressManagedGeneratedImages, text],
  )

  // An empty changedFiles only means "no TRACKED file changed" (Bash writes are
  // invisible to the checkpoint), so it is treated as "no evidence" and falls
  // back to text-only extraction instead of filtering every mention away.
  const changedFileEvidence = changedFiles !== undefined && changedFiles.length === 0 ? undefined : changedFiles

  const images = useMemo<GalleryImage[]>(() => {
    // 1. Absolute paths (legacy behavior) — served via /api/filesystem/file.
    const absolute: GalleryImage[] = imagePaths.map((p) => ({ src: localImageFileUrl(p), name: fileName(p) }))

    if (!sessionId) {
      return absolute
    }

    // 2. Relative workspace images — only when a sessionId is available so we can
    //    build a /preview-fs URL. Reuses the sandboxed target extractor instead of
    //    a bespoke relative-path regex.
    const base = getServerBaseUrl()
    const relativeTargets = extractAssistantOutputTargets(text, { workDir, changedFiles: changedFileEvidence }).filter(
      (target) => (
        target.kind === 'image' &&
        target.source !== 'markdown-link' &&
        !markdownImageSources.has(normalizeImageReference(target.href)) &&
        !markdownImageSources.has(normalizeImageReference(target.normalizedPath ?? ''))
      ),
    )

    // Dedup: an absolute path inside the workspace can be caught by BOTH sources.
    // Skip a relative target whose basename already appears among the absolute
    // images, and also collapse duplicate relative targets by resolved src.
    const absoluteNames = new Set(absolute.map((img) => img.name))
    const seenSrc = new Set(absolute.map((img) => img.src))
    const relative: GalleryImage[] = []

    for (const target of relativeTargets) {
      const relPath = target.normalizedPath ?? target.href
      const name = fileName(relPath)
      if (absoluteNames.has(name)) {
        continue
      }
      const src = isAbsoluteLocalPath(relPath)
        ? localImageFileUrl(relPath)
        : previewFsUrl(base, sessionId, relPath)
      if (seenSrc.has(src)) {
        continue
      }
      seenSrc.add(src)
      relative.push({ src, name })
    }

    return [...absolute, ...relative]
  }, [changedFileEvidence, imagePaths, markdownImageSources, sessionId, text, workDir])

  if (images.length === 0) return null

  return (
    <>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-outline)]">
          <span className="material-symbols-outlined text-[12px]">image</span>
          {images.length === 1 ? '1 image' : `${images.length} images`}
        </div>
        <div className={`grid gap-2 ${images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {images.map((img, i) => (
            failedSrcs.has(img.src) ? (
              <ImageLoadErrorCard key={img.src} name={img.name} />
            ) : (
              <button
                key={img.src}
                type="button"
                onClick={() => setActiveIndex(i)}
                className="group/image relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-left shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-150 hover:shadow-[var(--shadow-composer)] hover:border-[var(--color-primary-fixed-dim)]"
              >
                <img
                  src={img.src}
                  alt={img.name}
                  loading="lazy"
                  className="w-full object-cover"
                  style={{ maxHeight: images.length === 1 ? 400 : 240 }}
                  onError={() => {
                    // Keep failed references visible (issue #1401): swap the tile
                    // for an error card instead of hiding it silently.
                    setFailedSrcs((prev) => {
                      if (prev.has(img.src)) return prev
                      const next = new Set(prev)
                      next.add(img.src)
                      return next
                    })
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover/image:bg-black/20 group-hover/image:opacity-100">
                  <span className="material-symbols-outlined rounded-full bg-white/90 p-2 text-[20px] text-[var(--color-text-primary)] shadow-lg">
                    fullscreen
                  </span>
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2.5 pb-2 pt-6">
                  <span className="text-[10px] font-medium text-white/90 drop-shadow-sm">
                    {img.name}
                  </span>
                </div>
              </button>
            )
          ))}
        </div>
      </div>

      {activeIndex !== null && activeIndex >= 0 && (
        <ImageGalleryModal
          open={activeIndex !== null}
          images={images}
          activeIndex={activeIndex}
          onClose={() => setActiveIndex(null)}
          onSelect={setActiveIndex}
        />
      )}
    </>
  )
}
