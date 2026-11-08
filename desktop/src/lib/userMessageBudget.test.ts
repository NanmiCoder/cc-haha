import { describe, expect, it } from 'vitest'
import { checkUserMessageBudget, USER_MESSAGE_MAX_BYTES } from './userMessageBudget'

const base64 = (chars: number) => `data:image/png;base64,${'A'.repeat(chars)}`

describe('checkUserMessageBudget', () => {
  it('accepts an ordinary message with a small pasted image', () => {
    expect(checkUserMessageBudget({
      type: 'user_message',
      content: 'what is this?',
      attachments: [{ type: 'image', name: 'shot.png', data: base64(1024) }],
    })).toEqual({ ok: true })
  })

  it('reports the serialized size of a frame over the server budget', () => {
    // Two 4K screenshots pasted as bitmaps: each is a ~10 MB PNG, ~13 MB once
    // base64-encoded, and the frame carries both.
    const message = {
      type: 'user_message' as const,
      content: 'compare these',
      attachments: [
        { type: 'image' as const, name: 'one.png', data: base64(13 * 1024 * 1024) },
        { type: 'image' as const, name: 'two.png', data: base64(13 * 1024 * 1024) },
      ],
    }
    const result = checkUserMessageBudget(message)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.limit).toBe(USER_MESSAGE_MAX_BYTES)
    expect(result.bytes).toBe(new TextEncoder().encode(JSON.stringify(message)).byteLength)
  })

  it('counts UTF-8 bytes rather than string length', () => {
    // 6 Mi code units of CJK text serialize to 18 MB of UTF-8: over budget.
    expect(checkUserMessageBudget({ type: 'user_message', content: '字'.repeat(6 * 1024 * 1024) }).ok).toBe(false)
    // The same number of ASCII code units is 6 MB: the three-byte estimate
    // is pessimistic, so the exact count decides and the message still goes.
    expect(checkUserMessageBudget({ type: 'user_message', content: 'a'.repeat(6 * 1024 * 1024) })).toEqual({ ok: true })
  })

  it('keeps a frame exactly at the budget sendable', () => {
    const envelope = JSON.stringify({ type: 'user_message', content: '' }).length
    const content = 'a'.repeat(USER_MESSAGE_MAX_BYTES - envelope)
    expect(checkUserMessageBudget({ type: 'user_message', content })).toEqual({ ok: true })
    expect(checkUserMessageBudget({ type: 'user_message', content: `${content}a` })).toMatchObject({
      ok: false,
      bytes: USER_MESSAGE_MAX_BYTES + 1,
    })
  })
})
