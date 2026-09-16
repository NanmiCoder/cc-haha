import { describe, expect, it } from 'bun:test'
import {
  extractWecomPayload,
  extractWecomQuoteText,
  extractWecomText,
} from '../extract-payload.js'

describe('extractWecomText', () => {
  it('reads a plain text message', () => {
    expect(extractWecomText({ msgtype: 'text', text: { content: ' hello ' } })).toBe('hello')
  })

  // WeCom transcribes voice server-side, so the text path — not the attachment
  // path — is where a voice note belongs.
  it('reads the transcript of a voice message', () => {
    expect(extractWecomText({ msgtype: 'voice', voice: { content: 'read the readme' } }))
      .toBe('read the readme')
  })

  it('joins the text items of a mixed message and ignores the images', () => {
    expect(
      extractWecomText({
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: 'look at this' } },
            { msgtype: 'image', text: undefined },
            { msgtype: 'text', text: { content: 'and this' } },
          ],
        },
      }),
    ).toBe('look at this\nand this')
  })

  it('returns an empty string for a body with no text at all', () => {
    expect(extractWecomText({ msgtype: 'image' })).toBe('')
    expect(extractWecomText(undefined)).toBe('')
  })
})

describe('extractWecomQuoteText', () => {
  it('reads the quoted message so the Agent sees what the user replied to', () => {
    expect(
      extractWecomQuoteText({ quote: { msgtype: 'text', text: { content: 'earlier answer' } } }),
    ).toBe('earlier answer')
  })

  it('returns an empty string when nothing was quoted', () => {
    expect(extractWecomQuoteText({ msgtype: 'text', text: { content: 'x' } })).toBe('')
  })
})

describe('extractWecomPayload', () => {
  const single = {
    msgid: 'msg-1',
    chattype: 'single' as const,
    from: { userid: 'zhangsan' },
    msgtype: 'text',
    text: { content: 'hello' },
  }

  it('routes a 1:1 chat by the sender userid', () => {
    expect(extractWecomPayload(single)).toEqual({
      chatId: 'zhangsan',
      userId: 'zhangsan',
      text: 'hello',
      dedupKey: 'msg-1',
    })
  })

  // Pairing authorizes a person. Answering in a group would hand that person's
  // authorization to everyone else in the room.
  it('drops a group message, whatever else it carries', () => {
    expect(extractWecomPayload({ ...single, chattype: 'group', chatid: 'room-1' })).toBeNull()
    expect(extractWecomPayload({ ...single, chattype: 'group' })).toBeNull()
  })

  it('drops a message with no sender identity to authorize', () => {
    expect(extractWecomPayload({ ...single, from: {} })).toBeNull()
    expect(extractWecomPayload(undefined)).toBeNull()
  })

  it('prefixes the quoted text so the reply keeps its context', () => {
    const payload = extractWecomPayload({
      ...single,
      quote: { msgtype: 'text', text: { content: 'line one\nline two' } },
    })

    expect(payload!.text).toBe('> line one\n> line two\n\nhello')
  })

  it('falls back to a synthesized dedup key when msgid is absent', () => {
    const payload = extractWecomPayload({ ...single, msgid: undefined, create_time: 1700 })

    expect(payload!.dedupKey).toBe('zhangsan:1700:hello')
  })
})
