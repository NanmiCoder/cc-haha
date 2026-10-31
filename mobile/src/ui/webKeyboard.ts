/** 可见区域比布局视口矮这么多，才算软键盘弹起（地址栏收放只有几十像素）。 */
const KEYBOARD_MIN_GAP = 80

/**
 * 手机浏览器里软键盘是否弹起。浏览器不发键盘事件，只能看可见区域（visualViewport）
 * 比整页矮了多少；index.html 也按同一个阈值把应用缩到键盘上方。
 */
export function subscribeWebKeyboard(onChange: (visible: boolean) => void): () => void {
  const viewport = typeof window === 'undefined' ? undefined : window.visualViewport
  if (!viewport) return () => {}
  let last: boolean | null = null
  const sync = () => {
    const visible = window.innerHeight - viewport.height > KEYBOARD_MIN_GAP
    if (visible === last) return
    last = visible
    onChange(visible)
  }
  viewport.addEventListener('resize', sync)
  sync()
  return () => viewport.removeEventListener('resize', sync)
}
