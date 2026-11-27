import { useEffect, useId, useRef, useState } from 'react'
import { Volume2 } from 'lucide-react'
import { getAuthToken } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { useTranslation } from '@/i18n'
import { isBrowserH5Runtime } from '@/lib/desktopRuntime'
import { useAuthedImageFallback, type ImageFailure } from '@/lib/useAuthedImageFallback'

export type MarkdownAudioProps = {
  src?: string
  label?: string
  title?: string
}

// Keep A/B auditioning crisp: starting one inline player pauses whichever other
// inline player was active so candidate takes do not overlap.
let activeAudioElement: HTMLAudioElement | null = null

function audioFileName(src: string): string | null {
  if (!src || /^(blob:|data:)/i.test(src)) return null
  try {
    const url = new URL(src, 'http://markdown.invalid')
    const rawPath = url.searchParams.get('path') ?? decodeURIComponent(url.pathname)
    return rawPath.split(/[\\/]/).filter(Boolean).pop() ?? null
  } catch {
    return null
  }
}

/**
 * On authenticated non-Electron browsers (e.g. LAN H5), native `<audio>`
 * requests cannot attach `Authorization: Bearer`, so `preload="metadata"` would
 * immediately fail with 401 on mount and trigger `useAuthedImageFallback` to
 * buffer every full audio file in the message into memory concurrently. Defer
 * loading with `preload="none"` until the user explicitly hits Play.
 */
function shouldDeferAudioPreload(src: string | undefined): boolean {
  if (!src || /^(blob:|data:)/i.test(src)) return false
  return isBrowserH5Runtime() && Boolean(getAuthToken())
}

type AuthedAudioProps = {
  src?: string
  label: string
  retryWithCredential: boolean
  onReady: () => void
  onFailure: (failure: ImageFailure) => void
}

function AuthedAudio({ src, label, retryWithCredential, onReady, onFailure }: AuthedAudioProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const resumeAfterFallbackRef = useRef(false)
  const media = useAuthedImageFallback(src, onFailure, retryWithCredential)
  const deferPreload = shouldDeferAudioPreload(src)
  const usedFallbackBlob = Boolean(media.src && media.src !== src && media.src.startsWith('blob:'))

  useEffect(() => {
    const el = audioRef.current
    return () => {
      if (!el) return
      if (!el.paused || activeAudioElement === el) {
        el.pause()
      }
      if (activeAudioElement === el) {
        activeAudioElement = null
      }
    }
  }, [])

  const handlePlay = () => {
    const el = audioRef.current
    if (!el) return
    if (deferPreload && !usedFallbackBlob) {
      resumeAfterFallbackRef.current = true
    }
    if (activeAudioElement && activeAudioElement !== el) {
      activeAudioElement.pause()
    }
    activeAudioElement = el
  }

  const handlePauseOrEnd = () => {
    if (audioRef.current && activeAudioElement === audioRef.current) {
      activeAudioElement = null
    }
  }

  const handleReady = () => {
    onReady()
    if (usedFallbackBlob && resumeAfterFallbackRef.current) {
      resumeAfterFallbackRef.current = false
      const playResult = audioRef.current?.play()
      if (playResult && typeof playResult.catch === 'function') {
        void playResult.catch(() => undefined)
      }
    }
  }

  return (
    <audio
      ref={audioRef}
      controls
      preload={deferPreload && !usedFallbackBlob ? 'none' : 'metadata'}
      aria-label={label}
      src={media.src}
      onError={media.onError}
      onLoadedMetadata={handleReady}
      onCanPlay={handleReady}
      onPlay={handlePlay}
      onPause={handlePauseOrEnd}
      onEnded={handlePauseOrEnd}
      className="h-9 w-full"
    />
  )
}

export function MarkdownAudioPlayer({ src, label, title }: MarkdownAudioProps) {
  const t = useTranslation()
  const errorId = useId()
  const [state, setState] = useState<{ src: string | undefined; status: 'initial' | 'unavailable' | 'failed' | 'retrying'; attempt: number }>({
    src,
    status: 'initial',
    attempt: 0,
  })
  if (state.src !== src) {
    setState({ src, status: 'initial', attempt: 0 })
  }
  const { status, attempt } = state
  const setStatus = (next: 'initial' | 'unavailable' | 'failed' | 'retrying') => {
    setState((previous) => (previous.status === next ? previous : { ...previous, status: next }))
  }

  const fileName = audioFileName(src ?? '')
  const fallbackLabel = t('openWith.fileType.audio')
  const primaryLabel = label?.trim() || title?.trim() || fileName || fallbackLabel
  const showFileName = Boolean(fileName && fileName !== primaryLabel)
  const retryName = fileName || primaryLabel
  const hidden = status !== 'initial'
  const showError = status === 'failed' || status === 'retrying'
  const unavailableText = label?.trim() || title?.trim() || ''

  return (
    <>
      <span
        data-md-audio-card=""
        hidden={hidden}
        style={{ display: hidden ? 'none' : undefined }}
        onClick={(event) => {
          // Audio players can sit inside Markdown links; interacting with the
          // player belongs to playback only and must not navigate the link.
          event.stopPropagation()
        }}
        className="v6c-glass-card not-prose my-2 flex max-w-md flex-col gap-1.5 rounded-[var(--radius-card-inner)] border border-[var(--color-border)] px-3 py-2.5"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Volume2 size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
          <span className="min-w-0 truncate text-xs font-medium text-[var(--color-text-primary)]" title={primaryLabel}>
            {primaryLabel}
          </span>
          {showFileName && (
            <span className="ml-auto shrink-0 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]" title={fileName!}>
              {fileName}
            </span>
          )}
        </span>
        <AuthedAudio
          key={`${src ?? ''}|${attempt}`}
          src={src}
          label={primaryLabel}
          retryWithCredential={attempt > 0}
          onReady={() => setStatus('initial')}
          onFailure={setStatus}
        />
      </span>
      {status === 'unavailable' && unavailableText && (
        <span className="text-[var(--color-text-tertiary)]">{unavailableText}</span>
      )}
      {showError && (
        <span className="not-prose my-2 flex max-w-full flex-col gap-2">
          <span id={errorId}>
            <ErrorState
              as="span"
              size="sm"
              title={t('chat.audioLoadFailed')}
              detail={<><span className="block break-all">{retryName}</span>{t('chat.audioLoadFailedHint')}</>}
            />
          </span>
          <Button
            variant="secondary"
            size="lg"
            className="min-h-11 self-start"
            aria-label={t('chat.retryAudio', { name: retryName })}
            aria-describedby={errorId}
            loading={status === 'retrying'}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setState((previous) => ({ ...previous, status: 'retrying', attempt: previous.attempt + 1 }))
            }}
          >
            {t(status === 'retrying' ? 'chat.audioRetrying' : 'common.retry')}
          </Button>
        </span>
      )}
    </>
  )
}
