import { applyEdit, canEditText, readElementText, type EditDiff, type EditInput } from './popover'
import { formatCssColor, parseCssColor, toHexColor } from './color'
import { buildSelector } from './selector'

export type EditableSnapshot = { text: string; color: string; background: string; opacity: string; fontFamily: string }
export type EditBubbleChange = EditDiff & { description?: string }
export type EditBubbleCopy = {
  cancel: string
  send: string
  queueAndContinue: string
  add: string
  descriptionPlaceholder: string
}
type Deps = {
  onConfirm: (change: EditBubbleChange) => void
  onQueue?: (change: EditBubbleChange) => void
  onCancel: () => void
  mode?: 'single' | 'batch'
  copy?: EditBubbleCopy
  /** Where the pick was clicked, in viewport coordinates. */
  pointer?: BubblePointer
}
type BubblePointer = { x: number; y: number }

const DEFAULT_COPY: EditBubbleCopy = {
  cancel: '取消',
  send: '发送',
  queueAndContinue: '添加并继续',
  add: '添加',
  descriptionPlaceholder: '描述这些更改…',
}

const VIEWPORT_MARGIN = 8
const BUBBLE_GAP = 8
const BUBBLE_WIDTH = 340
const BUBBLE_ESTIMATED_HEIGHT = 380
const BUBBLE_MIN_HEIGHT = 160
const TEXT_AREA_MAX_HEIGHT = 96

