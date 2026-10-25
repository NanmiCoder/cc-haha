import { describe, expect, test } from 'bun:test'
import { resolveDeepSeekMediaEndpoint } from './deepseek.js'

const DATA = 'aW1hZ2U='
const DATA_URL = `data:image/png;base64,${DATA}`
const anthropicImage = () => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: DATA },
})
const chatImage = () => ({ type: 'image_url', image_url: { url: DATA_URL } })
const responsesImage = () => ({ type: 'input_image', image_url: DATA_URL })
const endpoint = (path: string) => resolveDeepSeekMediaEndpoint(new URL(`https://api.deepseek.com${path}`))!

describe('DeepSeek media endpoint capabilities', () => {
  test.each([
    '/anthropic/v1/messages', '/anthropic/v1/messages/',
    '/chat/completions', '/chat/completions/', '/v1/chat/completions',
    '/responses', '/responses/', '/v1/responses',
  ])('recognizes the documented request path %s', path => {
    expect(endpoint(path)).toMatchObject({
      providerId: 'deepseek',
      uploadUrl: 'https://api.deepseek.com/files',
      triggerBytes: 40 * 1024 * 1024,
      targetBytes: 32 * 1024 * 1024,
      maxFileBytes: 64 * 1024 * 1024,
      expiresAfterSeconds: 86400,
    })
    expect(endpoint(path).betaHeader).toBe(path.startsWith('/anthropic/') ? 'files-api-2025-04-14' : undefined)
  })

  test.each([
    'http://api.deepseek.com/chat/completions',
    'https://api.deepseek.com:444/chat/completions',
    'https://api.deepseek.com.evil.example/chat/completions',
    'https://api.deepseek.com@evil.example/chat/completions',
    'https://evil.example@api.deepseek.com/chat/completions',
    'https://user:password@api.deepseek.com/chat/completions',
    'https://api.deepseek.com./chat/completions',
    'https://gateway.example/deepseek/chat/completions',
    'https://api.deepseek.com/files',
    'https://api.deepseek.com/v1/messages',
    'https://api.deepseek.com/anthropic/v1/messages/extra',
    'https://api.deepseek.com/chat/completions//',
  ])('does not enable uploads for %s', url => {
    expect(resolveDeepSeekMediaEndpoint(new URL(url))).toBeUndefined()
  })

  test.each(['deepseek-chat', 'deepseek-reasoner', 'deepseek-pro', 'vendor/deepseek-flash', '', undefined])(
    'does not change unsupported model %s', model => {
      const body = { model, messages: [{ role: 'user', content: [chatImage()] }] }
      const before = JSON.stringify(body)
      expect(endpoint('/chat/completions').collectImages(body)).toEqual([])
      expect(JSON.stringify(body)).toBe(before)
    },
  )

  test.each(['deepseek-flash', 'deepseek-v4-flash-vision-exp'])('accepts vision model %s', model => {
    expect(endpoint('/chat/completions').collectImages({
      model, messages: [{ role: 'user', content: [chatImage()] }],
    })).toHaveLength(1)
  })
})

