/**
 * The share image as a list of draw operations.
 *
 * Layout is separate from painting so it can be tested without a canvas: this
 * module turns the usage data, a resolved theme and the user's toggles into
 * rectangles, text and images with exact coordinates; `paint.ts` replays them.
 * Text width is the one thing layout cannot know, so a `measure` function is
 * injected (the painter hands in `ctx.measureText`).
 */

export type ShareSize = 'portrait' | 'square' | 'wide'

export const SHARE_SIZES: Record<ShareSize, { width: number; height: number }> = {
  portrait: { width: 1080, height: 1350 },
  square: { width: 1080, height: 1080 },
  wide: { width: 1200, height: 630 },
}

/** Colors resolved from the active theme's `--cc-*` / `--color-series-*` tokens. */
export type ShareTheme = {
  bg: string
  bd: string
  bd2: string
  t1: string
  t2: string
  t3: string
  ac: string
  /** `--color-series-1..5`, in order. */
  series: string[]
}

export type ShareModelRow = {
  label: string
  /** 1-based index into `ShareTheme.series`. */
  series: number
  amount: string
  share: string
  /** Set only when the user opted into showing cost; null for unpriced models. */
  cost: string | null
}

export type ShareImageData = {
  displayName: string
  /** The profile's second line, shown as the repo / link at the foot. */
  linkText: string
  dateLabel: string
  caption: string
  totalValue: string
  totalUnit: string
  /** e.g. "24.1B · 24,100,000,000" */
  totalNote: string
  /** e.g. "73 active days · 489 sessions" */
  summaryLine: string
  models: ShareModelRow[]
  /** Daily tokens per model (same order as `models`), oldest first. */
  daily: number[][]
  chartMax: number
  gridLines: Array<{ value: number; label: string }>
  peak: { index: number; label: string } | null
  monthTicks: Array<{ fraction: number; label: string }>
  streak: { current: number; longest: number; currentLabel: string; longestLabel: string } | null
  footerNote: string
}

export type ShareOptions = {
  size: ShareSize
  showIdentity: boolean
  showModels: boolean
  showLink: boolean
  showCost: boolean
}

export type FontFamily = 'display' | 'body' | 'mono'

export type TextOp = {
  kind: 'text'
  x: number
  y: number
  text: string
  size: number
  weight: 400 | 500 | 600
  family: FontFamily
  fill: string
  align?: 'left' | 'right' | 'center'
  baseline?: 'alphabetic' | 'middle'
  /** Letter spacing in em. */
  spacing?: number
}

export type RectOp = { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string; radius?: number }
export type CircleOp = { kind: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; lineWidth?: number }
export type LineOp = { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; lineWidth: number }
export type ImageOp = { kind: 'image'; source: 'avatar' | 'icon'; x: number; y: number; size: number; round: boolean; radius?: number }
export type IconOp = { kind: 'icon'; name: 'github'; x: number; y: number; size: number; stroke: string }

export type DrawOp = TextOp | RectOp | CircleOp | LineOp | ImageOp | IconOp

export type ShareLayout = { width: number; height: number; background: string; ops: DrawOp[] }

export type MeasureText = (op: Pick<TextOp, 'text' | 'size' | 'weight' | 'family' | 'spacing'>) => number

/** Everything that differs between the two stacked sizes. */
type StackSpec = {
  pad: number
  headerGap: number
  avatar: number
  nameSize: number
  numeralSize: number
  unitSize: number
  chartHeight: number
  chartWidth: number
  rowHeight: number
  tickHeight: number
  /** Space between the identity block and the figure, and between the figure and the chart. */
  figureGap: number
  chartGap: number
}

const STACK_SPECS: Record<'portrait' | 'square', StackSpec> = {
  portrait: { pad: 76, headerGap: 52, avatar: 120, nameSize: 36, numeralSize: 312, unitSize: 100, chartHeight: 380, chartWidth: 500, rowHeight: 76, tickHeight: 34, figureGap: 48, chartGap: 60 },
  square: { pad: 72, headerGap: 40, avatar: 104, nameSize: 32, numeralSize: 248, unitSize: 80, chartHeight: 236, chartWidth: 460, rowHeight: 47, tickHeight: 26, figureGap: 28, chartGap: 44 },
}

const MAX_TICKS = 62

/**
 * Shortens `text` with an ellipsis until it fits `maxWidth`. The profile's name
 * and link are free text (up to 80 and 160 characters), and a card that gets
 * posted should clip them on purpose rather than run off the edge.
 */
