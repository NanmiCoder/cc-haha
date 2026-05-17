import { describe, expect, it } from 'vitest'
import { pathToComposerAttachment } from './composerAttachments'

describe('composer attachment payloads', () => {
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
})
