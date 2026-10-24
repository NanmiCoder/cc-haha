import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@/types/chat'
import { localImageFileUrl } from '@/lib/attachmentImages'
import { collectConversationImages } from '@/components/chat/conversationImages'

const context = { sessionId: 'gallery-session', baseUrl: 'http://127.0.0.1:3456', workDir: '/tmp/project', imageLabel: 'Image' }
const user = (attachments: Extract<UIMessage, { type: 'user_text' }>['attachments']): UIMessage => ({
  id: 'user', type: 'user_text', content: 'Look at these', timestamp: 1, attachments,
})
const assistant = (content: string): UIMessage => ({ id: 'assistant', type: 'assistant_text', content, timestamp: 2 })
const call = (toolUseId: string, toolName: string, input: unknown = {}): UIMessage => ({
  id: `${toolUseId}-call`, type: 'tool_use', toolUseId, toolName, input, timestamp: 3,
})
const result = (toolUseId: string, content: unknown, isError = false): UIMessage => ({
  id: `${toolUseId}-result`, type: 'tool_result', toolUseId, content, isError, timestamp: 4,
})
const inline = { mediaType: 'image/png' as const, data: btoa('tool screenshot') }
const block = { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } }

describe('collectConversationImages', () => {
  it('collects user attachments, assistant pictures and tool screenshots in transcript order', () => {
    const images = collectConversationImages([
      user([{ type: 'image', name: 'upload.png', path: '/tmp/upload.png' }]),
      assistant('![preview](images/preview.png)\nSaved `/tmp/final.png`'),
      call('read', 'Read', { file_path: '/tmp/read.png' }),
      result('read', [block]),
      call('bash', 'Bash'),
      result('bash', [{ type: 'text', text: 'Screenshot /tmp/tool-output.png' }]),
      result('browser', { screenshotPath: '/tmp/browser.png' }),
    ], context)

    expect(images).toEqual([
      { name: 'upload.png', path: '/tmp/upload.png', src: localImageFileUrl('/tmp/upload.png') },
      { name: 'preview.png', path: '/tmp/project/images/preview.png', src: `${context.baseUrl}/preview-fs/gallery-session/images/preview.png` },
      { name: 'final.png', path: '/tmp/final.png', src: localImageFileUrl('/tmp/final.png') },
      { name: 'read.png', path: '/tmp/read.png', src: '', inline },
      { name: 'tool-output.png', path: '/tmp/tool-output.png', src: localImageFileUrl('/tmp/tool-output.png') },
      { name: 'browser.png', path: '/tmp/browser.png', src: localImageFileUrl('/tmp/browser.png') },
    ])
  })

  it('deduplicates the same path across attachment and prose URLs but keeps changed tool pixels', () => {
    const nextBlock = { ...block, source: { ...block.source, data: btoa('changed screenshot') } }
    const images = collectConversationImages([
      user([{ type: 'image', name: 'same.png', path: '/tmp/project/same.png' }]),
      assistant('![same](same.png)\n`/tmp/project/same.png`'),
      call('first', 'Read', { file_path: '/tmp/read.png' }), result('first', [block]),
      call('second', 'Read', { file_path: '/tmp/read.png' }), result('second', [block, nextBlock]),
    ], context)

    expect(images).toHaveLength(3)
    expect(images[0]?.name).toBe('same.png')
    expect(images.slice(1).map((image) => image.inline?.data)).toEqual([inline.data, nextBlock.source.data])
  })

  it('keeps assistant image URL restrictions and excludes non-images and malformed tool blocks', () => {
    const images = collectConversationImages([
      user([{ type: 'file', name: 'notes.md', path: '/tmp/notes.md' }, { type: 'image', name: 'missing.png' }]),
      assistant('![remote](https://tracker.invalid/pixel.png) ![loopback](http://127.0.0.1:9000/pixel.png) ![escape](../../outside.png)'),
      result('unknown', [block, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '%%%INVALID%%%' } }]),
    ], context)

    expect(images).toEqual([{ name: 'Image', src: '', inline }])
  })

  it('includes generated results once, omits failed generation, and preserves Read snapshots of generated files', () => {
    const path = '/Users/me/.claude/cc-haha/generated-images/session/result.png'
    const generation = {
      type: 'image_generation_result', providerId: 'fixture', providerKind: 'fixture',
      model: 'fixture', prompt: 'test', durationMs: 1, images: [{ path, mimeType: 'image/png' }],
    }
    const images = collectConversationImages([
      call('gen', 'ImageGen'), result('gen', JSON.stringify(generation)),
      assistant(`![generated](${path})\n\`${path}\``),
      call('failed', 'ImageEdit'), result('failed', generation, true),
      call('read', 'Read', { file_path: path }), result('read', [block]),
    ], context)

    expect(images).toEqual([
      { src: localImageFileUrl(path), name: 'result.png', path },
      { src: '', name: 'result.png', path, inline },
    ])
  })
})
