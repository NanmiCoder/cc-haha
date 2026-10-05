import { memo, useEffect, useRef } from 'react'

/** Loudness folded into one mark: its peak over this many seconds. */
const SAMPLE_SECONDS = 0.075
/** Centre-to-centre distance between marks, and the width of each. */
const SPACING = 5
const MARK_WIDTH = 2.5
/** Below this a mark stays a dot: the room is quiet. */
const QUIET = 0.06
/** The oldest mark on screen fades to this share of the newest one. */
const OLDEST_ALPHA = 0.5
/** Marks dissolve over this many pixels at the left edge instead of being cut. */
const EDGE_FADE = 28
/** The part of the strip nothing has been recorded into yet. */
const UNRECORDED_ALPHA = 0.26
/** Level smoothing: marks should rise with a syllable and drop between words. */
const ATTACK_SECONDS = 0.025
const RELEASE_SECONDS = 0.09
/** Longest step folded into one frame, so a stalled tab does not lurch on return. */
const MAX_FRAME_SECONDS = 0.1
/** While recognition runs, a highlight crosses the frozen trace this often. */
const SWEEP_MS = 1200
const SWEEP_WIDTH = 34
/** Far more marks than the widest composer shows; older ones have scrolled away. */
const MAX_MARKS = 600

type Props = {
  /** Input loudness in 0..1. Read every frame from a ref, so a new function identity never restarts the loop. */
  getLevel: () => number
  /** Recognition is running: stop listening, keep what was recorded, and sweep across it. */
  frozen: boolean
  height: number
  className?: string
}

type Trace = {
  /** One peak per finished sample window, oldest first. */
  marks: number[]
  /** Peak of the window being filled; drawn as the newest mark. */
  peak: number
  /** Seconds into that window. Also how far the strip has scrolled toward the next mark. */
  windowElapsed: number
  level: number
}

function readColor(canvas: HTMLCanvasElement, token: string): string {
  const style = getComputedStyle(canvas)
  return style.getPropertyValue(token).trim() || style.color
}

/**
 * What the microphone heard so far, as a strip that scrolls right to left:
 * dots while it is quiet, bars while someone speaks, older marks fainter.
 *
 * The one level display in the app: the composer's recording bar and the
 * settings page's transcription test both draw it.
 *
 * Drawn straight onto a canvas from requestAnimationFrame: loudness never
 * touches React state, so the parent does not re-render 60 times a second. The
 * recorded marks live in a ref, so the trace survives the switch from recording
 * to recognition, which only freezes it.
 */
