import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@/types/chat'
import { sameGalleryImage } from '@/components/chat/conversationImageGallery'
import { collectConversationImages } from '@/components/chat/conversationImages'

const context = { sessionId: 'snapshot-gallery', baseUrl: 'http://127.0.0.1:3456', imageLabel: 'Image' }
const path = '/tmp/screenshot.png'
const first = { type: 'image' as const, name: 'first.png', path, data: 'data:image/png;base64,AAAA' }
const second = { type: 'image' as const, name: 'second.png', path, data: 'data:image/png;base64,BBBB' }
const user = (id: string, attachments: NonNullable<Extract<UIMessage, { type: 'user_text' }>['attachments']>): UIMessage => ({
  id, type: 'user_text', content: 'Screenshots', timestamp: 1, attachments,
})

describe('conversation gallery snapshot identity', () => {
  it.each([
    ['one message', [user('one', [first, second])]],
    ['separate messages', [user('one', [first]), user('two', [second])]],
  ])('keeps both uploaded snapshots of the same file in %s', (_label, messages) => {
    // History retains both the source path and captured pixels. Reusing the filename
    // must not remove a captured image or replace it when its thumbnail is opened.
    const images = collectConversationImages(messages, context)

    expect(images.map(({ src, name }) => ({ src, name }))).toEqual([
      { src: first.data, name: first.name },
      { src: second.data, name: second.name },
    ])
    expect(images.findIndex((image) => sameGalleryImage(image, { src: first.data, name: first.name, path }))).toBe(0)
    expect(images.findIndex((image) => sameGalleryImage(image, { src: second.data, name: second.name, path }))).toBe(1)
  })

  it.each(['data:image/png;base64,AAAA', 'blob:captured-image'])('keeps a %s snapshot separate from its live source file', (src) => {
    const snapshot = { src, name: 'snapshot.png', path }
    const liveFile = { src: 'http://127.0.0.1:3456/api/files/image?path=screenshot.png', name: 'live.png', path }

    expect(sameGalleryImage(snapshot, liveFile)).toBe(false)
    expect(sameGalleryImage(liveFile, snapshot)).toBe(false)
    expect(sameGalleryImage(snapshot, { ...snapshot, name: 'renamed.png' })).toBe(true)
  })
})
