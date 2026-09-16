import { describe, expect, it } from 'bun:test'
import {
  assertSlackFileUrl,
  assertSlackUploadUrl,
  SlackApiClient,
  SlackApiError,
} from '../api.js'

type Recorded = {
  url: string
  method: string
  authorization?: string
  body?: string
}

function fakeFetch(responses: Array<{ status?: number; body: unknown }>, calls: Recorded[] = []) {
  let index = 0
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined)
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const response = responses[Math.min(index, responses.length - 1)]!
    index += 1
    const payload = response.body
    return new Response(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      { status: response.status ?? 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('SlackApiClient.call', () => {
  it('sends the bot token and returns the parsed body', async () => {
    const { impl, calls } = fakeFetch([{ body: { ok: true, ts: '1.1' } }])
    const client = new SlackApiClient('xoxb-test', impl)

    const ts = await client.postMessage('D1', 'hi')

    expect(ts).toBe('1.1')
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage')
    expect(calls[0]!.authorization).toBe('Bearer xoxb-test')
    expect(JSON.parse(calls[0]!.body!)).toEqual({ channel: 'D1', text: 'hi' })
  })

  // Slack answers HTTP 200 with `ok: false`; treating that as success is the
  // classic way an integration silently stops delivering.
  it('throws on an ok:false body even though the HTTP status is 200', async () => {
    const { impl } = fakeFetch([{ body: { ok: false, error: 'not_in_channel' } }])
    const client = new SlackApiClient('xoxb-test', impl)

    await expect(client.postMessage('D1', 'hi')).rejects.toThrow(SlackApiError)
    await expect(client.postMessage('D1', 'hi')).rejects.toThrow(/not_in_channel/)
  })

  it('throws when the response is not JSON at all', async () => {
    const { impl } = fakeFetch([{ status: 502, body: 'gateway down' }])
    const client = new SlackApiClient('xoxb-test', impl)

    await expect(client.postMessage('D1', 'hi')).rejects.toThrow(/http_502/)
  })

  it('reports a post that returns no timestamp instead of pretending it worked', async () => {
    const { impl } = fakeFetch([{ body: { ok: true } }])
    const client = new SlackApiClient('xoxb-test', impl)

    await expect(client.postMessage('D1', 'hi')).rejects.toThrow(/missing_ts/)
  })

  it('threads a reply when a thread timestamp is supplied', async () => {
    const { impl, calls } = fakeFetch([{ body: { ok: true, ts: '2.2' } }])
    const client = new SlackApiClient('xoxb-test', impl)

    await client.postMessage('D1', 'hi', '1.0')

    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ thread_ts: '1.0' })
  })
})

describe('SlackApiClient.openSocketConnection', () => {
  it('uses the app-level token, not the bot token', async () => {
    const { impl, calls } = fakeFetch([{ body: { ok: true, url: 'wss://wss.slack.com/link/1' } }])
    const client = new SlackApiClient('xoxb-test', impl)

    const url = await client.openSocketConnection('xapp-test')

    expect(url).toBe('wss://wss.slack.com/link/1')
    expect(calls[0]!.authorization).toBe('Bearer xapp-test')
  })

  it('refuses a socket URL that is not wss', async () => {
    const { impl } = fakeFetch([{ body: { ok: true, url: 'ws://wss.slack.com/link/1' } }])
    const client = new SlackApiClient('xoxb-test', impl)

    await expect(client.openSocketConnection('xapp-test')).rejects.toThrow(/insecure/)
  })
})

describe('Slack file URL pinning', () => {
  // The bot token travels on the download, and the URL arrives inside an event
  // payload — so an unpinned host is a credentialed request anyone in the
  // workspace could steer.
  it.each([
    ['http://files.slack.com/files-pri/a', 'plain http'],
    ['https://evil.example.com/files-pri/a', 'foreign host'],
    ['https://user:pw@files.slack.com/files-pri/a', 'embedded credentials'],
    ['https://files.slack.com:8443/files-pri/a', 'non-default port'],
  ])('rejects a download URL: %s (%s)', (value) => {
    expect(() => assertSlackFileUrl(value)).toThrow()
  })

  it('accepts a genuine Slack file URL and drops its fragment', () => {
    expect(assertSlackFileUrl('https://files.slack.com/files-pri/T1-F1/a.png#frag').toString())
      .toBe('https://files.slack.com/files-pri/T1-F1/a.png')
  })

  it('rejects a missing download URL', () => {
    expect(() => assertSlackFileUrl(undefined)).toThrow(/no download URL/)
  })

  it('pins the upload URL to the same host', () => {
    expect(() => assertSlackUploadUrl('https://evil.example.com/upload/x')).toThrow(/unsafe/)
    expect(assertSlackUploadUrl('https://files.slack.com/upload/x').hostname).toBe('files.slack.com')
  })
})

describe('SlackApiClient.uploadFile', () => {
  it('reserves a URL, PUTs the bytes and then publishes the file', async () => {
    const { impl, calls } = fakeFetch(
      [
        { body: { ok: true, upload_url: 'https://files.slack.com/upload/abc', file_id: 'F1' } },
        { body: { ok: true } },
        { body: { ok: true } },
      ],
    )
    const client = new SlackApiClient('xoxb-test', impl)

    await client.uploadFile({
      channel: 'D1',
      buffer: Buffer.from('bytes'),
      filename: 'a.png',
      title: 'alt text',
    })

    expect(calls[0]!.url).toContain('files.getUploadURLExternal')
    expect(calls[0]!.url).toContain('length=5')
    expect(calls[1]!.url).toBe('https://files.slack.com/upload/abc')
    expect(calls[2]!.url).toContain('files.completeUploadExternal')
    expect(JSON.parse(calls[2]!.body!)).toMatchObject({
      channel_id: 'D1',
      files: [{ id: 'F1', title: 'alt text' }],
    })
  })

  it('refuses to PUT bytes to an upload URL Slack did not vouch for', async () => {
    const { impl } = fakeFetch([
      { body: { ok: true, upload_url: 'https://evil.example.com/upload/abc', file_id: 'F1' } },
    ])
    const client = new SlackApiClient('xoxb-test', impl)

    await expect(
      client.uploadFile({ channel: 'D1', buffer: Buffer.from('x'), filename: 'a.png' }),
    ).rejects.toThrow(/unsafe/)
  })
})

describe('SlackApiClient.downloadFile', () => {
  it('attaches the bot token to the file request', async () => {
    const calls: Recorded[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined)
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization') ?? undefined,
      })
      return new Response('file-bytes', { status: 200 })
    }) as unknown as typeof fetch
    const client = new SlackApiClient('xoxb-test', impl)

    const buffer = await client.downloadFile('https://files.slack.com/files-pri/T1-F1/a.png')

    expect(buffer.toString('utf8')).toBe('file-bytes')
    expect(calls[0]!.authorization).toBe('Bearer xoxb-test')
  })

  it('surfaces a failed download instead of returning empty bytes', async () => {
    const impl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const client = new SlackApiClient('xoxb-test', impl)

    await expect(client.downloadFile('https://files.slack.com/files-pri/T1-F1/a.png'))
      .rejects.toThrow(/404/)
  })
})
