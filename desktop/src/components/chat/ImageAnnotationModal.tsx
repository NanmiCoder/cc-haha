import { useEffect, useRef, useState } from 'react'
import { Modal } from '../shared/Modal'
import { useOverlayStore } from '../../stores/overlayStore'

type Tool = 'rect' | 'arrow' | 'text'

type Annotation =
  | { tool: 'rect'; x: number; y: number; width: number; height: number }
  | { tool: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { tool: 'text'; x: number; y: number; text: string }

type Props = {
  open: boolean
  image: {
    src: string
    name: string
  } | null
  onClose: () => void
  onSave: (dataUrl: string) => void
}

const STROKE_COLOR = '#ff4d4f'
const TEXT_SIZE = 28

async function imageSourceToDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src
  const response = await fetch(src)
  if (!response.ok) throw new Error(`Failed to load image: HTTP ${response.status}`)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(blob)
  })
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const headLength = 18

  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6))
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6))
  ctx.stroke()
}

function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation) {
  ctx.save()
  ctx.strokeStyle = STROKE_COLOR
  ctx.fillStyle = STROKE_COLOR
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.font = `700 ${TEXT_SIZE}px sans-serif`

  if (annotation.tool === 'rect') {
    ctx.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height)
  } else if (annotation.tool === 'arrow') {
    drawArrow(ctx, annotation.x1, annotation.y1, annotation.x2, annotation.y2)
  } else {
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(255,255,255,0.88)'
    ctx.strokeText(annotation.text, annotation.x, annotation.y)
    ctx.fillStyle = STROKE_COLOR
    ctx.fillText(annotation.text, annotation.x, annotation.y)
  }

  ctx.restore()
}

export function ImageAnnotationModal({ open, image, onClose, onSave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [tool, setTool] = useState<Tool>('rect')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [textValue, setTextValue] = useState('')
  const [textPoint, setTextPoint] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const { push, pop } = useOverlayStore.getState()
    push()
    return () => pop()
  }, [open])

  useEffect(() => {
    setAnnotations([])
    setDraft(null)
    setDragStart(null)
    setTextPoint(null)
    setTextValue('')
  }, [image?.src, open])

  useEffect(() => {
    if (!open || !image) return
    let cancelled = false
    void imageSourceToDataUrl(image.src).then((src) => {
      if (cancelled) return
      const img = new Image()
      img.onload = () => {
        if (cancelled) return
        imageRef.current = img
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        redraw()
      }
      img.src = src
    }).catch((error) => {
      console.warn('[attachments] Failed to load image for annotation', error)
    })
    return () => {
      cancelled = true
    }
  }, [image, open])

  useEffect(() => {
    redraw()
  }, [annotations, draft])

  const redraw = () => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const annotation of annotations) drawAnnotation(ctx, annotation)
    if (draft) drawAnnotation(ctx, draft)
  }

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'text') {
      setTextPoint(getCanvasPoint(event))
      setTextValue('')
      return
    }
    const point = getCanvasPoint(event)
    setDragStart(point)
    setDraft(tool === 'rect'
      ? { tool: 'rect', x: point.x, y: point.y, width: 0, height: 0 }
      : { tool: 'arrow', x1: point.x, y1: point.y, x2: point.x, y2: point.y })
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStart) return
    const point = getCanvasPoint(event)
    setDraft(tool === 'rect'
      ? { tool: 'rect', x: dragStart.x, y: dragStart.y, width: point.x - dragStart.x, height: point.y - dragStart.y }
      : { tool: 'arrow', x1: dragStart.x, y1: dragStart.y, x2: point.x, y2: point.y })
  }

  const commitDraft = (event?: React.PointerEvent<HTMLCanvasElement>) => {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!draft) return
    setAnnotations((current) => [...current, draft])
    setDraft(null)
    setDragStart(null)
  }

  const commitText = () => {
    const text = textValue.trim()
    if (!text || !textPoint) return
    setAnnotations((current) => [...current, { tool: 'text', x: textPoint.x, y: textPoint.y, text }])
    setTextValue('')
    setTextPoint(null)
  }

  const handleSave = () => {
    const pendingText = textValue.trim()
    const pendingAnnotation: Annotation | null = pendingText && textPoint
      ? { tool: 'text', x: textPoint.x, y: textPoint.y, text: pendingText }
      : null
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const annotation of annotations) drawAnnotation(ctx, annotation)
    if (pendingAnnotation) drawAnnotation(ctx, pendingAnnotation)
    onSave(canvas.toDataURL('image/png'))
  }

  if (!image) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="图片标注"
      width={980}
      footer={(
        <>
          <button
            type="button"
            onClick={() => setAnnotations((current) => current.slice(0, -1))}
            disabled={annotations.length === 0}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
          >
            撤销
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg bg-[image:var(--gradient-btn-primary)] px-4 py-2 text-sm font-semibold text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)]"
          >
            保存标注
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {(['rect', 'arrow', 'text'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setTool(candidate)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                tool === candidate
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/12 text-[var(--color-brand)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <span className="material-symbols-outlined text-[17px]">
                {candidate === 'rect' ? 'crop_square' : candidate === 'arrow' ? 'arrow_forward' : 'title'}
              </span>
              <span>{candidate === 'rect' ? '框选' : candidate === 'arrow' ? '箭头' : '文字'}</span>
            </button>
          ))}
        </div>

        <div className="relative flex max-h-[62vh] items-center justify-center overflow-auto rounded-2xl bg-[#111] p-3">
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={commitDraft}
            onPointerCancel={commitDraft}
            className="max-h-[58vh] max-w-full cursor-crosshair object-contain"
          />
        </div>

        {textPoint && (
          <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2">
            <input
              value={textValue}
              onChange={(event) => setTextValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitText()
                if (event.key === 'Escape') setTextPoint(null)
              }}
              autoFocus
              placeholder="输入标注文字"
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            />
            <button
              type="button"
              onClick={commitText}
              className="rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-semibold text-white"
            >
              添加
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