const FONT_PRESETS: Array<{ label: string; value: string }> = [
  { label: '系统默认', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' },
  { label: '无衬线', value: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", sans-serif' },
  { label: '衬线', value: 'Georgia, "Times New Roman", "Songti SC", serif' },
  { label: '等宽', value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
]

const STYLE = `
.bubble {
  --bg: #ffffff;
  --fg: #14161a;
  --muted: #6b7280;
  --border: #ebedf1;
  --field-bg: #f7f8fa;
  --field-border: #e2e5ea;
  --accent: #2f7bff;
  --accent-soft: rgba(47, 123, 255, .12);
  --accent-ring: rgba(47, 123, 255, .18);
  --checker: #d6dae1;
  --swatch-border: rgba(0, 0, 0, .2);
  --shadow: 0 16px 40px rgba(15, 18, 25, .18), 0 2px 8px rgba(15, 18, 25, .08);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;

  box-sizing: border-box;
  width: ${BUBBLE_WIDTH}px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  background: var(--bg);
  color: var(--fg);
  box-shadow: var(--shadow);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  font-weight: 400;
  font-style: normal;
  line-height: 1.5;
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  .bubble {
    --bg: #1b1d23;
    --fg: #e9ebef;
    --muted: #9098a4;
    --border: #2b2f37;
    --field-bg: #23262d;
    --field-border: #343a44;
    --checker: #3a3f48;
    --swatch-border: rgba(255, 255, 255, .26);
    --shadow: 0 16px 40px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .35);
  }
}

.head { display: flex; align-items: center; gap: 7px; padding: 12px 14px 0; }
.tag {
  flex: none; padding: 2px 7px; border-radius: 6px;
  background: var(--accent-soft); color: var(--accent);
  font-family: var(--mono); font-size: 11px; font-weight: 600;
}
.selector {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted); font-family: var(--mono); font-size: 11px;
}

.describe {
  box-sizing: border-box; width: 100%; display: block; resize: none; overflow: hidden;
  border: none; outline: none; background: transparent; color: var(--fg);
  font: inherit; font-size: 14px; line-height: 1.45; padding: 8px 14px 10px;
}
.describe::placeholder { color: var(--muted); }

.body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 14px 2px; border-top: 1px solid var(--border); }
.body::-webkit-scrollbar { width: 9px; }
.body::-webkit-scrollbar-thumb {
  background: var(--field-border); border-radius: 5px;
  border: 3px solid transparent; background-clip: content-box;
}

.row { display: flex; align-items: center; gap: 10px; padding: 2px 0; }
.row-text { align-items: flex-start; }
.row-text .row-label { padding-top: 6px; }
.row-label { flex: none; width: 58px; color: var(--muted); font-size: 12px; }
.control { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }

.input {
  flex: 1; min-width: 0; box-sizing: border-box;
  border: 1px solid var(--field-border); border-radius: 9px;
  background: var(--field-bg); color: var(--fg);
  font: inherit; font-size: 12px; padding: 5px 9px; outline: none;
  transition: border-color .12s ease, box-shadow .12s ease, background .12s ease;
}
.input:focus { border-color: var(--accent); background: var(--bg); box-shadow: 0 0 0 3px var(--accent-ring); }

.text-area { resize: none; overflow: hidden; line-height: 1.5; max-height: ${TEXT_AREA_MAX_HEIGHT}px; }
.color-value { font-family: var(--mono); font-size: 11.5px; }

.swatch-slot {
  flex: none; position: relative; width: 26px; height: 26px;
  border: 1px solid var(--swatch-border); border-radius: 8px; overflow: hidden;
}
.swatch-slot[data-transparent="true"] {
  background-image:
    linear-gradient(45deg, var(--checker) 25%, transparent 25%, transparent 75%, var(--checker) 75%),
    linear-gradient(45deg, var(--checker) 25%, transparent 25%, transparent 75%, var(--checker) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
}
.swatch { display: block; width: 100%; height: 100%; padding: 0; border: none; background: none; cursor: pointer; }
.swatch::-webkit-color-swatch-wrapper { padding: 0; }
.swatch::-webkit-color-swatch { border: none; border-radius: 0; }
.swatch-slot[data-transparent="true"] .swatch::-webkit-color-swatch { opacity: 0; }

.slider {
  flex: 1; min-width: 0; height: 4px; border-radius: 999px; outline: none; cursor: pointer;
  -webkit-appearance: none; appearance: none; background: var(--field-border);
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; border: 1px solid rgba(0, 0, 0, .18); box-shadow: 0 1px 3px rgba(0, 0, 0, .25); cursor: grab;
}
.slider:focus-visible { box-shadow: 0 0 0 3px var(--accent-ring); }
.readout { flex: none; width: 36px; text-align: right; color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }

.select-slot { position: relative; flex: 1; min-width: 0; display: flex; }
.select { -webkit-appearance: none; appearance: none; padding-right: 26px; cursor: pointer; }
.select-slot::after {
  content: ""; position: absolute; right: 11px; top: 50%; width: 5px; height: 5px; pointer-events: none;
  border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted);
  transform: translateY(-70%) rotate(45deg);
}

.footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 9px 14px; margin-top: 8px; border-top: 1px solid var(--border);
}
/* 内容被压缩到需要滚动时，给页脚一道投影，提示上方还有没看完的行 */
.bubble[data-scrollable="true"] .footer { box-shadow: 0 -7px 12px -8px rgba(15, 18, 25, .45); }
.btn { border: none; border-radius: 999px; font: inherit; font-size: 12.5px; cursor: pointer; transition: background .12s ease, color .12s ease; }
.btn-ghost { margin-right: auto; padding: 7px 14px; background: transparent; color: var(--muted); }
.btn-ghost:hover { background: var(--field-bg); color: var(--fg); }
.btn-secondary { padding: 7px 14px; border: 1px solid var(--field-border); background: var(--bg); color: var(--fg); }
.btn-secondary:hover { background: var(--field-bg); border-color: var(--muted); }
.btn-primary { padding: 7px 18px; background: var(--accent); color: #fff; font-weight: 500; }
.btn-primary:hover { background: #1f6bf0; }
`

export function snapshotEditableStyles(el: HTMLElement): EditableSnapshot {
  const cs = window.getComputedStyle(el)
  return {
    text: readElementText(el),
    color: cs.color,
    background: cs.backgroundColor,
    opacity: cs.opacity,
    fontFamily: cs.fontFamily,
  }
}

/** 颜色框把 rgb() 显示成 hex，所以比较必须按语义走，否则「选了同一个颜色」会变成一条假变更。 */
function sameColorValue(a: string, b: string): boolean {
  if (a === b) return true
  const left = parseCssColor(a)
  const right = parseCssColor(b)
  if (!left || !right) return false
  return left.r === right.r && left.g === right.g && left.b === right.b && Math.abs(left.a - right.a) < 0.001
}

export function computeChange(original: EditableSnapshot, current: EditableSnapshot): EditDiff {
  const d: EditDiff = {}
  if (current.text !== original.text) d.text = { from: original.text, to: current.text }
  if (!sameColorValue(current.color, original.color)) d.color = { from: original.color, to: current.color }
  if (!sameColorValue(current.background, original.background)) d.background = { from: original.background, to: current.background }
  if (current.opacity !== original.opacity) d.opacity = { from: original.opacity, to: current.opacity }
  if (current.fontFamily !== original.fontFamily) d.fontFamily = { from: original.fontFamily, to: current.fontFamily }
  return d
}

function buildPatch(key: keyof EditableSnapshot, value: string): EditInput {
  const patch: EditInput = {}
  if (key === 'text') patch.text = value
  else if (key === 'color') patch.color = value
  else if (key === 'background') patch.background = value
  else if (key === 'opacity') patch.opacity = value
  else if (key === 'fontFamily') patch.fontFamily = value
  return patch
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function computeBubbleLayout(rect: DOMRect, contentHeight: number, pointer?: BubblePointer) {
  const viewportWidth = Math.max(window.innerWidth || 0, BUBBLE_WIDTH + VIEWPORT_MARGIN * 2)
  const viewportHeight = Math.max(window.innerHeight || 0, BUBBLE_MIN_HEIGHT + VIEWPORT_MARGIN * 2)
  const desiredHeight = Math.min(
    Math.max(Math.ceil(contentHeight) || BUBBLE_ESTIMATED_HEIGHT, BUBBLE_MIN_HEIGHT),
    Math.max(BUBBLE_MIN_HEIGHT, viewportHeight - VIEWPORT_MARGIN * 2),
  )
  const belowTop = rect.bottom + BUBBLE_GAP
  const spaceBelow = viewportHeight - VIEWPORT_MARGIN - belowTop
  const spaceAbove = rect.top - BUBBLE_GAP - VIEWPORT_MARGIN
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - BUBBLE_WIDTH - VIEWPORT_MARGIN)
  let top: number
  let left = rect.left

  if (spaceBelow >= desiredHeight) {
    top = belowTop
  } else if (spaceAbove >= desiredHeight) {
    top = rect.top - BUBBLE_GAP - desiredHeight
  } else {
    // Neither side has room: the target fills the view (a picked <body>, a
    // full-bleed section). The bubble has to cover part of it anyway, so it
    // opens at full height where the pick was clicked rather than squeezing
    // into a sliver at whichever edge had a little more space.
    const anchor = pointer ?? { x: rect.left, y: rect.top }
    top = clamp(anchor.y + BUBBLE_GAP, VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - desiredHeight)
    left = anchor.x + BUBBLE_GAP
  }

  top = Math.max(VIEWPORT_MARGIN, Math.round(top))
  left = clamp(Math.round(left), VIEWPORT_MARGIN, maxLeft)
  const maxHeight = Math.max(BUBBLE_MIN_HEIGHT, viewportHeight - VIEWPORT_MARGIN - top)
  return { top, left, maxHeight }
}

/** Constructable stylesheet 走 CSSOM，不会被页面的 style-src CSP 拦掉；不支持时回落 <style>。 */
function adoptStyles(shadow: ShadowRoot, css: string): void {
  const SheetCtor = (globalThis as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet
  if (SheetCtor && typeof SheetCtor.prototype.replaceSync === 'function') {
    try {
      const sheet = new SheetCtor()
      sheet.replaceSync(css)
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet]
      return
    } catch {
      // 环境不支持构造式样式表，落到 <style>
    }
  }
  const style = document.createElement('style')
  style.textContent = css
  shadow.appendChild(style)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function autoGrow(area: HTMLTextAreaElement, maxHeight: number): void {
  area.style.height = 'auto'
  area.style.height = `${Math.min(area.scrollHeight || 0, maxHeight)}px`
}

function primaryFontLabel(fontFamily: string): string {
  const first = fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? ''
  return first || '当前'
}

function toPercent(opacity: string): number {
  const parsed = Number.parseFloat(opacity)
  if (Number.isNaN(parsed)) return 100
  return Math.min(100, Math.max(0, Math.round(parsed * 100)))
}

function fromPercent(percent: number): string {
  return String(Number((percent / 100).toFixed(2)))
}

function buildRow(label: string): { row: HTMLElement; control: HTMLElement } {
  const row = el('div', 'row')
  const name = el('span', 'row-label')
  name.textContent = label
  const control = el('div', 'control')
  row.appendChild(name)
  row.appendChild(control)
  return { row, control }
}

function buildColorRow(
  label: string,
  field: 'color' | 'background',
  initial: string,
  onCommit: (value: string) => void,
): HTMLElement {
  const { row, control } = buildRow(label)
  const slot = el('span', 'swatch-slot')
  const swatch = el('input', 'swatch')
  swatch.type = 'color'
  swatch.setAttribute('aria-label', label)
  const value = el('input', 'input color-value')
  value.type = 'text'
  value.spellcheck = false
  value.setAttribute('data-field', field)

  const reflect = (raw: string) => {
    const parsed = parseCssColor(raw)
    slot.dataset.transparent = parsed && parsed.a <= 0 ? 'true' : 'false'
    if (parsed) swatch.value = toHexColor(parsed)
  }

  const parsedInitial = parseCssColor(initial)
  value.value = parsedInitial ? formatCssColor(parsedInitial) : initial
  reflect(initial)

  value.addEventListener('input', () => { reflect(value.value); onCommit(value.value) })
  // 取色器只给得出实色，所以选色即视为「不透明」——想要透明仍可在右侧手输 transparent
  swatch.addEventListener('input', () => { value.value = swatch.value; slot.dataset.transparent = 'false'; onCommit(swatch.value) })

  slot.appendChild(swatch)
  control.appendChild(slot)
  control.appendChild(value)
  return row
}

function buildOpacityRow(initial: string, onCommit: (value: string) => void): HTMLElement {
  const { row, control } = buildRow('不透明度')
  const slider = el('input', 'slider')
  slider.type = 'range'
  slider.min = '0'
  slider.max = '100'
  slider.step = '1'
  slider.setAttribute('data-field', 'opacity')
  slider.setAttribute('aria-label', '不透明度')
  const readout = el('span', 'readout')

  // 原生 range 没法给已走过的轨道上色，用渐变背景补出进度反馈
  const paintTrack = (percent: number) => {
    slider.style.setProperty(
      'background',
      `linear-gradient(to right, var(--accent) ${percent}%, var(--field-border) ${percent}%)`,
    )
  }

  const percent = toPercent(initial)
  slider.value = String(percent)
  readout.textContent = `${percent}%`
  paintTrack(percent)

  slider.addEventListener('input', () => {
    const next = Number(slider.value)
    readout.textContent = `${next}%`
    paintTrack(next)
    onCommit(fromPercent(next))
  })

  control.appendChild(slider)
  control.appendChild(readout)
  return row
}

function buildFontRow(initial: string, onCommit: (value: string) => void): HTMLElement {
  const { row, control } = buildRow('字体')
  const slot = el('div', 'select-slot')
  const select = el('select', 'input select')
  select.setAttribute('data-field', 'fontFamily')
  select.setAttribute('aria-label', '字体')

  const currentOption = el('option')
  currentOption.value = initial
  currentOption.textContent = `当前 · ${primaryFontLabel(initial)}`
  select.appendChild(currentOption)
  for (const preset of FONT_PRESETS) {
    const option = el('option')
    option.value = preset.value
    option.textContent = preset.label
    select.appendChild(option)
  }
  select.value = initial

  select.addEventListener('change', () => onCommit(select.value))

  slot.appendChild(select)
  control.appendChild(slot)
  return row
}

export function createEditBubble(target: HTMLElement, deps: Deps): { host: HTMLElement; destroy: () => void; revert: () => void } {
  const original = snapshotEditableStyles(target)
  const current: EditableSnapshot = { ...original }
  const copy = deps.copy ?? DEFAULT_COPY
  let description = ''

  const commit = (key: keyof EditableSnapshot, value: string) => {
    current[key] = value
    applyEdit(target, buildPatch(key, value))
  }

  const host = el('div')
  const rect = target.getBoundingClientRect()
  // 用 CSSOM 而非 style 属性，页面的 style-src CSP 才拦不住浮层定位
  host.style.setProperty('position', 'fixed')
  host.style.setProperty('top', '0')
  host.style.setProperty('left', '0')
  host.style.setProperty('z-index', '2147483647')
  host.style.setProperty('visibility', 'hidden')
  const shadow = host.attachShadow({ mode: 'open' })
  adoptStyles(shadow, STYLE)

  const wrap = el('div', 'bubble')

  const head = el('div', 'head')
  const tag = el('span', 'tag')
  tag.textContent = target.tagName.toLowerCase()
  const selector = el('span', 'selector')
  selector.textContent = buildSelector(target)
  selector.title = selector.textContent
  head.appendChild(tag)
  head.appendChild(selector)

  const describe = el('textarea', 'describe')
  describe.setAttribute('data-field', 'description')
  describe.rows = 1
  describe.placeholder = copy.descriptionPlaceholder
  describe.addEventListener('input', () => {
    description = describe.value
    autoGrow(describe, TEXT_AREA_MAX_HEIGHT)
    refreshScrollHint()
  })

  const body = el('div', 'body')
  const refreshScrollHint = () => {
    if (body.scrollHeight > body.clientHeight) wrap.dataset.scrollable = 'true'
    else delete wrap.dataset.scrollable
  }

  if (canEditText(target)) {
    const { row, control } = buildRow('文本')
    row.classList.add('row-text')
    const area = el('textarea', 'input text-area')
    area.setAttribute('data-field', 'text')
    area.rows = 1
    area.value = original.text
    area.addEventListener('input', () => {
      autoGrow(area, TEXT_AREA_MAX_HEIGHT)
      refreshScrollHint()
      commit('text', area.value)
    })
    control.appendChild(area)
    body.appendChild(row)
  }

  body.appendChild(buildColorRow('文字颜色', 'color', original.color, (value) => commit('color', value)))
  body.appendChild(buildColorRow('背景', 'background', original.background, (value) => commit('background', value)))
  body.appendChild(buildOpacityRow(original.opacity, (value) => commit('opacity', value)))
  body.appendChild(buildFontRow(original.fontFamily, (value) => commit('fontFamily', value)))

  const footer = el('div', 'footer')
  footer.setAttribute('data-region', 'footer')
  const cancelBtn = el('button', 'btn btn-ghost')
  cancelBtn.type = 'button'
  cancelBtn.setAttribute('data-action', 'cancel')
  cancelBtn.textContent = copy.cancel
  const queueBtn = el('button', deps.mode === 'batch' ? 'btn btn-primary' : 'btn btn-secondary')
  queueBtn.type = 'button'
  queueBtn.setAttribute('data-action', 'queue')
  queueBtn.textContent = deps.mode === 'batch' ? copy.add : copy.queueAndContinue
  const confirmBtn = el('button', 'btn btn-primary')
  confirmBtn.type = 'button'
  confirmBtn.setAttribute('data-action', 'confirm')
  confirmBtn.textContent = copy.send

  const cancel = () => { applyEdit(target, original); deps.onCancel() }
  const confirm = () => deps.onConfirm({ ...computeChange(original, current), description: description || undefined })
  const queue = () => deps.onQueue?.({ ...computeChange(original, current), description: description || undefined })
  cancelBtn.addEventListener('click', cancel)
  queueBtn.addEventListener('click', queue)
  confirmBtn.addEventListener('click', confirm)

  // 键盘快捷键就地消化，避免漏给页面自己的监听器造成误触
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      if (deps.mode === 'batch') queue()
      else confirm()
    }
  })

  footer.appendChild(cancelBtn)
  if (deps.onQueue) footer.appendChild(queueBtn)
  if (deps.mode !== 'batch') footer.appendChild(confirmBtn)
  wrap.appendChild(head)
  wrap.appendChild(describe)
  wrap.appendChild(body)
  wrap.appendChild(footer)
  shadow.appendChild(wrap)
  document.documentElement.appendChild(host)

  autoGrow(describe, TEXT_AREA_MAX_HEIGHT)
  const textArea = shadow.querySelector<HTMLTextAreaElement>('.text-area')
  if (textArea) autoGrow(textArea, TEXT_AREA_MAX_HEIGHT)

  const measuredHeight = wrap.getBoundingClientRect().height || wrap.scrollHeight || BUBBLE_ESTIMATED_HEIGHT
  const layout = computeBubbleLayout(rect, measuredHeight, deps.pointer)
  host.style.setProperty('top', `${layout.top}px`)
  host.style.setProperty('left', `${layout.left}px`)
  host.style.setProperty('visibility', 'visible')
  wrap.style.setProperty('max-height', `${layout.maxHeight}px`)
  refreshScrollHint()
  describe.focus({ preventScroll: true })   // 页面不该因为浮层拿焦点而跳位

  return {
    host,
    destroy: () => { host.remove() },
    revert: () => { applyEdit(target, original) },
  }
}
