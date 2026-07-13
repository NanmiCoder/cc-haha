import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  configureLocalServerRequestAuth,
  configurePreviewSessionPermissions,
  createPreviewSessionPartition,
} from './services/previewSession'

const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')

describe('Electron preview security boundary', () => {
  it('uses a fresh in-memory session partition for every remote preview', () => {
    const firstPartition = createPreviewSessionPartition()
    const secondPartition = createPreviewSessionPartition()

    expect(firstPartition.startsWith('cc-haha-preview-')).toBe(true)
    expect(firstPartition.startsWith('persist:')).toBe(false)
    expect(secondPartition).not.toBe(firstPartition)
    expect(mainSource).toContain('partition: createPreviewSessionPartition()')
  })

  it('denies preview permission checks and requests by default', () => {
    const handlers: {
      check?: (...args: unknown[]) => boolean
      request?: (...args: unknown[]) => void
      beforeSendHeaders?: (...args: unknown[]) => void
    } = {}
    const session = {
      setPermissionCheckHandler(handler: (...args: unknown[]) => boolean) {
        handlers.check = handler
      },
      setPermissionRequestHandler(handler: (...args: unknown[]) => void) {
        handlers.request = handler
      },
      webRequest: {
        onBeforeSendHeaders(handler: (...args: unknown[]) => void) {
          handlers.beforeSendHeaders = handler
        },
      },
    }

    configurePreviewSessionPermissions(session as never)
    configureLocalServerRequestAuth(session.webRequest as never, () => ({
      serverUrl: 'http://127.0.0.1:49321',
      token: 'preview-local-token',
    }))

    expect(handlers.check?.()).toBe(false)
    const callback = (allowed: boolean) => expect(allowed).toBe(false)
    handlers.request?.(null, 'media', callback)
    expect(mainSource).toContain('configurePreviewSessionPermissions(view.webContents.session)')
    expect(mainSource).toContain('mainWindow.webContents.session.webRequest')

    const localCallback = vi.fn()
    handlers.beforeSendHeaders?.({
      url: 'http://127.0.0.1:49321/preview-fs/session/index.css',
      requestHeaders: { Accept: 'text/css' },
    }, localCallback)
    expect(localCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: 'text/css',
        Authorization: 'Bearer preview-local-token',
      },
    })

    const remoteCallback = vi.fn()
    handlers.beforeSendHeaders?.({
      url: 'https://example.com/app.js',
      requestHeaders: { Accept: '*/*' },
    }, remoteCallback)
    expect(remoteCallback).toHaveBeenCalledWith({ requestHeaders: { Accept: '*/*' } })
  })
})
