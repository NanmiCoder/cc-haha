export const WORKSPACE_SIDE_DEFAULT_WIDTH = 860
export const WORKSPACE_SIDE_MIN_WIDTH = 420

/** Remember layout pixels; the available row, rather than a fixed cap, bounds rendering. */
export function clampWorkspaceSideWidth(width: number): number {
  if (!Number.isFinite(width)) return WORKSPACE_SIDE_DEFAULT_WIDTH
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(WORKSPACE_SIDE_MIN_WIDTH, Math.round(width)))
}

export type WorkspaceSideBounds = { min: number; max: number }

/** Mirrors the split CSS: keep 400px for chat and 1px for the separator. */
export function workspaceSideBounds(rowWidth: number): WorkspaceSideBounds | null {
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) return null
  const max = Math.max(0, Math.min(rowWidth * .7, rowWidth - 401))
  return { min: Math.min(WORKSPACE_SIDE_MIN_WIDTH, rowWidth * .54, max), max }
}

export function constrainWorkspaceSideWidth(width: number, bounds: WorkspaceSideBounds | null): number {
  return bounds ? Math.min(bounds.max, Math.max(bounds.min, width)) : width
}

export function measureWorkspaceSidePanel(panel: HTMLElement | null, fallbackWidth: number) {
  const renderedWidth = panel?.getBoundingClientRect().width ?? 0
  const layoutWidth = panel?.offsetWidth ?? 0
  // Native zoom keeps these measurements in the same space. CSS zoom scales
  // rect/clientX but not offsetWidth or style.width, so convert the drag delta.
  const scale = renderedWidth > 0 && layoutWidth > 0 ? renderedWidth / layoutWidth : 1
  const width = renderedWidth > 0 && Number.isFinite(renderedWidth)
    ? renderedWidth / scale
    : fallbackWidth
  return { width, scale, bounds: workspaceSideBounds(panel?.parentElement?.offsetWidth ?? 0) }
}
