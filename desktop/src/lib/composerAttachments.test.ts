import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from '../api/client'
import { browserHost } from './desktopHost/browserHost'
import { pathToComposerAttachment, selectNativeFileAttachments } from './composerAttachments'

describe('composer attachment payloads', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
    setBaseUrl('http://127.0.0.1:3456')
  })

  it('keeps many selected desktop project files as paths instead of request-body data', () => {
    const projectRoot = '/tmp/cc-haha-issue-444-regression'
    const files = Array.from({ length: 12 }, (_, index) => (
      `${projectRoot}/assets/large-${index + 1}.bin`
    ))

    const oldInlineAttachments = files.map((filePath) => ({
      type: 'file',
      name: filePath.split('/').pop(),
      data: `data:application/octet-stream;base64,${'A'.repeat(256 * 1024)}`,
      mimeType: 'application/octet-stream',
    }))
    const oldInlinePayload = JSON.stringify({
      type: 'user_message',
      content: 'analyze these files',
      attachments: oldInlineAttachments,
    })

    const pathOnlyAttachments = files.map(pathToComposerAttachment)
    const pathOnlyPayload = JSON.stringify({
      type: 'user_message',
      content: 'analyze these files',
      attachments: pathOnlyAttachments,
    })

    expect(oldInlinePayload.length).toBeGreaterThan(3 * 1024 * 1024)
    expect(pathOnlyPayload.length).toBeLessThan(3 * 1024)
    expect(pathOnlyAttachments.every((attachment) => attachment.path && !attachment.data)).toBe(true)
  })

  it('creates safe preview URLs for native image paths with spaces', () => {
    setBaseUrl('http://127.0.0.1:4567')

    const attachment = pathToComposerAttachment('C:\\Users\\Ada Lovelace\\Pictures\\chart final.PNG')

    expect(attachment).toMatchObject({
      name: 'chart final.PNG',
      type: 'image',
      path: 'C:\\Users\\Ada Lovelace\\Pictures\\chart final.PNG',
      mimeType: 'image/png',
      previewUrl: 'http://127.0.0.1:4567/api/filesystem/file?path=C%3A%5CUsers%5CAda%20Lovelace%5CPictures%5Cchart%20final.PNG',
    })
    expect(attachment.previewUrl).not.toContain('file://')
  })

  it('keeps non-image native paths as file chips without preview URLs', () => {
    const attachment = pathToComposerAttachment('/workspace/notes.txt')

    expect(attachment).toMatchObject({
      name: 'notes.txt',
      type: 'file',
      path: '/workspace/notes.txt',
    })
    expect(attachment.previewUrl).toBeUndefined()
    expect(attachment.data).toBeUndefined()
  })

  it('selects native file attachments through the injected desktop host', async () => {
    const open = vi.fn().mockResolvedValue(['/workspace/a.txt', '/workspace/b.log'])
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        dialogs: true,
      },
      dialogs: {
        ...browserHost.dialogs,
        open,
      },
    }

    const attachments = await selectNativeFileAttachments()

    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false })
    expect(attachments?.map((attachment) => attachment.path)).toEqual([
      '/workspace/a.txt',
      '/workspace/b.log',
    ])
  })
})
