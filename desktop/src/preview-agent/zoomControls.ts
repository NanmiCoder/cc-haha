import type { PreviewBrowserControlsMessage } from '../lib/desktopHost/types'

type ZoomControlsConfig = Omit<PreviewBrowserControlsMessage, 'type' | 'v'>
export type BrowserZoomAction = 'out' | 'in' | 'reset'

/** Lives inside the native page, above its contents; renderer z-index cannot cover a WebContentsView. */
export function createZoomControls(onAction: (action: BrowserZoomAction) => void) {
  const host = document.createElement('div')
  host.dataset.workspaceBrowserZoom = 'true'
  host.setAttribute('data-html2canvas-ignore', 'true')
  for (const [name, value] of Object.entries({
    all: 'initial', position: 'fixed', 'z-index': '2147483646',
    'transform-origin': 'bottom right', 'pointer-events': 'auto',
  })) host.style.setProperty(name, value, 'important')
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    .controls { display:flex; align-items:center; gap:2px; padding:4px;
      color:var(--zoom-foreground); background:var(--zoom-background); border:1px solid var(--zoom-border);
      border-radius:12px; box-shadow:var(--zoom-shadow); font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button { all:unset; box-sizing:border-box; display:flex; align-items:center; justify-content:center;
      width:28px; height:28px; border-radius:8px; cursor:pointer; color:var(--zoom-muted);
      transition:background-color 120ms ease-out,color 120ms ease-out,transform 120ms ease-out; }
    button:hover { background:var(--zoom-hover); color:var(--zoom-foreground); }
    button:active { transform:scale(.96); }
    button:focus-visible { outline:2px solid var(--zoom-focus); outline-offset:1px; }
    button:disabled { opacity:.35; cursor:default; pointer-events:none; }
    output { min-width:44px; text-align:center; font:11px/1.4 ui-monospace,"SF Mono",monospace; font-variant-numeric:tabular-nums; }
    .separator { width:1px; height:16px; margin:0 2px; background:var(--zoom-border); }
    @media (prefers-reduced-motion:reduce) { button { transition:none; } }
    @media print { .controls { display:none; } }
  `
  const group = document.createElement('div')
  group.className = 'controls'
  group.setAttribute('role', 'group')
  const iconPaths: Record<BrowserZoomAction, string[]> = {
    out: ['M5 12h14'], in: ['M5 12h14', 'M12 5v14'],
    reset: ['M3 11a9 9 0 1 1 2.6 6.4', 'M3 4v7h7'],
  }
  const buttons = {} as Record<BrowserZoomAction, HTMLButtonElement>
  for (const action of ['out', 'in', 'reset'] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = action
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [name, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value)
    for (const d of iconPaths[action]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    button.append(svg)
    button.addEventListener('click', event => {
      event.stopPropagation()
      if (!button.disabled) onAction(action)
    })
    buttons[action] = button
  }
  const value = document.createElement('output')
  value.setAttribute('aria-live', 'polite')
  const separator = document.createElement('span')
  separator.className = 'separator'
  separator.setAttribute('aria-hidden', 'true')
  group.append(buttons.out, value, buttons.in, separator, buttons.reset)
  root.append(style, group)
  // Do not send page handlers clicks/shortcuts meant for the browser chrome.
  root.addEventListener('keydown', event => event.stopPropagation())
  root.addEventListener('pointerdown', event => event.stopPropagation())
  let suppressed = false
  let captureSuppressed = false
  let latestConfig: ZoomControlsConfig | null = null
  const updateVisibility = () => host.style.setProperty('visibility', suppressed || captureSuppressed ? 'hidden' : 'visible', 'important')
  const controls = {
    update(config: ZoomControlsConfig) {
      latestConfig = config
      if (!host.isConnected) document.documentElement.append(host)
      const scale = Math.round(config.appZoom / config.zoomFactor * 1000) / 1000
      host.style.setProperty('transform', `scale(${scale})`, 'important')
      host.style.setProperty('bottom', `${12 * scale}px`, 'important')
      host.style.setProperty('right', `${12 * scale}px`, 'important')
      updateVisibility()
      for (const [name, color] of Object.entries(config.colors)) host.style.setProperty(`--zoom-${name}`, color)
      group.setAttribute('aria-label', config.copy.zoom)
      for (const [action, label] of [['out', config.copy.zoomOut], ['in', config.copy.zoomIn], ['reset', config.copy.zoomReset]] as const) {
        buttons[action].setAttribute('aria-label', label)
        buttons[action].title = label
      }
      value.textContent = `${Math.round(config.zoomFactor * 100)}%`
      buttons.out.disabled = config.zoomFactor <= 0.5
      buttons.in.disabled = config.zoomFactor >= 2
      buttons.reset.disabled = config.zoomFactor === 1
    },
    setSuppressed(hidden: boolean) {
      suppressed = hidden
      updateVisibility()
    },
    setCaptureSuppressed(hidden: boolean) { captureSuppressed = hidden; updateVisibility() },
    ownsTarget(path: EventTarget[]) { return path.includes(host) },
    restore() { if (latestConfig) controls.update(latestConfig) },
    destroy() { host.remove() },
  }
  return controls
}
