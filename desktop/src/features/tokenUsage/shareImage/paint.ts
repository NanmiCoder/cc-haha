import type { DrawOp, FontFamily, MeasureText, ShareLayout, TextOp } from './layout'

export const FONT_STACKS: Record<FontFamily, string> = {
  display: "'Geist', 'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
}

export type PaintAssets = {
  avatar: { image: CanvasImageSource; /** >1 crops in, for artwork drawn with its own padding. */ zoom: number } | null
  icon: CanvasImageSource | null
}

type FontSpec = Pick<TextOp, 'size' | 'weight' | 'family' | 'spacing'>

function applyFont(ctx: CanvasRenderingContext2D, op: FontSpec) {
  ctx.font = `${op.weight} ${op.size}px ${FONT_STACKS[op.family]}`
  if ('letterSpacing' in ctx) {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${(op.spacing ?? 0) * op.size}px`
  }
}

export function createTextMeasurer(ctx: CanvasRenderingContext2D): MeasureText {
  return (op) => {
    ctx.save()
    applyFont(ctx, op)
    const width = ctx.measureText(op.text).width
    ctx.restore()
    return width
  }
}

/** Waits for the faces the image uses, so the first draw is not in a fallback font. */
export async function ensureShareFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return
  const wanted: Array<[FontSpec, string]> = [
    [{ size: 100, weight: 500, family: 'display' }, '0123456789.,%$kMBT'],
    [{ size: 20, weight: 500, family: 'body' }, 'Claude'],
    [{ size: 20, weight: 600, family: 'body' }, 'Claude'],
    [{ size: 20, weight: 400, family: 'mono' }, '0123456789'],
  ]
  await Promise.all(wanted.map(([spec, sample]) => (
    document.fonts.load(`${spec.weight} ${spec.size}px ${FONT_STACKS[spec.family]}`, sample).catch(() => [])
  )))
}

/** lucide's `github`, drawn on a 24-unit grid. */
const GITHUB_PATHS = [
  'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4',
  'M9 18c-4.51 2-5-2-7-2',
]

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function sourceSize(image: CanvasImageSource): { width: number; height: number } {
  const candidate = image as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  return {
    width: candidate.naturalWidth ?? candidate.width ?? 0,
    height: candidate.naturalHeight ?? candidate.height ?? 0,
  }
}

function drawCover(ctx: CanvasRenderingContext2D, image: CanvasImageSource, x: number, y: number, size: number, zoom: number) {
  const { width, height } = sourceSize(image)
  if (width <= 0 || height <= 0) return
  const side = Math.min(width, height) / zoom
  ctx.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, x, y, size, size)
}

function drawOp(ctx: CanvasRenderingContext2D, op: DrawOp, assets: PaintAssets) {
  switch (op.kind) {
    case 'rect': {
      ctx.fillStyle = op.fill
      if (op.radius) {
        roundedRectPath(ctx, op.x, op.y, op.w, op.h, op.radius)
        ctx.fill()
      } else {
        ctx.fillRect(op.x, op.y, op.w, op.h)
      }
      return
    }
    case 'circle': {
      ctx.beginPath()
      ctx.arc(op.cx, op.cy, op.r, 0, Math.PI * 2)
      if (op.fill) {
        ctx.fillStyle = op.fill
        ctx.fill()
      }
      if (op.stroke) {
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = op.lineWidth ?? 1
        ctx.stroke()
      }
      return
    }
    case 'line': {
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = op.lineWidth
      ctx.beginPath()
      ctx.moveTo(op.x1, op.y1)
      ctx.lineTo(op.x2, op.y2)
      ctx.stroke()
      return
    }
    case 'text': {
      applyFont(ctx, op)
      ctx.fillStyle = op.fill
      ctx.textAlign = op.align ?? 'left'
      ctx.textBaseline = op.baseline ?? 'alphabetic'
      ctx.fillText(op.text, op.x, op.y)
      return
    }
    case 'image': {
      const source = op.source === 'avatar' ? assets.avatar?.image ?? assets.icon : assets.icon
      if (!source) return
      const zoom = op.source === 'avatar' ? assets.avatar?.zoom ?? 1.28 : 1
      ctx.save()
      if (op.round) {
        ctx.beginPath()
        ctx.arc(op.x + op.size / 2, op.y + op.size / 2, op.size / 2, 0, Math.PI * 2)
        ctx.clip()
      } else if (op.radius) {
        roundedRectPath(ctx, op.x, op.y, op.size, op.size, op.radius)
        ctx.clip()
      }
      drawCover(ctx, source, op.x, op.y, op.size, zoom)
      ctx.restore()
      return
    }
    case 'icon': {
      if (typeof Path2D === 'undefined') return
      const scale = op.size / 24
      ctx.save()
      ctx.translate(op.x, op.y)
      ctx.scale(scale, scale)
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = 1.75
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const d of GITHUB_PATHS) ctx.stroke(new Path2D(d))
      ctx.restore()
    }
  }
}

export function paintShareLayout(ctx: CanvasRenderingContext2D, layout: ShareLayout, assets: PaintAssets) {
  ctx.fillStyle = layout.background
  ctx.fillRect(0, 0, layout.width, layout.height)
  for (const op of layout.ops) drawOp(ctx, op, assets)
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas produced no image'))), 'image/png')
  })
}