function fit(
  measure: MeasureText,
  text: string,
  spec: Pick<TextOp, 'size' | 'weight' | 'family' | 'spacing'>,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return ''
  if (measure({ ...spec, text }) <= maxWidth) return text
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure({ ...spec, text: `${chars.slice(0, mid).join('')}…` }) <= maxWidth) low = mid
    else high = mid - 1
  }
  return low > 0 ? `${chars.slice(0, low).join('').trimEnd()}…` : '…'
}

function streakTickCount(streak: NonNullable<ShareImageData['streak']>) {
  return Math.min(Math.max(streak.longest, streak.current, 1), MAX_TICKS)
}

function header(ops: DrawOp[], theme: ShareTheme, data: ShareImageData, x: number, right: number, y: number) {
  ops.push({ kind: 'image', source: 'icon', x, y, size: 34, round: false, radius: 8 })
  ops.push({ kind: 'text', x: x + 46, y: y + 17, text: 'cc-haha', size: 24, weight: 600, family: 'body', fill: theme.t1, baseline: 'middle', spacing: -0.01 })
  ops.push({ kind: 'text', x: right, y: y + 17, text: data.dateLabel, size: 20, weight: 400, family: 'mono', fill: theme.t3, align: 'right', baseline: 'middle' })
}

function identity(
  ops: DrawOp[],
  theme: ShareTheme,
  data: ShareImageData,
  x: number,
  y: number,
  avatar: number,
  nameSize: number,
  maxTextRight: number,
  measure: MeasureText,
) {
  const r = avatar / 2
  const cx = x + r
  const cy = y + r
  ops.push({ kind: 'circle', cx, cy, r: r + 7.5, stroke: theme.bd2, lineWidth: 1 })
  ops.push({ kind: 'image', source: 'avatar', x, y, size: avatar, round: true })
  const textX = x + avatar + 26
  const room = maxTextRight - textX
  const nameSpec = { size: nameSize, weight: 600 as const, family: 'body' as const, spacing: -0.02 }
  const summarySpec = { size: 20, weight: 400 as const, family: 'mono' as const }
  ops.push({ kind: 'text', x: textX, y: cy - 8, text: fit(measure, data.displayName, nameSpec, room), fill: theme.t1, baseline: 'middle', ...nameSpec })
  ops.push({ kind: 'text', x: textX, y: cy + nameSize * 0.55 + 8, text: fit(measure, data.summaryLine, summarySpec, room), fill: theme.t3, baseline: 'middle', ...summarySpec })
}

function numeral(
  ops: DrawOp[],
  theme: ShareTheme,
  data: ShareImageData,
  measure: MeasureText,
  x: number,
  baseline: number,
  numeralSize: number,
  unitSize: number,
) {
  const numeralOp = { text: data.totalValue, size: numeralSize, weight: 500 as const, family: 'display' as const, spacing: -0.065 }
  ops.push({ kind: 'text', x: x - numeralSize * 0.04, y: baseline, fill: theme.t1, ...numeralOp })
  if (data.totalUnit) {
    const width = measure(numeralOp)
    ops.push({
      kind: 'text',
      x: x - numeralSize * 0.04 + width + unitSize * 0.16,
      y: baseline,
      text: data.totalUnit,
      size: unitSize,
      weight: 500,
      family: data.totalUnit.length <= 2 && /^[kMBT]$/.test(data.totalUnit) ? 'display' : 'body',
      fill: theme.ac,
    })
  }
}

function chart(
  ops: DrawOp[],
  theme: ShareTheme,
  data: ShareImageData,
  options: ShareOptions,
  x: number,
  top: number,
  width: number,
  height: number,
  labelSize: number,
) {
  const days = data.daily.length
  const slot = width / Math.max(days, 1)
  const yFor = (value: number) => top + height - (value / data.chartMax) * height

  for (const line of data.gridLines) {
    const y = yFor(line.value)
    ops.push({ kind: 'line', x1: x, y1: y, x2: x + width, y2: y, stroke: theme.bd, lineWidth: 1 })
    ops.push({ kind: 'text', x, y: y - 6, text: line.label, size: labelSize, weight: 400, family: 'mono', fill: theme.t3 })
  }

  data.daily.forEach((byModel, index) => {
    let accumulated = 0
    byModel.forEach((tokens, modelIndex) => {
      if (tokens <= 0) return
      const barHeight = (tokens / data.chartMax) * height
      const series = data.models[modelIndex]?.series ?? 1
      const fill = options.showModels ? theme.series[(series - 1) % theme.series.length]! : theme.series[0]!
      if (barHeight >= 0.4) {
        ops.push({ kind: 'rect', x: x + index * slot + 0.6, y: yFor(accumulated + tokens), w: slot - 1.2, h: barHeight, fill })
      }
      accumulated += tokens
    })
  })

  ops.push({ kind: 'line', x1: x, y1: top + height, x2: x + width, y2: top + height, stroke: theme.t3, lineWidth: 1 })

  if (data.peak) {
    const total = (data.daily[data.peak.index] ?? []).reduce((sum, tokens) => sum + tokens, 0)
    ops.push({
      kind: 'text',
      x: x + data.peak.index * slot - 10,
      y: yFor(total) + 8,
      text: data.peak.label,
      size: labelSize + 4,
      weight: 500,
      family: 'display',
      fill: theme.t1,
      align: 'right',
    })
  }

  for (const tick of data.monthTicks) {
    ops.push({ kind: 'text', x: x + tick.fraction * width, y: top + height + 24, text: tick.label, size: labelSize + 1, weight: 400, family: 'mono', fill: theme.t3, align: 'center' })
  }
}

