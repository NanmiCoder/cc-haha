import { afterEach, describe, expect, it } from 'bun:test'
import { buildClientVersion, extractWechatText, getWechatUpdates, sendWechatText, sendWechatTyping, WechatApiError, isWechatAuthenticationError } from '../protocol.js'
import { collectWechatMediaCandidates } from '../media.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('WeChat protocol helpers', () => {
  it('distinguishes known authentication failure from network and unknown protocol errors', () => {
    expect(isWechatAuthenticationError(new WechatApiError('fixture', 401))).toBe(true)
    expect(isWechatAuthenticationError(new WechatApiError('fixture', undefined, -14))).toBe(true)
    expect(isWechatAuthenticationError(new WechatApiError('fixture', 500))).toBe(false)
    expect(isWechatAuthenticationError(new WechatApiError('fixture', undefined, 99))).toBe(false)
  })
  it('encodes iLink client versions like the OpenClaw Weixin plugin', () => {
    expect(buildClientVersion('2.1.7')).toBe((2 << 16) | (1 << 8) | 7)
    expect(buildClientVersion('1.0.11')).toBe(65547)
  })

  it('extracts plain text from WeChat message items', () => {
    expect(extractWechatText([
      { type: 1, text_item: { text: 'hello' } },
    ])).toBe('hello')
  })

  it('extracts voice transcription when text items are absent', () => {
    expect(extractWechatText([
      { type: 3, voice_item: { text: 'voice text' } },
    ])).toBe('voice text')
  })

  it('preserves quoted text context', () => {
    expect(extractWechatText([
      {
        type: 1,
        text_item: { text: 'reply' },
        ref_msg: {
          title: 'quote title',
          message_item: { type: 1, text_item: { text: 'quoted body' } },
        },
      },
    ])).toBe('[引用: quote title | quoted body]\nreply')
  })

  it('collects image and file media candidates from message items', () => {
    expect(collectWechatMediaCandidates([
      {
        type: 2,
        msg_id: 'img-1',
        image_item: {
          aeskey: '00112233445566778899aabbccddeeff',
          media: {
            full_url: 'https://cdn.example.com/image',
            encrypt_query_param: 'enc=1',
          },
        },
      },
      {
        type: 4,
        msg_id: 'file-1',
        file_item: {
          file_name: 'report.pdf',
          media: {
            full_url: 'https://cdn.example.com/file',
            aes_key: Buffer.from('00112233445566778899aabbccddeeff').toString('base64'),
          },
        },
      },
    ])).toMatchObject([
      {
        kind: 'image',
        name: 'wechat-image-img-1.jpg',
        url: 'https://cdn.example.com/image',
      },
      {
        kind: 'file',
        name: 'report.pdf',
        url: 'https://cdn.example.com/file',
        mimeType: 'application/pdf',
      },
    ])
  })

  it('throws when sendmessage returns a non-zero WeChat ret code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ret: 40001, errmsg: 'bad context_token' }), { status: 200 })) as unknown as typeof fetch

    await expect(sendWechatText({
      baseUrl: 'https://api.example.com',
      token: 'token',
      to: 'user',
      text: 'hello',
      contextToken: 'stale-context',
    })).rejects.toThrow('wechatSendMessage returned 40001')
  })

  it('allows successful sendmessage responses', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    await sendWechatText({
      baseUrl: 'https://api.example.com',
      token: 'token',
      to: 'user',
      text: 'hello',
      contextToken: 'ctx',
      clientId: 'stable-fixture-id',
    })

    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!).msg.context_token).toBe('ctx')
    expect(JSON.parse(requests[0]!).msg.client_id).toBe('stable-fixture-id')
  })

  it('throws when sendtyping returns a non-zero WeChat ret code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ret: 42001, errmsg: 'typing ticket expired' }), { status: 200 })) as unknown as typeof fetch

    await expect(sendWechatTyping({
      baseUrl: 'https://api.example.com',
      token: 'token',
      ilinkUserId: 'user',
      typingTicket: 'ticket',
      status: 'typing',
    })).rejects.toThrow('wechatSendTyping returned 42001')
  })

  it('does not call a broken or rejected response a successful delivery', async () => {
    for (const body of ['', 'not JSON', 'null', '[]', '{"ret":0,"errcode":9}', '{"ret":"0"}']) {
      globalThis.fetch = (async () => new Response(body)) as typeof fetch
      await expect(sendWechatText({ baseUrl: 'https://api.example.com', token: 'fixture', to: 'peer', text: 'test' })).rejects.toThrow()
    }
  })

  it('does not turn a network abort into a healthy empty poll', async () => {
    globalThis.fetch = (async () => { throw new DOMException('aborted', 'AbortError') }) as typeof fetch
    await expect(getWechatUpdates({ baseUrl: 'https://api.example.com', token: 'fixture' })).rejects.toThrow('aborted')
  })

  it('keeps response secrets out of HTTP errors', async () => {
    globalThis.fetch = (async () => new Response('secret-context-fixture', { status: 401 })) as typeof fetch
    await expect(sendWechatText({ baseUrl: 'https://api.example.com', token: 'fixture', to: 'peer', text: 'test' })).rejects.toThrow('wechatSendMessage HTTP 401')
  })
})
