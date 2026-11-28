/** 可见区域比页面布局矮这么多，才算软键盘弹起（地址栏收放只有几十像素）。 */
const KEYBOARD_MIN_GAP = 80
/** index.html 里 #root 的高度。 */
export const VIEWPORT_HEIGHT_VAR = '--cc-viewport-height'

/**
 * 手机浏览器里软键盘是否弹起。浏览器不发键盘事件，只能看可见区域（visualViewport）
 * 比页面布局矮了多少。布局高度取 documentElement.clientHeight，它不随键盘变化；
 * iOS 26 Safari 弹键盘后把整页往上推时 window.innerHeight 会跟着缩成可见高度，
 * 拿它比较就会判成「键盘已收起」。可见高度要按布局像素算（见 visibleHeight）。
 */
export function isWebKeyboardOpen(layoutHeight: number, visibleHeight: number) {
  return layoutHeight - visibleHeight > KEYBOARD_MIN_GAP
}

/**
 * 屏幕上露出多高，按布局像素算。双指放大时 visualViewport.height 会按倍数变小，
 * 但屏幕上露出的范围没变，乘回 scale 才不会把放大当成键盘弹起。
 */
function visibleHeight(viewport: ViewportEvents) {
  return viewport.height * (viewport.scale || 1)
}

type Listener = (open: boolean) => void
type ViewportEvents = {
  height: number
  scale?: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}
type TimerHandle = ReturnType<typeof setTimeout> | number

export type ViewportWindow = {
  visualViewport?: ViewportEvents | null
  document: {
    documentElement: { clientHeight: number; style: { setProperty(name: string, value: string): void } }
    activeElement: Element | null
    getElementById(id: string): Pick<Element, 'contains'> | null
  }
  scrollX: number
  scrollY: number
  scrollTo(x: number, y: number): void
  addEventListener(type: 'scroll' | 'resize' | 'focusout', listener: () => void): void
  removeEventListener(type: 'scroll' | 'resize' | 'focusout', listener: () => void): void
  requestAnimationFrame?(cb: () => void): number
  cancelAnimationFrame?(id: number): void
  setTimeout?(cb: () => void, ms: number): TimerHandle
  clearTimeout?(id: TimerHandle): void
}

/** 焦点在应用自己（index.html 的 #root）里，而不是挂在 body 上的弹层里。 */
function focusedInApp(doc: ViewportWindow['document']) {
  const active = doc.activeElement
  return !!active && !!doc.getElementById('root')?.contains(active)
}

function isEditableElement(el: Element | null) {
  const tag = (el as { tagName?: string } | null)?.tagName
  return typeof tag === 'string' && /^(INPUT|TEXTAREA|SELECT)$/.test(tag)
}

/**
 * 让应用跟着可见区域走：可见高度写进 --cc-viewport-height，软键盘弹起时整个应用
 * 缩到键盘上方。iOS 不缩布局视口，而是把整页往上推来露出输入框——应用已经在
 * 键盘上方了，这一推只会把顶部和输入框推出屏幕，所以拉回 0。键盘动画结束时
 * iOS 还会再推一次，只发 window 的 scroll，visualViewport 不发事件，两边都要听。
 * 第三方输入法（如微信输入法）点收起时，Safari 有时在收起动画结束后不再补发
 * visualViewport.resize，导致 --cc-viewport-height 停在偏小高度、底部留白；
 * focusout 后在下一帧及动画落稳后补同步一次。
 * 弹层（react-native-web 的 Modal）挂在 body 上、按整页高度排，不跟着缩；
 * 它里面的输入框只能靠 iOS 这一推露出来，焦点在那里时不拉回。
 */
export function watchWebViewport(win: ViewportWindow) {
  const viewport = win.visualViewport
  const listeners = new Set<Listener>()
  let open = false
  let rafId: number | null = null
  let settleTimer: TimerHandle | null = null
  const clearScheduled = () => {
    if (rafId !== null) {
      win.cancelAnimationFrame?.(rafId)
      rafId = null
    }
    if (settleTimer !== null) {
      if (win.clearTimeout) win.clearTimeout(settleTimer)
      else clearTimeout(settleTimer as ReturnType<typeof setTimeout>)
      settleTimer = null
    }
  }
  const sync = () => {
    const height = viewport ? visibleHeight(viewport) : 0
    if (!(height > 0)) return
    const doc = win.document
    // 先读布局高度再写变量：反过来每个滚动事件都会强制重新排版一次。
    const next = isWebKeyboardOpen(doc.documentElement.clientHeight, height)
    doc.documentElement.style.setProperty(VIEWPORT_HEIGHT_VAR, `${Math.round(height)}px`)
    const shouldResetScroll =
      (win.scrollX !== 0 || win.scrollY !== 0) &&
      (next ? focusedInApp(doc) : open && !isEditableElement(doc.activeElement))
    if (shouldResetScroll) win.scrollTo(0, 0)
    if (next === open) return
    open = next
    listeners.forEach((listener) => listener(open))
  }
  const onFocusOut = () => {
    clearScheduled()
    const run = () => {
      rafId = null
      if (isEditableElement(win.document.activeElement)) return
      sync()
    }
    if (typeof win.requestAnimationFrame === 'function') {
      rafId = win.requestAnimationFrame(run)
    } else {
      run()
    }
    const schedule = win.setTimeout ?? ((cb: () => void, ms: number): TimerHandle => setTimeout(cb, ms))
    settleTimer = schedule(() => {
      settleTimer = null
      if (isEditableElement(win.document.activeElement)) return
      sync()
      if (!open && (win.scrollX !== 0 || win.scrollY !== 0)) win.scrollTo(0, 0)
    }, 300)
  }
  viewport?.addEventListener('resize', sync)
  viewport?.addEventListener('scroll', sync)
  win.addEventListener('scroll', sync)
  win.addEventListener('resize', sync)
  win.addEventListener('focusout', onFocusOut)
  sync()
  return {
    subscribe(listener: Listener) {
      listeners.add(listener)
      listener(open)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      clearScheduled()
      viewport?.removeEventListener('resize', sync)
      viewport?.removeEventListener('scroll', sync)
      win.removeEventListener('scroll', sync)
      win.removeEventListener('resize', sync)
      win.removeEventListener('focusout', onFocusOut)
      listeners.clear()
    },
  }
}

let page: ReturnType<typeof watchWebViewport> | null = null

/** 网页版启动时装一次（_layout.tsx）；之后的订阅共用同一份。 */
export function installWebViewport() {
  if (!page && typeof window !== 'undefined') page = watchWebViewport(window)
  return page
}

export function subscribeWebKeyboard(onChange: Listener): () => void {
  return installWebViewport()?.subscribe(onChange) ?? (() => {})
}