function ledger(
  ops: DrawOp[],
  theme: ShareTheme,
  data: ShareImageData,
  options: ShareOptions,
  x: number,
  top: number,
  width: number,
  rowHeight: number,
  nameSize: number,
  amountSize: number,
  measure: MeasureText,
) {
  data.models.forEach((model, index) => {
    const y = top + index * rowHeight
    const mid = y + rowHeight / 2
    const color = theme.series[(model.series - 1) % theme.series.length]!
    ops.push({ kind: 'line', x1: x, y1: y, x2: x + width, y2: y, stroke: theme.bd, lineWidth: 1 })
    ops.push({ kind: 'circle', cx: x + 7, cy: mid, r: 7, fill: color })
    const hasCost = options.showCost && model.cost !== null
    const amountSpec = { size: amountSize, weight: 500 as const, family: 'display' as const, spacing: -0.02 }
    // The name stops short of the amount, which is right-aligned 74px in from the share column.
    const nameRoom = width - 74 - measure({ ...amountSpec, text: model.amount }) - 26 - 14
    const nameSpec = { size: nameSize, weight: 500 as const, family: 'body' as const }
    ops.push({ kind: 'text', x: x + 26, y: hasCost ? mid - 8 : mid, text: fit(measure, model.label, nameSpec, nameRoom), fill: theme.t1, baseline: 'middle', ...nameSpec })
    if (hasCost) {
      ops.push({ kind: 'text', x: x + 26, y: mid + 14, text: model.cost!, size: Math.max(nameSize - 4, 12), weight: 400, family: 'mono', fill: theme.t3, baseline: 'middle' })
    }
    ops.push({ kind: 'text', x: x + width - 74, y: mid, text: model.amount, size: amountSize, weight: 500, family: 'display', fill: theme.t1, align: 'right', baseline: 'middle', spacing: -0.02 })
    ops.push({ kind: 'text', x: x + width, y: mid, text: model.share, size: Math.max(nameSize - 2, 12), weight: 400, family: 'mono', fill: theme.t3, align: 'right', baseline: 'middle' })
  })
}

function streak(
  ops: DrawOp[],
  theme: ShareTheme,
  data: ShareImageData,
  x: number,
  top: number,
  width: number,
  tickHeight: number,
  labelSize: number,
) {
  if (!data.streak) return
  const count = streakTickCount(data.streak)
  const gap = 4
  const tickWidth = (width - gap * (count - 1)) / count
  ops.push({ kind: 'text', x, y: top, text: data.streak.currentLabel, size: labelSize, weight: 400, family: 'mono', fill: theme.ac, baseline: 'middle' })
  ops.push({ kind: 'text', x: x + width, y: top, text: data.streak.longestLabel, size: labelSize, weight: 400, family: 'mono', fill: theme.t3, align: 'right', baseline: 'middle' })
  for (let index = 0; index < count; index += 1) {
    ops.push({
      kind: 'rect',
      x: x + index * (tickWidth + gap),
      y: top + labelSize + 4,
      w: tickWidth,
      h: tickHeight,
      fill: index < data.streak.current ? theme.ac : theme.bd2,
    })
  }
}

function footer(
  ops: DrawOp[],
  theme: ShareTheme,
  data: ShareImageData,
  options: ShareOptions,
  x: number,
  right: number,
  baseline: number,
  size: number,
  measure: MeasureText,
) {
  if (options.showLink && data.linkText) {
    const spec = { size, weight: 400 as const, family: 'mono' as const }
    const noteWidth = data.footerNote ? measure({ ...spec, text: data.footerNote }) + 28 : 0
    ops.push({ kind: 'icon', name: 'github', x, y: baseline - size + 2, size, stroke: theme.t3 })
    ops.push({ kind: 'text', x: x + size + 10, y: baseline, text: fit(measure, data.linkText, spec, right - noteWidth - (x + size + 10)), fill: theme.t3, ...spec })
  }
  ops.push({ kind: 'text', x: right, y: baseline, text: data.footerNote, size, weight: 400, family: 'mono', fill: theme.t3, align: 'right' })
}

