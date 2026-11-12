import { climb as climbEl, descend as descendEl } from './treeNav'

type PickerDeps = { onSelect: (el: Element) => void }

export function createPicker(deps: PickerDeps) {
  let active = false
  let current: Element | null = null
  let hovered: Element | null = null

  // Shadow DOM overlay host: isolated from page CSS and resistant to CSP inline restrictions
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  const shadow = host.attachShadow({ mode: 'open' })
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;border:2px solid #2f7bff;background:rgba(47,123,255,.12);pointer-events:none'
  box.hidden = true
  shadow.appendChild(box)

  const draw = (el: Element | null) => {
    if (!el) { box.hidden = true; return }
    const r = el.getBoundingClientRect()
    box.hidden = false
    box.style.left = `${r.left}px`; box.style.top = `${r.top}px`
    box.style.width = `${r.width}px`; box.style.height = `${r.height}px`
  }

  const setCurrent = (el: Element) => { current = el; draw(el); deps.onSelect(el) }

  return {
    enter() {
      active = true; current = null; hovered = null
      if (!host.isConnected) document.documentElement.appendChild(host)
    },
    hover(el: Element) { if (!active || current) return; hovered = el; draw(el) },
    select() { if (hovered) setCurrent(hovered) },
    climb() { if (current) { const p = climbEl(current); if (p) { current = p; draw(p) } } },
    descend() { if (current) { const c = descendEl(current); if (c) { current = c; draw(c) } } },
    current() { return current },
    exit() { active = false; current = null; hovered = null; box.hidden = true; host.remove() },
  }
}
