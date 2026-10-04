import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HTMLAttributes, ImgHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { AuthedImage } from '@/components/chat/AuthedImage'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { useTranslation } from '@/i18n'

type ImageProps = Pick<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'title' | 'width' | 'height' | 'className'>
type Props = HTMLAttributes<HTMLDivElement> & { html: string }

function imageName(src: string, fallback: string): string {
  if (/^(blob:|data:)/i.test(src)) return fallback
  try {
    const url = new URL(src, 'http://markdown.invalid')
    const path = url.searchParams.get('path') ?? decodeURIComponent(url.pathname)
    return path.split(/[\\/]/).filter(Boolean).pop() || fallback
  } catch {
    return fallback
  }
}

function MarkdownImage(props: ImageProps) {
  const t = useTranslation()
  const errorId = useId()
  const [status, setStatus] = useState<'initial' | 'unavailable' | 'failed' | 'retrying'>('initial')
  const [attempt, setAttempt] = useState(0)
  const name = imageName(props.src ?? '', props.alt || t('assistantOutputs.kind.image'))
  const hidden = status !== 'initial'
  const showError = status === 'failed' || status === 'retrying'

  return (
    <>
      <AuthedImage
        {...props}
        key={attempt}
        retryWithCredential={attempt > 0}
        hidden={hidden}
        style={{ display: hidden ? 'none' : undefined }}
        onLoad={() => setStatus('initial')}
        onFailure={setStatus}
      />
      {/* A picture the server will not serve (missing, outside the readable roots)
          is not a fault to retry. Like any image that cannot be shown, it falls
          back to its text alternative. */}
      {status === 'unavailable' && props.alt && (
        <span className="text-[var(--color-text-tertiary)]">{props.alt}</span>
      )}
      {showError && (
        <span className="not-prose my-2 flex max-w-full flex-col gap-2">
          <span id={errorId}>
            <ErrorState
              as="span"
              size="sm"
              title={t('chat.imageLoadFailed')}
              detail={<><span className="block break-all">{name}</span>{t('chat.imageLoadFailedHint')}</>}
            />
          </span>
          <Button
            variant="secondary"
            size="lg"
            className="min-h-11 self-start"
            aria-label={t('chat.retryImage', { name })}
            aria-describedby={errorId}
            loading={status === 'retrying'}
            onClick={(event) => {
              // Images can sit inside links. Retrying belongs to the image only.
              event.preventDefault()
              event.stopPropagation()
              setStatus('retrying')
              setAttempt((previous) => previous + 1)
            }}
          >
            {t(status === 'retrying' ? 'chat.imageRetrying' : 'common.retry')}
          </Button>
        </span>
      )}
    </>
  )
}

/** Mount existing image components in sanitized HTML without reparsing its layout. */
function MarkdownHtmlContent({ html, ...props }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mounts, setMounts] = useState<HTMLElement[]>([])
  const prepared = useMemo(() => {
    const template = document.createElement('template')
    template.innerHTML = html
    const images: ImageProps[] = []
    // Raw HTML cannot claim a portal slot; only images surviving the resolver get one.
    template.content.querySelectorAll('[data-md-image]').forEach((node) => node.removeAttribute('data-md-image'))
    template.content.querySelectorAll('img').forEach((image) => {
      images.push({
        src: image.getAttribute('src') ?? undefined,
        alt: image.getAttribute('alt') ?? '',
        title: image.getAttribute('title') ?? undefined,
        width: image.getAttribute('width') ?? undefined,
        height: image.getAttribute('height') ?? undefined,
        className: image.getAttribute('class') ?? undefined,
      })
      const mount = document.createElement('span')
      mount.setAttribute('data-md-image', '')
      image.replaceWith(mount)
    })
    return { html: template.innerHTML, images }
  }, [html])

  useLayoutEffect(() => {
    setMounts(Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-md-image]') ?? []))
  }, [prepared])

  return (
    <div {...props} ref={containerRef}>
      <div dangerouslySetInnerHTML={{ __html: prepared.html }} />
      {mounts.map((mount, index) => createPortal(<MarkdownImage {...prepared.images[index]} />, mount, String(index)))}
    </div>
  )
}

export function MarkdownHtml(props: Props) {
  if (!/<img\b/i.test(props.html)) {
    const { html, ...rest } = props
    return <div {...rest} dangerouslySetInnerHTML={{ __html: html }} />
  }
  // HTML changes discard the previous image instances, including pending retries.
  return <MarkdownHtmlContent key={props.html} {...props} />
}