function stackedLayout(
  data: ShareImageData,
  theme: ShareTheme,
  options: ShareOptions,
  measure: MeasureText,
  size: 'portrait' | 'square',
): ShareLayout {
  const { width, height } = SHARE_SIZES[size]
  const spec = STACK_SPECS[size]
  const ops: DrawOp[] = []
  const left = spec.pad
  const right = width - spec.pad
  const inner = right - left
  let y = 64

  header(ops, theme, data, left, right, y)
  y += 34

  if (options.showIdentity) {
    y += spec.headerGap
    identity(ops, theme, data, left, y, spec.avatar, spec.nameSize, right, measure)
    y += spec.avatar
  }

  y += options.showIdentity ? spec.figureGap : spec.headerGap
  if (!options.showIdentity) {
    ops.push({ kind: 'text', x: left, y: y + 12, text: data.caption, size: 22, weight: 400, family: 'mono', fill: theme.t3, baseline: 'middle' })
    y += 28
  }
  const baseline = y + spec.numeralSize * 0.8
  numeral(ops, theme, data, measure, left, baseline, spec.numeralSize, spec.unitSize)
  y = baseline + 40
  ops.push({ kind: 'text', x: left, y, text: data.totalNote, size: 22, weight: 400, family: 'mono', fill: theme.t3 })
  y += spec.chartGap

  const gap = 32
  const rowHeight = Math.min(spec.rowHeight, spec.chartHeight / Math.max(data.models.length, 1))
  const nameSize = size === 'portrait' ? 18 : 16
  const amountSize = size === 'portrait' ? 28 : 24
  // A window with no usage has nothing to chart; the model list then takes the chart's place at full width.
  if (data.peak) {
    const chartWidth = options.showModels ? spec.chartWidth : inner
    chart(ops, theme, data, options, left, y, chartWidth, spec.chartHeight, 15)
    if (options.showModels) {
      ledger(ops, theme, data, options, left + chartWidth + gap, y + 2, inner - chartWidth - gap, rowHeight, nameSize, amountSize, measure)
    }
    y += spec.chartHeight + 28 + 34
  } else if (options.showModels) {
    ledger(ops, theme, data, options, left, y + 2, inner, rowHeight, nameSize, amountSize, measure)
    y += rowHeight * data.models.length + 34
  }

  if (data.streak) {
    streak(ops, theme, data, left, y + 9, inner, spec.tickHeight, 18)
  }

  footer(ops, theme, data, options, left, right, height - 52, 20, measure)
  return { width, height, background: theme.bg, ops }
}

function wideLayout(data: ShareImageData, theme: ShareTheme, options: ShareOptions, measure: MeasureText): ShareLayout {
  const { width, height } = SHARE_SIZES.wide
  const ops: DrawOp[] = []
  const pad = 48
  const colGap = 56
  const leftWidth = 520
  const rightX = pad + leftWidth + colGap
  const right = width - pad

  header(ops, theme, data, pad, pad + leftWidth, 40)

  if (options.showIdentity) {
    identity(ops, theme, data, pad, 108, 88, 28, pad + leftWidth, measure)
  } else {
    ops.push({ kind: 'text', x: pad, y: 130, text: data.caption, size: 20, weight: 400, family: 'mono', fill: theme.t3, baseline: 'middle' })
  }
  numeral(ops, theme, data, measure, pad, 440, 224, 72)
  ops.push({ kind: 'text', x: pad, y: 488, text: data.totalNote, size: 18, weight: 400, family: 'mono', fill: theme.t3 })

  if (options.showModels) {
    ledger(ops, theme, data, options, rightX, 96, right - rightX, 56, 18, 24, measure)
  }
  if (data.streak) {
    streak(ops, theme, data, rightX, options.showModels ? 440 : 120, right - rightX, 26, 16)
  }

  footer(ops, theme, data, options, pad, right, height - 36, 18, measure)
  return { width, height, background: theme.bg, ops }
}

export function buildShareLayout(
  data: ShareImageData,
  theme: ShareTheme,
  options: ShareOptions,
  measure: MeasureText,
): ShareLayout {
  return options.size === 'wide'
    ? wideLayout(data, theme, options, measure)
    : stackedLayout(data, theme, options, measure, options.size)
}
