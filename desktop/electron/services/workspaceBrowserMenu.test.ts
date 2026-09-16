import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceBrowserMenuAction, WorkspaceBrowserMenuOptions } from '../../src/lib/desktopHost/types'
import { buildWorkspaceBrowserMenuTemplate, WorkspaceBrowserMenuController, workspaceBrowserMenuPosition } from './workspaceBrowserMenu'

const labels: WorkspaceBrowserMenuOptions['labels'] = {
  find: '页面查找', print: '保存 PDF', zoom: '缩放', zoomIn: '放大', zoomOut: '缩小', zoomReset: '重置',
  capture: '完整截图', pickElement: '选择元素', downloads: '下载', history: '历史', openExternal: '外部浏览器',
}
const options: WorkspaceBrowserMenuOptions = { x: 100, y: 44, labels, zoomFactor: 1, hasPage: true, canOpenExternal: true }

function select(template: MenuItemConstructorOptions[], action: WorkspaceBrowserMenuAction) {
  const click = template.find(item => item.id === action)?.click as (() => void) | undefined
  click?.()
}

describe('workspace browser native menu', () => {
  it('keeps every localized action without global roles or accelerators', () => {
    const onSelect = vi.fn()
    const template = buildWorkspaceBrowserMenuTemplate({ ...options, zoomFactor: 1.2 }, onSelect)
    const actions = template.filter(item => item.id && item.id !== 'zoom')
    expect(actions.map(item => item.id).sort()).toEqual(Object.keys(labels).filter(key => key !== 'zoom').sort())
    for (const item of actions) {
      expect(item.label).toBe(labels[item.id as WorkspaceBrowserMenuAction])
      expect(item.role).toBeUndefined()
      expect(item.accelerator).toBeUndefined()
      select(template, item.id as WorkspaceBrowserMenuAction)
      expect(onSelect).toHaveBeenLastCalledWith(item.id)
    }
    expect(template.find(item => item.id === 'zoom')).toMatchObject({ label: '缩放 · 120%', enabled: false })
  })

  it.each([
    { zoomFactor: 0.5, disabled: 'zoomOut' },
    { zoomFactor: 2, disabled: 'zoomIn' },
    { zoomFactor: 1, disabled: 'zoomReset' },
  ] as const)('disables $disabled at native zoom $zoomFactor', ({ zoomFactor, disabled }) => {
    const onSelect = vi.fn()
    const template = buildWorkspaceBrowserMenuTemplate({ ...options, zoomFactor, canOpenExternal: false }, onSelect)
    expect(template.find(item => item.id === disabled)?.enabled).toBe(false)
    select(template, disabled)
    select(template, 'openExternal')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('disables page-only actions on a blank tab while keeping library panels available', () => {
    const onSelect = vi.fn()
    const template = buildWorkspaceBrowserMenuTemplate({ ...options, hasPage: false }, onSelect)
    for (const action of ['find', 'print', 'capture', 'pickElement'] as const) {
      expect(template.find(item => item.id === action)?.enabled).toBe(false)
      select(template, action)
    }
    expect(onSelect).not.toHaveBeenCalled()
    select(template, 'downloads')
    expect(onSelect).toHaveBeenLastCalledWith('downloads')
    select(template, 'history')
    expect(onSelect).toHaveBeenLastCalledWith('history')
  })

  it('returns null on dismissal and ignores callbacks after cancellation', async () => {
    let template: MenuItemConstructorOptions[] = []
    const menu = { popup: vi.fn(), closePopup: vi.fn() }
    const controller = new WorkspaceBrowserMenuController(value => { template = value; return menu })
    const first = controller.show('wb-a', options)
    expect(menu.popup).toHaveBeenCalledWith({ x: 100, y: 44, callback: expect.any(Function) })
    menu.popup.mock.calls[0]![0].callback()
    select(template, 'print')
    await expect(first).resolves.toBeNull()
    const second = controller.show('wb-a', options)
    controller.cancel('wb-b')
    expect(menu.closePopup).not.toHaveBeenCalled()
    controller.cancel('wb-a')
    await expect(second).resolves.toBeNull()
    expect(menu.closePopup).toHaveBeenCalledTimes(1)
  })

  it('returns the selected action only once when popup close follows click', async () => {
    let template: MenuItemConstructorOptions[] = []
    const menu = { popup: vi.fn(), closePopup: vi.fn() }
    const controller = new WorkspaceBrowserMenuController(value => { template = value; return menu })
    const result = controller.show('wb-a', options)
    select(template, 'downloads')
    menu.popup.mock.calls[0]![0].callback()
    select(template, 'history')
    await expect(result).resolves.toBe('downloads')
  })

  it('preserves genuine popup and menu construction failures and permits a later retry', async () => {
    const menu = { popup: vi.fn().mockImplementationOnce(() => { throw new Error('native popup failed') }), closePopup: vi.fn() }
    const factory = vi.fn().mockImplementationOnce(() => { throw new Error('native menu failed') }).mockReturnValue(menu)
    const controller = new WorkspaceBrowserMenuController(factory)
    await expect(controller.show('wb-a', options)).rejects.toThrow('native menu failed')
    await expect(controller.show('wb-a', options)).rejects.toThrow('native popup failed')
    const retry = controller.show('wb-a', options)
    controller.cancel()
    await expect(retry).resolves.toBeNull()
  })
})

describe('workspace browser menu anchor', () => {
  it('converts CSS coordinates using only host zoom and clamps inside window contents', () => {
    expect(workspaceBrowserMenuPosition({ x: 10.4, y: 44 }, 1.5, { width: 1000, height: 800 })).toEqual({ x: 16, y: 66 })
    expect(workspaceBrowserMenuPosition({ x: -10, y: 2000 }, 2, { width: 800, height: 600 })).toEqual({ x: 0, y: 599 })
  })

  it('rejects non-finite inputs before opening a native popup', () => {
    expect(() => workspaceBrowserMenuPosition({ x: Infinity, y: 44 }, 1, { width: 100, height: 100 })).toThrow('position')
    expect(() => workspaceBrowserMenuPosition({ x: 10, y: 44 }, NaN, { width: 100, height: 100 })).toThrow('position')
  })
})
