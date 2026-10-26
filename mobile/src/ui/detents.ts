export type Detent = 'half' | 'full'
export type DetentOutcome = Detent | 'close'

/** 半高占可用高度的比例；全高留出顶部一条缝，让人看得出这是一张底单。 */
export const detentFraction: Record<Detent, number> = { half: 0.62, full: 0.94 }

const DISTANCE = 56
const VELOCITY = 0.9

/**
 * 手势松开后底单停在哪一档。
 * dy 向下为正；vy 是松手时的纵向速度（向下为正，px/ms）。
 * 快速甩动按方向走，慢速拖动超过一段距离才换档；只有一档（allowFull=false）时向上拖没有效果。
 */
export function settleDetent({
  level,
  dy,
  vy,
  allowFull = true,
}: {
  level: Detent
  dy: number
  vy: number
  allowFull?: boolean
}): DetentOutcome {
  const down = dy > DISTANCE || vy > VELOCITY
  const up = dy < -DISTANCE || vy < -VELOCITY
  if (level === 'half') {
    if (down) return 'close'
    if (up && allowFull) return 'full'
    return 'half'
  }
  if (down) return 'half'
  return 'full'
}

/** 把档位换成像素高度，不超过可用高度。 */
export function detentHeight(level: Detent, available: number): number {
  return Math.round(Math.max(0, available) * detentFraction[level])
}

/** 全高时也要留在状态栏下面，否则弹层顶部会被状态栏压住。 */
export const SHEET_TOP_GAP = 8

/**
 * 底单能用的高度：从弹层实际可视高度里去掉状态栏和最小顶部留白。
 * 键盘弹出时 viewportHeight 已经变小，底单会跟着变矮，不会顶出屏幕。
 */
export function sheetAvailable(viewportHeight: number, topInset: number): number {
  return Math.max(0, viewportHeight - Math.max(0, topInset) - SHEET_TOP_GAP)
}
