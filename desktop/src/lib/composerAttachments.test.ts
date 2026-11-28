import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from './desktopHost/browserHost'
import {
  filesToComposerAttachments,
  getDataTransferFiles,
  isSupportedImageFile,
  pathToComposerAttachment,
  selectNativeFileAttachments,
  selectNativeImageAttachments,
} from './composerAttachments'

describe('composer attachment payloads', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
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

  it('keeps pasted desktop files as native path attachments across common file types', async () => {
    const nativePaths = new Map<File, string>()
    const files = [
      new File(['# Notes'], 'notes.md', { type: 'text/markdown' }),
      new File(['pdf'], 'brief.pdf', { type: 'application/pdf' }),
      new File(['docx'], 'proposal.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ]
    nativePaths.set(files[0]!, 'C:\\Users\\Nanmi\\Desktop\\notes.md')
    nativePaths.set(files[1]!, 'C:\\Users\\Nanmi\\Desktop\\brief.pdf')
    nativePaths.set(files[2]!, 'C:\\Users\\Nanmi\\Desktop\\proposal.docx')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      files: {
        getPathForFile: file => nativePaths.get(file) ?? '',
      },
    }

    const attachments = await filesToComposerAttachments(files)

    expect(attachments.map(({ name, path, data }) => ({ name, path, data }))).toEqual([
      { name: 'notes.md', path: 'C:\\Users\\Nanmi\\Desktop\\notes.md', data: undefined },
      { name: 'brief.pdf', path: 'C:\\Users\\Nanmi\\Desktop\\brief.pdf', data: undefined },
      { name: 'proposal.docx', path: 'C:\\Users\\Nanmi\\Desktop\\proposal.docx', data: undefined },
    ])
  })

  it('classifies pasted desktop images as image attachments without inlining their bytes', async () => {
    const nativePaths = new Map<File, string>()
    const files = [
      new File(['png'], 'screenshot.PNG', { type: 'image/png' }),
      new File(['jpg'], '6代码仓库.jpg', { type: 'image/jpeg' }),
      new File(['webp'], 'hero.webp', { type: 'image/webp' }),
      new File(['# Notes'], 'notes.md', { type: 'text/markdown' }),
    ]
    nativePaths.set(files[0]!, '/Users/nanmi/Desktop/screenshot.PNG')
    nativePaths.set(files[1]!, '/Users/nanmi/Desktop/6代码仓库.jpg')
    nativePaths.set(files[2]!, 'C:\\Users\\Nanmi\\Desktop\\hero.webp')
    nativePaths.set(files[3]!, '/Users/nanmi/Desktop/notes.md')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      files: {
        getPathForFile: file => nativePaths.get(file) ?? '',
      },
    }

    const attachments = await filesToComposerAttachments(files)

    expect(attachments.map(({ name, type, path, data, previewUrl }) => ({ name, type, path, data, previewUrl }))).toEqual([
      { name: 'screenshot.PNG', type: 'image', path: '/Users/nanmi/Desktop/screenshot.PNG', data: undefined, previewUrl: undefined },
      { name: '6代码仓库.jpg', type: 'image', path: '/Users/nanmi/Desktop/6代码仓库.jpg', data: undefined, previewUrl: undefined },
      { name: 'hero.webp', type: 'image', path: 'C:\\Users\\Nanmi\\Desktop\\hero.webp', data: undefined, previewUrl: undefined },
      { name: 'notes.md', type: 'file', path: '/Users/nanmi/Desktop/notes.md', data: undefined, previewUrl: undefined },
    ])
  })

  it('keeps formats the server cannot inline as file attachments', () => {
    // `type: 'image'` makes ConversationService inline the bytes as an image block,
    // which the API rejects for these media types — they stay path references.
    expect(pathToComposerAttachment('/Users/nanmi/Desktop/logo.svg').type).toBe('file')
    expect(pathToComposerAttachment('/Users/nanmi/Desktop/photo.avif').type).toBe('file')
    expect(pathToComposerAttachment('/Users/nanmi/Desktop/icon.ico').type).toBe('file')
  })

  it('reads clipboard files from DataTransfer items when the files list is empty', () => {
    const markdown = new File(['# Notes'], 'notes.md', { type: 'text/markdown' })
    const dataTransfer = {
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => markdown },
      ],
    } as unknown as DataTransfer

    expect(getDataTransferFiles(dataTransfer)).toEqual([markdown])
  })

  it('keeps every clipboard item when the browser files list is incomplete', () => {
    const markdown = new File(['# Notes'], 'notes.md', { type: 'text/markdown' })
    const spreadsheet = new File(['name,total'], 'budget.csv', { type: 'text/csv' })
    const dataTransfer = {
      files: [markdown],
      items: [
        { kind: 'file', getAsFile: () => markdown },
        { kind: 'file', getAsFile: () => spreadsheet },
      ],
    } as unknown as DataTransfer

    expect(getDataTransferFiles(dataTransfer)).toEqual([markdown, spreadsheet])
  })

  it('filters supported inline image files and rejects non-inline formats', () => {
    expect(isSupportedImageFile(new File(['x'], 'shot.png', { type: 'image/png' }))).toBe(true)
    expect(isSupportedImageFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))).toBe(true)
    expect(isSupportedImageFile(new File(['x'], 'anim.gif', { type: 'image/gif' }))).toBe(true)
    expect(isSupportedImageFile(new File(['x'], 'hero.webp', { type: 'image/webp' }))).toBe(true)
    expect(isSupportedImageFile(new File(['x'], 'from-finder.PNG', { type: '' }))).toBe(true)
    expect(isSupportedImageFile(new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' }))).toBe(false)
    expect(isSupportedImageFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }))).toBe(false)
  })

  it('opens the native dialog with image filters and keeps only inline images', async () => {
    const open = vi.fn().mockResolvedValue(['/workspace/a.png', '/workspace/b.svg', '/workspace/c.webp'])
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

    const attachments = await selectNativeImageAttachments()

    expect(open).toHaveBeenCalledWith({
      multiple: true,
      directory: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
    expect(attachments?.map((attachment) => attachment.path)).toEqual([
      '/workspace/a.png',
      '/workspace/c.webp',
    ])
  })
})