export const VoiceTrail = memo(function VoiceTrail({ getLevel, frozen, height, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const getLevelRef = useRef(getLevel)
  getLevelRef.current = getLevel
  const traceRef = useRef<Trace>({ marks: [], peak: 0, windowElapsed: 0, level: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d') ?? null
    if (!canvas || !context) return

    const trace = traceRef.current
    const reducedMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    let width = 0
    let pixelRatio = 1
    let voiceColor = readColor(canvas, '--color-text-secondary')
    let quietColor = readColor(canvas, '--color-text-tertiary')
    let frame: number | null = null
    let lastTime = 0
    let sweepOrigin: number | null = null

    const drawMark = (x: number, markHeight: number) => {
      const top = height / 2 - markHeight / 2
      const left = x - MARK_WIDTH / 2
      context.beginPath()
      // Safari before 16 has no roundRect; a square end is all that is lost.
      if (typeof context.roundRect === 'function') {
        context.roundRect(left, top, MARK_WIDTH, markHeight, MARK_WIDTH / 2)
        context.fill()
      } else {
        context.fillRect(left, top, MARK_WIDTH, markHeight)
      }
    }

    const paint = (now: number) => {
      if (width <= 0) return
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, width, height)

      const tallest = height - 6
      const count = Math.floor((width - 4) / SPACING) + 2
      const progress = trace.windowElapsed / SAMPLE_SECONDS
      let sweep: number | null = null
      if (frozen && !reducedMotion?.matches) {
        // Starts and ends fully off the strip, so it does not pop in at an edge.
        const reach = SWEEP_WIDTH * 2
        sweepOrigin ??= now
        sweep = (((now - sweepOrigin) % SWEEP_MS) / SWEEP_MS) * (width + 2 * reach) - reach
      }

      for (let index = 0; index < count; index += 1) {
        const x = width - 3 - (index + progress) * SPACING
        if (x < 1) break
        const edge = Math.min(1, x / EDGE_FADE)
        const value = index === 0 ? trace.peak : trace.marks[trace.marks.length - index]
        if (value === undefined) {
          context.globalAlpha = UNRECORDED_ALPHA * edge
          context.fillStyle = quietColor
          drawMark(x, MARK_WIDTH)
          continue
        }
        const voiced = value >= QUIET
        const markHeight = voiced
          ? Math.min(tallest, MARK_WIDTH + (tallest - MARK_WIDTH) * Math.pow(Math.min(1, value * 1.25), 0.8))
          : MARK_WIDTH
        let alpha = (1 - (1 - OLDEST_ALPHA) * (index / count)) * edge
        if (frozen) {
          alpha *= sweep === null ? 0.6 : 0.35 + 0.65 * Math.exp(-(((x - sweep) / SWEEP_WIDTH) ** 2))
        }
        context.globalAlpha = alpha
        context.fillStyle = voiced ? voiceColor : quietColor
        drawMark(x, markHeight)
      }
      context.globalAlpha = 1
    }

    const layout = (nextWidth: number) => {
      width = Math.max(0, Math.round(nextWidth))
      pixelRatio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)
      voiceColor = readColor(canvas, '--color-text-secondary')
      quietColor = readColor(canvas, '--color-text-tertiary')
      paint(performance.now())
    }

    const listen = (elapsed: number) => {
      const target = Math.max(0, Math.min(1, getLevelRef.current()))
      const seconds = target > trace.level ? ATTACK_SECONDS : RELEASE_SECONDS
      trace.level += (target - trace.level) * (1 - Math.exp(-elapsed / seconds))
      trace.peak = Math.max(trace.peak, trace.level)
      trace.windowElapsed += elapsed
      while (trace.windowElapsed >= SAMPLE_SECONDS) {
        trace.marks.push(trace.peak)
        trace.peak = trace.level
        trace.windowElapsed -= SAMPLE_SECONDS
      }
      if (trace.marks.length > MAX_MARKS) trace.marks.splice(0, trace.marks.length - MAX_MARKS)
    }

    const tick = (now: number) => {
      const elapsed = lastTime ? Math.min(MAX_FRAME_SECONDS, (now - lastTime) / 1000) : 0
      lastTime = now
      if (!frozen) listen(elapsed)
      paint(now)
      frame = requestAnimationFrame(tick)
    }
    const start = () => {
      if (frame !== null || document.hidden) return
      lastTime = 0
      frame = requestAnimationFrame(tick)
    }
    const stop = () => {
      if (frame === null) return
      cancelAnimationFrame(frame)
      frame = null
    }
    // A hidden window would spin the loop for nothing; resume when it returns.
    const onVisibilityChange = () => (document.hidden ? stop() : start())

    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1]
        if (entry) layout(entry.contentRect.width)
      })
      : null
    observer?.observe(canvas)
    layout(canvas.clientWidth)

    // A frozen trace with reduced motion is a still picture: the one paint
    // above is all it needs.
    const animate = !frozen || !reducedMotion?.matches
    if (animate) {
      document.addEventListener('visibilitychange', onVisibilityChange)
      start()
    }
    return () => {
      stop()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [frozen, height])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="voice-trail"
      className={className ? `block ${className}` : 'block'}
      style={{ height }}
    />
  )
})
