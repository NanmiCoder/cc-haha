import html2canvas from 'html2canvas'
import { compressDataUrl } from '../lib/imageCompress'

export type CaptureKind = 'full' | 'viewport' | 'element'

export async function captureToDataUrl(kind: CaptureKind, element?: Element): Promise<string> {
  const target = (kind === 'element' && element ? element : document.body) as HTMLElement
  const canvas = await html2canvas(target, {
    ...(kind === 'viewport'
      ? { windowWidth: window.innerWidth, height: window.innerHeight }
      : {}),
    useCORS: true,
    logging: false,
  })
  return compressDataUrl(canvas.toDataURL('image/png'))
}

function setImportant(style: CSSStyleDeclaration, property: string, value: string): void {
  style.setProperty(property, value, 'important')
}

const BADGE_SIZE = 26
const BADGE_GAP = 4
const VIEWPORT_MARGIN = 4

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function computeBadgePosition(rect: DOMRect): { left: number; top: number } {
  const preferredLeft = rect.left + rect.width / 2 - BADGE_SIZE / 2
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - BADGE_SIZE - VIEWPORT_MARGIN)
  const left = clamp(preferredLeft, VIEWPORT_MARGIN, maxLeft)

  const topAbove = rect.top - BADGE_SIZE - BADGE_GAP
  const topBelow = rect.bottom + BADGE_GAP
  if (topAbove >= VIEWPORT_MARGIN) return { left, top: topAbove }
  if (topBelow + BADGE_SIZE <= window.innerHeight - VIEWPORT_MARGIN) return { left, top: topBelow }
  return { left, top: clamp(topAbove, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - BADGE_SIZE - VIEWPORT_MARGIN)) }
}

export function createAnnotationOverlay(el: Element, label: number | string): HTMLElement {
  const rect = el.getBoundingClientRect()
  const root = document.createElement('div')
  root.dataset.previewSelectionAnnotationRoot = 'true'
  root.setAttribute('aria-hidden', 'true')
  setImportant(root.style, 'position', 'fixed')
  setImportant(root.style, 'inset', '0')
  setImportant(root.style, 'overflow', 'visible')
  setImportant(root.style, 'pointer-events', 'none')
  setImportant(root.style, 'z-index', '2147483647')

  const overlay = document.createElement('div')
  overlay.dataset.previewSelectionAnnotation = 'true'
  setImportant(overlay.style, 'position', 'fixed')
  setImportant(overlay.style, 'left', `${rect.left}px`)
  setImportant(overlay.style, 'top', `${rect.top}px`)
  setImportant(overlay.style, 'width', `${rect.width}px`)
  setImportant(overlay.style, 'height', `${rect.height}px`)
  setImportant(overlay.style, 'box-sizing', 'border-box')
  setImportant(overlay.style, 'border', '3px solid #2f7bff')
  setImportant(overlay.style, 'border-radius', '8px')
  setImportant(overlay.style, 'background', 'rgba(47, 123, 255, 0.16)')
  setImportant(overlay.style, 'box-shadow', '0 0 0 2px rgba(255, 255, 255, 0.9)')
  setImportant(overlay.style, 'pointer-events', 'none')

  const badge = document.createElement('div')
  badge.dataset.previewSelectionBadge = 'true'
  badge.textContent = String(label)
  const badgePos = computeBadgePosition(rect)
  setImportant(badge.style, 'position', 'fixed')
  setImportant(badge.style, 'left', `${badgePos.left}px`)
  setImportant(badge.style, 'top', `${badgePos.top}px`)
  setImportant(badge.style, 'display', 'flex')
  setImportant(badge.style, 'align-items', 'center')
  setImportant(badge.style, 'justify-content', 'center')
  setImportant(badge.style, 'width', `${BADGE_SIZE}px`)
  setImportant(badge.style, 'height', `${BADGE_SIZE}px`)
  setImportant(badge.style, 'border-radius', '999px')
  setImportant(badge.style, 'background', '#2f7bff')
  setImportant(badge.style, 'border', '2px solid #ffffff')
  setImportant(badge.style, 'color', 'white')
  setImportant(badge.style, 'font', '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif')
  setImportant(badge.style, 'line-height', `${BADGE_SIZE}px`)
  setImportant(badge.style, 'box-sizing', 'border-box')
  setImportant(badge.style, 'box-shadow', '0 1px 8px rgba(47, 123, 255, 0.28), 0 0 0 1px rgba(47, 123, 255, 0.22)')

  root.appendChild(overlay)
  root.appendChild(badge)
  document.documentElement.appendChild(root)
  return root
}

/** Viewport screenshot with the picked element's region annotated (blue box + numbered badge). 图4 */
export async function captureAnnotatedRegion(el: Element, label = 1): Promise<string> {
  const overlay = createAnnotationOverlay(el, label)
  try {
    const canvas = await html2canvas(document.documentElement, {
      useCORS: true,
      logging: false,
      scale: 1,
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    })
    return compressDataUrl(canvas.toDataURL('image/png'))
  } finally {
    overlay.remove()
  }
}
