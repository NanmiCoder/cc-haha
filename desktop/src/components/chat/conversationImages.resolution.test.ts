import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionsApi } from '@/api/sessions'
import { resetDiskListingCacheForTests } from '@/hooks/useDiskConfirmedTargets'
import { resolveConversationImages } from '@/components/chat/conversationImages'
import type { UIMessage } from '@/types/chat'

const context = { sessionId: 'gallery-disk', baseUrl: 'http://127.0.0.1:3456', workDir: '/repo', imageLabel: 'Image' }
const assistant = (content: string, id = 'assistant'): UIMessage => ({ id, type: 'assistant_text', content, timestamp: 1 })
const user = (id = 'user'): UIMessage => ({ id, type: 'user_text', content: 'Compare', timestamp: 2, attachments: [
  { type: 'image', name: 'upload.png', data: 'data:image/png;base64,AAAA' },
] })

beforeEach(() => resetDiskListingCacheForTests())
afterEach(() => vi.restoreAllMocks())

describe('conversation images resolved from disk', () => {
  it('shares directory listings and keeps confirmed Chinese names in transcript order', async () => {
    const listing = vi.spyOn(sessionsApi, 'getWorkspaceTree').mockResolvedValue({
      state: 'ok', path: '', entries: ['流程图.png', '报告v2.png'].map((name) => ({ name, path: name, isDirectory: false })),
    })
    const images = await resolveConversationImages([
      assistant('已导出 流程图.png，格式选.png即可', 'first'),
      user(),
      assistant('已导出报告v2.png', 'last'),
    ], context)
    expect(images.map((image) => image.name)).toEqual(['流程图.png', 'upload.png', '报告v2.png'])
    expect(images[0]?.path).toBe('/repo/流程图.png')
    expect(images[2]?.path).toBe('/repo/报告v2.png')
    expect(listing).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'denied'] as const)('does not invent unconfirmed images when disk is %s', async (mode) => {
    const listing = vi.spyOn(sessionsApi, 'getWorkspaceTree')
    if (mode === 'denied') listing.mockRejectedValue(new Error('403'))
    else listing.mockResolvedValue({ state: 'ok', path: '', entries: [] })
    const images = await resolveConversationImages([assistant('已导出 流程图.png，格式选.png即可'), user()], context)
    expect(images.map((image) => image.name)).toEqual(['upload.png'])
  })

  it('resolves changed-file evidence within its own turn and resets it for the next turn', async () => {
    const listing = vi.spyOn(sessionsApi, 'getWorkspaceTree')
    const images = await resolveConversationImages([
      user('first-turn'), assistant('见 `chart.png`', 'first'),
      user('next-turn'), assistant('见 `chart.png`', 'next'),
    ], { ...context, changedFilesByTurnId: new Map([['first-turn', ['/repo/outputs/chart.png']]]) })
    expect(images.map((image) => image.path).filter(Boolean)).toEqual(['/repo/outputs/chart.png', '/repo/chart.png'])
    expect(listing).not.toHaveBeenCalled()
  })

  it('keeps bounded images synchronous without reading disk', () => {
    const listing = vi.spyOn(sessionsApi, 'getWorkspaceTree')
    const images = resolveConversationImages([assistant('![chart](out/chart.png)'), user()], context)
    expect(Array.isArray(images)).toBe(true)
    expect(listing).not.toHaveBeenCalled()
  })
})
