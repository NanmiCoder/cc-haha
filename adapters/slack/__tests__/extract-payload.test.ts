import { describe, expect, it } from 'bun:test'
import { extractSlackPayload } from '../extract-payload.js'

const dm = {
  type: 'message',
  channel: 'D123',
  channel_type: 'im',
  user: 'U123',
  text: 'hello',
  ts: '1700000000.000100',
  client_msg_id: 'cmid-1',
}

describe('extractSlackPayload', () => {
  it('flattens a direct message', () => {
    expect(extractSlackPayload(dm)).toEqual({
      chatId: 'D123',
      userId: 'U123',
      text: 'hello',
      dedupKey: 'cmid-1',
      threadTs: undefined,
      files: [],
    })
  })

  // Slack pushes edits, deletions, joins and the bot's own replies down the
  // same socket; answering any of them is at best noise and at worst a loop.
  // `file_share` is deliberately absent here — it carries a real user message.
  it.each([
    [{ subtype: 'message_changed' }, 'an edit'],
    [{ subtype: 'message_deleted' }, 'a deletion'],
    [{ subtype: 'channel_join' }, 'a join'],
    [{ hidden: true }, 'a hidden event'],
    [{ bot_id: 'B999' }, 'a bot message'],
    [{ type: 'app_mention' }, 'a non-message event'],
  ])('drops %o (%s)', (overrides) => {
    expect(extractSlackPayload({ ...dm, ...overrides })).toBeNull()
  })

  it('drops its own user id even when Slack omits bot_id', () => {
    expect(extractSlackPayload(dm, { botUserId: 'U123' })).toBeNull()
    expect(extractSlackPayload(dm, { botUserId: 'U999' })).not.toBeNull()
  })

  // Pairing authorizes one person; a channel would extend that authorization
  // to everyone else in it.
  it.each([['channel'], ['group'], ['mpim']])('drops a %s message', (channelType) => {
    expect(extractSlackPayload({ ...dm, channel_type: channelType })).toBeNull()
  })

  // Slack escapes these three characters in every message. Leaving them encoded
  // corrupts shell commands, comparisons, JSX and generics for a coding agent.
  it('decodes the HTML entities Slack escapes', () => {
    const payload = extractSlackPayload({
      ...dm,
      text: 'run `a &amp;&amp; b` when x &lt; y &gt; z',
    })

    expect(payload!.text).toBe('run `a && b` when x < y > z')
  })

  it('does not double-decode an escaped entity', () => {
    expect(extractSlackPayload({ ...dm, text: '&amp;lt;not-a-tag&amp;gt;' })!.text)
      .toBe('&lt;not-a-tag&gt;')
  })

  it('strips Slack markup so the Agent sees plain text', () => {
    const payload = extractSlackPayload({
      ...dm,
      text: '<@U999> check <https://example.com|the docs> in <#C1|general>',
    })

    expect(payload!.text).toBe('check the docs in #general')
  })

  it('keeps a bare link readable', () => {
    expect(extractSlackPayload({ ...dm, text: 'see <https://example.com/x>' })!.text)
      .toBe('see https://example.com/x')
  })

  // Slack delivers a DM with an attachment as subtype `file_share`. Treating
  // every subtype as noise dropped the file *and* the caption typed with it,
  // so the bot never answered a message containing a screenshot at all.
  it('accepts a file upload, which Slack sends as subtype file_share', () => {
    const payload = extractSlackPayload({
      ...dm,
      subtype: 'file_share',
      text: 'have a look',
      files: [{ id: 'F1', name: 'a.png', url_private_download: 'https://files.slack.com/x' }],
    })

    expect(payload).not.toBeNull()
    expect(payload!.text).toBe('have a look')
    expect(payload!.files).toHaveLength(1)
  })

  it('accepts a file-only message with no caption', () => {
    const payload = extractSlackPayload({
      ...dm,
      subtype: 'file_share',
      text: '',
      files: [{ id: 'F1', name: 'a.png', url_private_download: 'https://files.slack.com/x' }],
    })

    expect(payload!.text).toBe('')
    expect(payload!.files).toHaveLength(1)
  })

  it('drops a file with no downloadable URL', () => {
    const payload = extractSlackPayload({ ...dm, files: [{ id: 'F1', name: 'a.png' }] })

    expect(payload!.files).toEqual([])
  })

  it('drops a message that carries neither text nor a usable file', () => {
    expect(extractSlackPayload({ ...dm, text: '   ', files: [{ id: 'F1' }] })).toBeNull()
  })

  it('falls back to channel and timestamp when client_msg_id is absent', () => {
    expect(extractSlackPayload({ ...dm, client_msg_id: undefined })!.dedupKey)
      .toBe('D123:1700000000.000100')
  })

  it('carries the thread timestamp through', () => {
    expect(extractSlackPayload({ ...dm, thread_ts: '1699999999.000100' })!.threadTs)
      .toBe('1699999999.000100')
  })
})
