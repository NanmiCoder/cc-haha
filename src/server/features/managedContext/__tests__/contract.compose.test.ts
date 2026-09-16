/**
 * M7-B contract: the §8.3 single composition point.
 *
 * Driven through the real `ConversationService.buildUserContent` (the one place
 * the server assembles the final user string) rather than a copy of the rule, so
 * a second composition path or a dropped no-op guard fails here.
 */

import { describe, expect, it } from 'bun:test'
import {
  countManagedContextBlocks,
  composeUserContent,
  isComposedUserContent,
  MANAGED_CONTEXT_BLOCK_BEGIN,
} from '../composer.js'
import { conversationService } from '../../../services/conversationService.js'

type TextBlock = { type: string; text: string }

const service = conversationService as unknown as {
  buildUserContent(
    content: string,
    sessionId: string,
    attachments?: unknown[],
    managedContextContent?: string | null,
  ): Promise<TextBlock[]>
}

const CONTEXT = '{"hosts":[{"id":"10000000-0000-4000-8000-000000000001","name":"doc-target-1"}]}'
const BODY = 'please check the disk usage on this box'

describe('M7-B compose — no selection is a no-op', () => {
  it('returns the input string byte-identically', () => {
    const result = composeUserContent({ userText: BODY, contextText: null })
    expect(result.composed).toBe(false)
    expect(result.content).toBe(BODY)
    expect(composeUserContent({ userText: BODY, contextText: '' }).content).toBe(BODY)
    expect(composeUserContent({ userText: BODY, contextText: '   ' }).content).toBe(BODY)
  })

  it('leaves the real buildUserContent output byte-identical without context', async () => {
    const plain = await service.buildUserContent(BODY, 'session-compose-1')
    expect(JSON.stringify(plain)).toBe(JSON.stringify([{ type: 'text', text: BODY }]))
    const withNull = await service.buildUserContent(BODY, 'session-compose-1', undefined, null)
    expect(JSON.stringify(withNull)).toBe(JSON.stringify(plain))
  })
})

describe('M7-B compose — exactly one block', () => {
  it('adds the context block once and keeps the original body verbatim', async () => {
    const blocks = await service.buildUserContent(BODY, 'session-compose-2', undefined, CONTEXT)
    expect(blocks, 'image blocks are appended after the text block').toHaveLength(1)
    const text = blocks[0]!.text
    expect(countManagedContextBlocks(text)).toBe(1)
    expect(text.startsWith(MANAGED_CONTEXT_BLOCK_BEGIN)).toBe(true)
    expect(text.endsWith(BODY)).toBe(true)
    expect(text.split(BODY)).toHaveLength(2)
  })

  it('never composes a second time', async () => {
    const once = await service.buildUserContent(BODY, 'session-compose-3', undefined, CONTEXT)
    const twice = await service.buildUserContent(
      once[0]!.text,
      'session-compose-3',
      undefined,
      CONTEXT,
    )
    expect(countManagedContextBlocks(twice[0]!.text)).toBe(1)
    expect(twice[0]!.text).toBe(once[0]!.text)
    expect(isComposedUserContent(once[0]!.text, CONTEXT)).toBe(true)
  })

  it('keeps attachment content beside the single block', async () => {
    const attachment = { type: 'file', path: 'C:/tmp/managed-context-attachment.txt' }
    const blocks = await service.buildUserContent(BODY, 'session-compose-4', [attachment], CONTEXT)
    const text = blocks[0]!.text
    expect(countManagedContextBlocks(text)).toBe(1)
    expect(text).toContain('@"C:/tmp/managed-context-attachment.txt"')
    expect(text).toContain(BODY)
  })

  it('is deterministic for the same inputs', () => {
    const a = composeUserContent({ userText: BODY, contextText: CONTEXT })
    const b = composeUserContent({ userText: BODY, contextText: CONTEXT })
    expect(a.content).toBe(b.content)
    expect(a.composed).toBe(true)
  })
})
