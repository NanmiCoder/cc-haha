import { expect, test } from 'bun:test'
import { appendPendingUserMessage, chatReducer, createChatState, normalizeHistory } from './chat'
import type { ChatItem } from './types'

// Keep the server's separate TypeScript project outside the mobile compiler,
// while exercising its actual parser at test runtime.
const { extractReplayUserText } = await import(
  new URL('../../../src/server/ws/cliMessageParsing.ts', import.meta.url).href
) as { extractReplayUserText(message: unknown): string | null }

const source = '/tmp/fixture/uploads/session/00000000-0000-0000-0000-000000000000-photo.png'
const image = { type: 'image' as const, name: 'photo.png', data: 'aGk=', mimeType: 'image/png' }
// ConversationService.buildUserContent emits prompt, inline images, then one
// metadata text block per image. Use the real WS extractor, not a fake replay.
const imageBlock = (data = image.data, mediaType = image.mimeType) => ({
  type: 'image', source: { type: 'base64', media_type: mediaType, data },
})
const textBlock = (text: string) => ({ type: 'text', text })
const replay = (blocks: unknown[]) => extractReplayUserText({
  type: 'user', isReplay: true, message: { content: blocks },
})!
const history = (blocks: unknown[]) => normalizeHistory([{
  id: 'image-turn', type: 'user', content: blocks, timestamp: '2026-10-24T04:00:00Z',
}])
const send = (prompt: string, attachments: ChatItem['attachments'], blocks: unknown[]) =>
  chatReducer(appendPendingUserMessage(createChatState('session'), prompt, attachments), {
    type: 'user_message_replay', content: replay(blocks),
  })

test('real inline-image replay confirms one bubble, preserving bytes and its staged source', () => {
  for (const prompt of ['', 'Describe this image.']) {
    const blocks = [textBlock(prompt || 'Please analyze the attached image.'), imageBlock(), textBlock(`[Image: source: ${source}]`)]
    const state = send(prompt, [image], blocks)
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ text: prompt, pending: false, delivery: 'confirmed', attachments: [{ ...image, path: source }] })
    const saved = history(blocks)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ text: prompt, sourceMessageId: 'image-turn', attachments: [{ ...image, path: source }] })
    expect(saved[0].editableText).toBeUndefined()
  }
})

test('multiple image source paths keep their order alongside uploaded file references', () => {
  const second = { ...image, name: 'second.jpeg', data: 'Ynll', mimeType: 'image/jpeg' }
  const windowsPath = 'C:\\Users\\fixture\\uploads\\session\\second.jpeg'
  const blocks = [
    textBlock('@"/tmp/fixture/uploads/session/notes.txt" Compare'), imageBlock(), imageBlock(second.data, second.mimeType),
    textBlock(`[Image: source: ${source}, original 1024x768, displayed at 512x384. Multiply coordinates by 2.00 to map to original image.]`),
    textBlock(`[Image source: ${windowsPath}]`),
  ]
  const state = send('Compare', [{ type: 'file', name: 'notes.txt', path: '/tmp/fixture/uploads/session/notes.txt' }, image, second], blocks)
  expect(state.items).toHaveLength(1)
  expect(state.items[0].attachments?.map(item => item.path)).toEqual(['/tmp/fixture/uploads/session/notes.txt', source, windowsPath])
  const saved = history(blocks)
  expect(saved).toHaveLength(1)
  expect(saved[0].text).toBe('Compare')
  expect(saved[0].attachments).toEqual([
    { type: 'file', name: 'notes.txt', path: '/tmp/fixture/uploads/session/notes.txt' },
    { ...image, path: source }, { ...second, path: windowsPath },
  ])
})

test('plain user text resembling metadata is never stripped without actual image evidence', () => {
  for (const prompt of [`[Image source: ${source}]`, `Explain this:\n[Image: source: ${source}]`]) {
    const blocks = [textBlock(prompt)]
    expect(send(prompt, undefined, blocks).items[0].text).toBe(prompt)
    expect(history(blocks)[0].text).toBe(prompt)
    const otherClient = chatReducer(createChatState('session'), { type: 'user_message_replay', content: prompt })
    expect(otherClient.items[0].text).toBe(prompt)
  }
})

test('image-bearing authored text is preserved while only the appended metadata suffix is removed', () => {
  const prompt = '[Image source: /tmp/a-user-quoted-example.png]'
  const blocks = [textBlock(prompt), imageBlock(), textBlock(`[Image source: ${source}]`)]
  const state = send(prompt, [image], blocks)
  expect(state.items).toHaveLength(1)
  expect(state.items[0].text).toBe(prompt)
  expect(history(blocks)[0].text).toBe(prompt)
  expect(history(blocks)).toHaveLength(1)
})

test('resize-only generated metadata is hidden, but similar malformed text stays visible', () => {
  const blocks = [textBlock('Look'), imageBlock(), textBlock('[Image: original 800x600, displayed at 400x300. Multiply coordinates by 2 to map to original image.]')]
  expect(send('Look', [image], blocks).items).toHaveLength(1)
  expect(history(blocks)).toHaveLength(1)
  expect(history(blocks)[0].text).toBe('Look')
  const malformed = '[Image: source: /tmp/example.png] do not remove this'
  const ordinary = [textBlock('Look'), imageBlock(), textBlock(malformed)]
  expect(history(ordinary)[0].text).toBe(`Look\n${malformed}`)
})