describe('DeepSeek wire image conversion', () => {
  test('converts Anthropic user and tool-result images without rewriting text, tools, or cache metadata', () => {
    const first = { ...anthropicImage(), cache_control: { type: 'ephemeral' } }
    const toolImage = anthropicImage()
    const fileImage = { type: 'image', source: { type: 'file', file_id: 'file-existing' } }
    const remoteImage = { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }
    const body = {
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: [first, { type: 'tool_result', tool_use_id: 'read-1', content: [toolImage] }, fileImage, remoteImage] },
        { role: 'assistant', content: [anthropicImage(), { type: 'tool_use', input: { content: [anthropicImage()] } }] },
        { role: 'system', content: [anthropicImage()] },
      ],
      tools: [{ input_schema: { content: [anthropicImage()] } }],
    }
    const before = structuredClone(body)
    const images = endpoint('/anthropic/v1/messages').collectImages(body)
    expect(images.map(({ data, mediaType }) => ({ data, mediaType }))).toEqual([
      { data: DATA, mediaType: 'image/png' }, { data: DATA, mediaType: 'image/png' },
    ])
    expect(body).toEqual(before)
    images[0]!.replace('file-user')
    images[1]!.replace('file-tool')
    expect(first).toEqual({ type: 'image', source: { type: 'file', file_id: 'file-user' }, cache_control: { type: 'ephemeral' } })
    expect(toolImage).toEqual({ type: 'image', source: { type: 'file', file_id: 'file-tool' } })
    expect(body.messages.slice(1)).toEqual(before.messages.slice(1))
    expect(body.messages[0]!.content.slice(2)).toEqual(before.messages[0]!.content.slice(2))
    expect(body.tools).toEqual(before.tools)
    expect(endpoint('/anthropic/v1/messages').collectImages(body)).toEqual([])
  })

  test('converts Chat images to the DeepSeek file block without interpreting tool arguments', () => {
    const image = chatImage()
    const body = {
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: [image, { type: 'text', text: JSON.stringify(chatImage()) }, { type: 'file', file_id: 'file-existing' }] },
        { role: 'assistant', content: [chatImage()], tool_calls: [{ function: { arguments: JSON.stringify(chatImage()) } }] },
        { role: 'tool', content: [chatImage()] },
      ],
    }
    const before = structuredClone(body)
    const images = endpoint('/v1/chat/completions').collectImages(body)
    expect(images).toHaveLength(1)
    images[0]!.replace('file-new')
    expect(image).toEqual({ type: 'file', file_id: 'file-new' })
    expect(body.messages[0]!.content.slice(1)).toEqual(before.messages[0]!.content.slice(1))
    expect(body.messages.slice(1)).toEqual(before.messages.slice(1))
  })

  test('converts Responses user/developer and tool-output images with mutually exclusive image_url/file_id', () => {
    const userImage = { ...responsesImage(), detail: 'original' }
    const developerImage = responsesImage()
    const functionImage = responsesImage()
    const customImage = responsesImage()
    const body = {
      model: 'deepseek-flash',
      input: [
        { role: 'user', content: [userImage, { type: 'input_image', file_id: 'file-existing' }] },
        { type: 'message', role: 'developer', content: [developerImage] },
        { type: 'function_call_output', call_id: '1', output: [functionImage] },
        { type: 'custom_tool_call_output', call_id: '2', output: [customImage] },
        { role: 'system', content: [responsesImage()] },
        { role: 'assistant', content: [responsesImage()] },
        { type: 'function_call', arguments: JSON.stringify(responsesImage()), content: [responsesImage()], role: 'user' },
        { type: 'function_call_output', output: JSON.stringify([responsesImage()]) },
      ],
    }
    const before = structuredClone(body)
    const images = endpoint('/v1/responses').collectImages(body)
    expect(images).toHaveLength(4)
    images.forEach((image, index) => image.replace(`file-${index}`))
    expect(userImage).toEqual({ type: 'input_image', file_id: 'file-0', detail: 'original' })
    expect(developerImage).toEqual({ type: 'input_image', file_id: 'file-1' })
    expect(functionImage).toEqual({ type: 'input_image', file_id: 'file-2' })
    expect(customImage).toEqual({ type: 'input_image', file_id: 'file-3' })
    expect(body.input[0]!.content![1]).toEqual({ type: 'input_image', file_id: 'file-existing' })
    expect(body.input.slice(4)).toEqual(before.input.slice(4))
    expect(endpoint('/responses').collectImages(body)).toEqual([])
  })

  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('accepts supported media type %s', mediaType => {
    const body = {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mediaType};base64,${DATA}` } }] }],
    }
    expect(endpoint('/chat/completions').collectImages(body)[0]?.mediaType).toBe(mediaType)
  })

  test.each([
    'https://example.com/image.png',
    'data:application/pdf;base64,aW1hZ2U=',
    'data:image/svg+xml;base64,aW1hZ2U=',
    'data:image/png;charset=utf-8;base64,aW1hZ2U=',
    'data:image/png,aW1hZ2U=',
    'data:image/png;base64,',
    'data:image/png;base64,%%%%',
    'data:image/png;base64,a===',
    'data:image/png;base64,a=bc',
    'data:image/png;base64,aW1hZ2U',
  ])('leaves unsupported or malformed input unchanged: %s', url => {
    const body = { model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] }
    const before = structuredClone(body)
    expect(endpoint('/chat/completions').collectImages(body)).toEqual([])
    expect(body).toEqual(before)
  })

  test('ignores malformed JSON shapes and non-image content without throwing', () => {
    for (const path of ['/anthropic/v1/messages', '/chat/completions', '/responses']) {
      expect(endpoint(path).collectImages({ model: 'deepseek-flash', messages: [null, {}, { role: 'user', content: [null, 'text', {}, { type: 'image', source: null }] }], input: [null, {}, { role: 'user', content: [null, 'text'] }] })).toEqual([])
      expect(endpoint(path).collectImages({ model: 'deepseek-flash', messages: 'text', input: 'text' })).toEqual([])
    }
  })

  test.each([
    ['/anthropic/v1/messages', anthropicImage()],
    ['/chat/completions', chatImage()],
    ['/responses', responsesImage()],
  ])('reports the exact outbound UTF-8 byte reduction for %s', (path, image) => {
    const block = { ...image, extra: '保留元数据🌍', cache_control: { type: 'ephemeral' } }
    const message = { role: 'user', content: [block] }
    const body = { model: 'deepseek-flash', ...(path === '/responses' ? { input: [message] } : { messages: [message] }) }
    const beforeBytes = Buffer.byteLength(JSON.stringify(body))
    const [candidate] = endpoint(path).collectImages(body)
    const reduction = candidate!.replace('file-\"escaped\"-图片')
    expect(reduction).toBe(beforeBytes - Buffer.byteLength(JSON.stringify(body)))
    expect(block.extra).toBe('保留元数据🌍')
    expect(block.cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('DeepSeek Files API contract', () => {
  test('partitions cached files by all supplied credentials without depending on inference headers', () => {
    const adapter = endpoint('/anthropic/v1/messages')
    expect(adapter.credentialScope(new Headers())).toBeUndefined()
    expect(adapter.credentialScope(new Headers({ 'x-api-key': 'fake-key-a' }))).toBe(JSON.stringify(['', '', 'fake-key-a']))
    expect(adapter.credentialScope(new Headers({ 'x-dsh-auth-token': 'fake-login' }))).not.toBe(adapter.credentialScope(new Headers({ authorization: 'fake-login' })))
    expect(adapter.credentialScope(new Headers({ 'x-api-key': 'fake-key-a' }))).not.toBe(adapter.credentialScope(new Headers({ 'x-api-key': 'fake-key-b' })))
    expect(adapter.credentialScope(new Headers({ 'x-api-key': 'fake-key-a', 'content-type': 'application/json' }))).toBe(adapter.credentialScope(new Headers({ 'x-api-key': 'fake-key-a' })))
  })

  test.each([
    [{ 'x-api-key': 'fake-key' }, { authorization: 'Bearer fake-key' }],
    [{ authorization: 'Bearer fake-token', 'x-api-key': 'placeholder' }, { authorization: 'Bearer fake-token' }],
    [{ 'x-dsh-auth-token': 'fake-login', authorization: 'Bearer placeholder', 'x-api-key': 'placeholder' }, { 'x-dsh-auth-token': 'fake-login' }],
  ])('uses only the selected upload credential: %j', (credentials, expected) => {
    const input = new Headers({
      ...credentials,
      'content-type': 'application/json',
      'content-length': '123456',
      'anthropic-beta': 'other-beta',
      'x-request-signature': 'inference-only',
      cookie: 'unrelated=true',
    })
    const before = [...input.entries()]
    const upload = endpoint('/anthropic/v1/messages').createUpload(new Uint8Array([1]), 'image/png', input)
    expect(Object.fromEntries(upload.headers.entries())).toEqual(expected)
    expect([...input.entries()]).toEqual(before)
  })

  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('uploads original %s bytes with explicit one-day expiry', async mediaType => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255])
    const upload = endpoint('/chat/completions').createUpload(bytes, mediaType, new Headers({ authorization: 'Bearer fake-token' }))
    expect(upload.body).toBeInstanceOf(FormData)
    const body = upload.body as FormData
    expect(body.get('purpose')).toBe('user_data')
    expect(body.get('expires_after[anchor]')).toBe('created_at')
    expect(body.get('expires_after[seconds]')).toBe('86400')
    const file = body.get('file') as File
    expect(file.name).toBe(`image.${mediaType.slice('image/'.length)}`)
    expect(file.type).toBe(mediaType)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  })

  test('parses documented upload results and optional server expiry', () => {
    const adapter = endpoint('/chat/completions')
    expect(adapter.parseUpload({ id: 'file-api-one', expires_at: 1700003600 })).toEqual({ id: 'file-api-one', expiresAt: 1700003600000 })
    expect(adapter.parseUpload({ id: 'file-api-one' })).toEqual({ id: 'file-api-one' })
  })

  test.each([null, [], {}, { id: '' }, { id: '   ' }, { id: 12 }, { id: 'x'.repeat(513) }, { id: 'file-id', expires_at: '1700003600' }, { id: 'file-id', expires_at: NaN }, { id: 'file-id', expires_at: Infinity }].map(value => [value]))(
    'rejects malformed upload response %j', value => {
      expect(endpoint('/responses').parseUpload(value)).toBeUndefined()
    },
  )
})
