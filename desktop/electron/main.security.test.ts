import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  configurePreviewSessionPermissions,
  PREVIEW_SESSION_PARTITION,
} from './services/previewSession'

const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')

describe('Electron preview security boundary', () => {
  it('uses a dedicated in-memory session partition for remote previews', () => {
    expect(PREVIEW_SESSION_PARTITION).toBe('cc-haha-preview')
    expect(PREVIEW_SESSION_PARTITION.startsWith('persist:')).toBe(false)
    expect(mainSource).toContain('partition: PREVIEW_SESSION_PARTITION')
  })

  it('denies preview permission checks and requests by default', () => {
    const handlers: {
      check?: (...args: unknown[]) => boolean
      request?: (...args: unknown[]) => void
    } = {}
    const session = {
      setPermissionCheckHandler(handler: (...args: unknown[]) => boolean) {
        handlers.check = handler
      },
      setPermissionRequestHandler(handler: (...args: unknown[]) => void) {
        handlers.request = handler
      },
    }

    configurePreviewSessionPermissions(session as never)

    expect(handlers.check?.()).toBe(false)
    const callback = (allowed: boolean) => expect(allowed).toBe(false)
    handlers.request?.(null, 'media', callback)
    expect(mainSource).toContain('configurePreviewSessionPermissions(view.webContents.session)')
  })
})
