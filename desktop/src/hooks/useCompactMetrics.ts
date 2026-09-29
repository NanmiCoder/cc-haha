import { isDesktopRuntime } from '../lib/desktopRuntime'
import { useMobileViewport } from './useMobileViewport'

/**
 * Whether the run metrics (usage / elapsed) should render in their compact form.
 *
 * A desktop window is wide enough to spell out「用量 ≈9.24k + 0.98k 总耗时 ≈1m11s」.
 * A phone browser is portrait and narrow, where those labels push the agent name
 * and the status badge off the line — so there the numbers stand alone and sit
 * closer together. The desktop runtime keeps the roomy form even when its window
 * is dragged narrow, because it is not a phone.
 */
export function useCompactMetrics(): boolean {
  const isMobileViewport = useMobileViewport()
  return isMobileViewport && !isDesktopRuntime()
}
