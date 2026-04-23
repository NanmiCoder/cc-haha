import { describe, it, expect } from 'bun:test'
import { extractInboundPayload } from '../extract-payload.js'

describe('extractInboundPayload', () => {
  it('pulls text out of a text message', () => {
    const result = extractInboundPayload(
      JSON.stringify({ text: 'hello world' }),
      'text',
    )
    expect(result.text).toBe('hello world')
    expect(result.pendingDownloads).toEqual([])
  })

  it('pulls text out of a post (rich text) message', () => {
    const content = JSON.stringify({
      zh_cn: {
        content: [[{ tag: 'text', text: 'hi ' }, { tag: 'text', text: 'there' }]],
      },
    })
    const result = extractInboundPayload(content, 'post')
    expect(result.text).toBe('hi there')
    expect(result.pendingDownloads).toEqual([])
  })

  it('identifies an image message as a pending image download', () => {
    const content = JSON.stringify({ image_key: 'img_key_abc' })
    const result = extractInboundPayload(content, 'image')
    expect(result.text).toBe('')
    expect(result.pendingDownloads).toEqual([
      { kind: 'image', fileKey: 'img_key_abc' },
    ])
  })

  it('identifies a file message as a pending file download with file_name', () => {
    const content = JSON.stringify({
      file_key: 'file_key_xyz',
      file_name: 'spec.pdf',
    })
    const result = extractInboundPayload(content, 'file')
    expect(result.pendingDownloads).toEqual([
      { kind: 'file', fileKey: 'file_key_xyz', fileName: 'spec.pdf' },
    ])
  })

  it('identifies file_archive the same way as file', () => {
    const content = JSON.stringify({ file_key: 'fk1', file_name: 'x.zip' })
    const result = extractInboundPayload(content, 'file_archive')
    expect(result.pendingDownloads).toEqual([
      { kind: 'file', fileKey: 'fk1', fileName: 'x.zip' },
    ])
  })

  it('extracts img + file elements from a post message', () => {
    const content = JSON.stringify({
      zh_cn: {
        content: [
          [{ tag: 'text', text: 'look: ' }],
          [{ tag: 'img', image_key: 'img_post_1' }],
          [{ tag: 'text', text: ' and ' }],
          [{ tag: 'file', file_key: 'file_post_1', file_name: 'note.txt' }],
        ],
      },
    })
    const result = extractInboundPayload(content, 'post')
    expect(result.text).toBe('look:  and ')
    expect(result.pendingDownloads).toEqual([
      { kind: 'image', fileKey: 'img_post_1' },
      { kind: 'file', fileKey: 'file_post_1', fileName: 'note.txt' },
    ])
  })

  it('returns empty on malformed JSON', () => {
    const result = extractInboundPayload('not json', 'text')
    expect(result.text).toBe('')
    expect(result.pendingDownloads).toEqual([])
  })
})
