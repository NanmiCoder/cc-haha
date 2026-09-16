import { describe, expect, it } from 'bun:test'
import { extractQqPayload } from '../extract-payload.js'

const c2c = {
  kind: 'c2c',
  senderId: 'openid-1',
  senderName: 'Tester',
  content: 'hello',
  messageId: 'msg-1',
  timestamp: '2026-08-23T00:00:00Z',
}

describe('extractQqPayload', () => {
  it('flattens a private message', () => {
    expect(extractQqPayload(c2c)).toEqual({
      chatId: 'openid-1',
      userId: 'openid-1',
      displayName: 'Tester',
      text: 'hello',
      dedupKey: 'msg-1',
      attachments: [],
    })
  })

  // Pairing authorizes one person; a group message would extend that
  // authorization to every other member.
  it.each([['group'], ['guild'], ['dm']])('drops a %s message', (kind) => {
    expect(extractQqPayload({ ...c2c, kind })).toBeNull()
  })

  it('drops a message the bot itself sent', () => {
    expect(extractQqPayload({ ...c2c, senderIsBot: true })).toBeNull()
  })

  it('drops a message with no sender identity', () => {
    expect(extractQqPayload({ ...c2c, senderId: '   ' })).toBeNull()
    expect(extractQqPayload(undefined)).toBeNull()
  })

  it('keeps downloadable attachments and their order', () => {
    const payload = extractQqPayload({
      ...c2c,
      attachments: [
        { content_type: 'image/png', url: 'multimedia.example/a.png' },
        { content_type: 'application/pdf', url: 'multimedia.example/b.pdf' },
      ],
    })

    expect(payload!.attachments.map((item) => item.url)).toEqual([
      'multimedia.example/a.png',
      'multimedia.example/b.pdf',
    ])
  })

  it('drops an attachment with no URL to fetch', () => {
    const payload = extractQqPayload({ ...c2c, attachments: [{ content_type: 'image/png' }] })

    expect(payload!.attachments).toEqual([])
  })

  // A voice note is fully represented by QQ's own transcript; downloading the
  // audio would attach something the Agent cannot read.
  it('folds a voice transcript into the text and does not download the audio', () => {
    const payload = extractQqPayload({
      ...c2c,
      content: '',
      attachments: [
        { content_type: 'audio/silk', url: 'multimedia.example/v.silk', asr_refer_text: 'run the tests' },
      ],
    })

    expect(payload!.text).toBe('run the tests')
    expect(payload!.attachments).toEqual([])
  })

  it('falls back to a synthesized dedup key when the message id is absent', () => {
    const payload = extractQqPayload({ ...c2c, messageId: undefined })

    expect(payload!.dedupKey).toBe('openid-1:2026-08-23T00:00:00Z:hello')
  })

  it('falls back to a generic display name', () => {
    expect(extractQqPayload({ ...c2c, senderName: undefined })!.displayName).toBe('QQ User')
  })
})
