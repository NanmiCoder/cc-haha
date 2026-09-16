import { afterEach, describe, expect, it, vi } from 'vitest'
import { createZoomControls } from './zoomControls'

const config = {
  zoomFactor: 1, appZoom: 1,
  copy: { zoom: 'Page zoom', zoomOut: 'Zoom out', zoomIn: 'Zoom in', zoomReset: 'Reset zoom' },
  colors: { background: 'white', foreground: '#222', muted: '#666', border: '#ddd', hover: '#eee', focus: '#555', shadow: '0 2px 8px #ddd' },
}

afterEach(() => { document.querySelectorAll('[data-workspace-browser-zoom]').forEach(node => node.remove()) })

describe('native page zoom controls', () => {
  it('mounts a Shadow DOM capsule in the page and issues bounded zoom requests', () => {
    const request = vi.fn()
    const controls = createZoomControls(request)
    controls.update(config)
    const host = document.querySelector<HTMLElement>('[data-workspace-browser-zoom]')!
    expect(host.style.position).toBe('fixed')
    expect(host.style.bottom).toBe('12px')
    const root = host.shadowRoot!
    root.querySelector<HTMLButtonElement>('[data-action="out"]')!.click()
    expect(request).toHaveBeenLastCalledWith('out')
    controls.update({ ...config, zoomFactor: 0.5 })
    expect(root.querySelector<HTMLButtonElement>('[data-action="out"]')!.disabled).toBe(true)
    expect(root.querySelector('output')?.textContent).toBe('50%')
    expect(host.style.transform).toBe('scale(2)')
    controls.update({ ...config, zoomFactor: 2 })
    expect(root.querySelector<HTMLButtonElement>('[data-action="in"]')!.disabled).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-action="reset"]')!.click()
    expect(request).toHaveBeenLastCalledWith('reset')
    controls.destroy()
    expect(host.isConnected).toBe(false)
    controls.restore()
    expect(host.isConnected).toBe(true)
    expect(root.querySelector('output')?.textContent).toBe('200%')
    controls.destroy()
  })

  it('keeps the control size stable across page zoom, follows app zoom and theme, and excludes itself from picking', () => {
    const controls = createZoomControls(vi.fn())
    controls.update({ ...config, zoomFactor: 0.8, appZoom: 1.2 })
    const host = document.querySelector<HTMLElement>('[data-workspace-browser-zoom]')!
    expect(host.style.transform).toBe('scale(1.5)')
    expect(host.style.right).toBe('18px')
    expect(host.getAttribute('data-html2canvas-ignore')).toBe('true')
    const button = host.shadowRoot!.querySelector('button')!
    expect(controls.ownsTarget([button, host])).toBe(true)
    controls.setSuppressed(true)
    expect(host.style.visibility).toBe('hidden')
    controls.update({ ...config, colors: { ...config.colors, background: '#222' } })
    expect(host.style.visibility).toBe('hidden')
    controls.setSuppressed(false)
    expect(host.style.visibility).toBe('visible')
    expect(host.style.getPropertyValue('--zoom-background')).toBe('#222')
    controls.destroy()
  })
})
