import { describe, expect, test } from 'bun:test'

import type { ImageGenerationRuntimeConfig } from '../../services/imageGeneration/config.js'
import type { PreparedInputImage } from './backend.js'
import {
  applyOpenAIImageRequestContract,
  buildGeminiImageRequestBody,
  buildGeminiImageUrl,
  buildImagesProtocolUrl,
  buildProtocolImageRequests,
  buildXaiEditRequestBody,
  buildXaiRequestBody,
  parseGeminiImageResponse,
} from './providerProtocols.js'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')
const source: PreparedInputImage = {
  mimeType: 'image/png',
  dataUrl: `data:image/png;base64,${PNG_BASE64}`,
  fileName: 'cat.png',
  bytes: PNG_BYTES,
}
const nativeConfig: ImageGenerationRuntimeConfig = {
  kind: 'openai_images',
  protocol: 'gemini_native',
  providerId: 'relay',
  model: 'nana-banana-2',
  baseUrl: 'https://relay.example.test',
  apiKey: 'fixture-google-key',
}

describe('image provider protocols', () => {
  test.each(['gemini-3.1-flash-lite-image', 'models/gemini-3.1-flash-lite-image'])(
    'checks the known native Lite model %s resolution before generating or editing',
    (model) => {
      const input = { model, prompt: 'draw a cat', count: 1 }
      for (const images of [[], [source]]) {
        expect(() => buildGeminiImageRequestBody({ ...input, resolution: '2k' }, images)).toThrow('only supports 1K')
        expect(() => buildProtocolImageRequests({ ...input, resolution: '2k' }, { ...nativeConfig, model }, images)).toThrow('only supports 1K')
        expect(buildGeminiImageRequestBody({ ...input, resolution: '1k' }, images)).toMatchObject({
          generationConfig: { imageConfig: { imageSize: '1K' } },
        })
        expect(buildGeminiImageRequestBody(input, images)).toMatchObject({
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        })
        expect(buildGeminiImageRequestBody(input, images).generationConfig).not.toHaveProperty('imageConfig')
      }
    },
  )

  test('builds native Gemini requests for an alias without OpenAI Images fields', () => {
    const requests = buildProtocolImageRequests({
      model: 'nana-banana-2',
      prompt: 'draw a cat',
      count: 2,
      aspect_ratio: '16:9',
      resolution: '2k',
      quality: 'high',
      output_format: 'png',
    }, nativeConfig, [])

    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual({
      url: 'https://relay.example.test/v1beta/models/nana-banana-2:generateContent',
      headers: { 'x-goog-api-key': 'fixture-google-key' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'draw a cat' }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
        },
      },
    })
    expect(requests[1]).toEqual(requests[0])
    expect(requests[1].body).not.toBe(requests[0].body)
  })

  test('edits Gemini images using ordered inline bytes in the same contents request', () => {
    const second = { ...source, fileName: 'second.webp', mimeType: 'image/webp' as const, bytes: Buffer.from('reference-two') }
    expect(buildGeminiImageRequestBody({
      model: 'gemini-3.1-flash-image',
      prompt: 'Put both cats together',
      count: 1,
      size: '1536x1024',
      resolution: '1k',
    }, [source, second])).toEqual({
      contents: [{
        role: 'user',
        parts: [
          { text: 'Put both cats together' },
          { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
          { inlineData: { mimeType: 'image/webp', data: 'cmVmZXJlbmNlLXR3bw==' } },
        ],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '3:2', imageSize: '1K' },
      },
    })
  })

  test('omits automatic ratio and unspecified image options for Gemini', () => {
    expect(buildGeminiImageRequestBody({
      model: 'gemini-2.5-flash-image', prompt: 'draw a cat', count: 1, aspect_ratio: 'auto',
    })).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'draw a cat' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    })
  })

  test.each(['2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20'])(
    'rejects unsupported Gemini aspect ratio %s before building generate or edit requests',
    (aspectRatio) => {
      const input = { model: 'gemini-3.1-flash-image', prompt: 'draw a cat', count: 1, aspect_ratio: aspectRatio }
      for (const images of [[], [source]]) {
        expect(() => buildGeminiImageRequestBody(input, images)).toThrow('Gemini')
        expect(() => buildProtocolImageRequests(input, nativeConfig, images)).toThrow('Gemini')
      }
      expect(buildXaiRequestBody(input)).toMatchObject({ aspect_ratio: aspectRatio })
    },
  )

  test.each(['4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'])(
    'preserves supported Gemini aspect ratio %s in the native request',
    (aspectRatio) => {
      expect(buildGeminiImageRequestBody({
        model: 'gemini-3.1-flash-image', prompt: 'draw a cat', count: 1, aspect_ratio: aspectRatio,
      })).toMatchObject({
        generationConfig: { imageConfig: { aspectRatio } },
      })
    },
  )

  test.each([
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta/models/alias:generateContent'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/?alt=sse&tenant=fixture', 'https://generativelanguage.googleapis.com/v1beta/models/alias:generateContent?tenant=fixture'],
    ['https://relay.example.test/proxy/v1beta/openai/', 'https://relay.example.test/proxy/v1beta/models/alias:generateContent'],
    ['https://relay.example.test/proxy/v1/openai/?tenant=fixture&alt=sse', 'https://relay.example.test/proxy/v1beta/models/alias:generateContent?tenant=fixture'],
  ])('routes an inherited OpenAI compatibility base %s to Gemini native models', (baseUrl, expected) => {
    expect(buildGeminiImageUrl(baseUrl!, 'models/alias')).toBe(expected!)
    const [request] = buildProtocolImageRequests({
      model: 'alias', prompt: 'draw a cat', count: 1,
    }, { ...nativeConfig, baseUrl: baseUrl! }, [])
    expect(request!.url).toBe(expected!)
  })

  test('builds native model URLs from roots, version prefixes, and full endpoints', () => {
    const cases = [
      ['https://relay.example.test', 'https://relay.example.test/v1beta/models/alias:generateContent'],
      ['https://relay.example.test/proxy/', 'https://relay.example.test/proxy/v1beta/models/alias:generateContent'],
      ['https://relay.example.test/v1beta/', 'https://relay.example.test/v1beta/models/alias:generateContent'],
      ['https://relay.example.test/v1/', 'https://relay.example.test/v1beta/models/alias:generateContent'],
      ['https://relay.example.test/proxy/v1/', 'https://relay.example.test/proxy/v1beta/models/alias:generateContent'],
      ['https://relay.example.test/proxy/v1beta/models/', 'https://relay.example.test/proxy/v1beta/models/alias:generateContent'],
      ['https://relay.example.test/v1beta/models/previous:generateContent', 'https://relay.example.test/v1beta/models/alias:generateContent'],
      ['https://relay.example.test/v1/models/previous:generateContent', 'https://relay.example.test/v1/models/alias:generateContent'],
      ['https://relay.example.test/v1beta/models/previous:streamGenerateContent?alt=sse&tenant=fixture', 'https://relay.example.test/v1beta/models/alias:generateContent?tenant=fixture'],
    ]
    for (const [baseUrl, expected] of cases) {
      expect(buildGeminiImageUrl(baseUrl!, 'models/alias')).toBe(expected!)
    }
    expect(buildGeminiImageUrl('https://relay.example.test', 'alias?key=other')).toBe(
      'https://relay.example.test/v1beta/models/alias%3Fkey%3Dother:generateContent',
    )
    expect(() => buildGeminiImageUrl('file:///tmp/output', 'alias')).toThrow('HTTP or HTTPS')
    expect(() => buildGeminiImageUrl('https://relay.example.test', 'models/')).toThrow('model is empty')
  })

  test('keeps Google official OpenAI prefixes and switches full Images endpoints', () => {
    expect(buildImagesProtocolUrl('https://generativelanguage.googleapis.com/v1beta/openai/', 'generations')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/images/generations',
    )
    expect(buildImagesProtocolUrl('https://api.x.ai/v1', 'edits')).toBe('https://api.x.ai/v1/images/edits')
    expect(buildImagesProtocolUrl('https://relay.example.test', 'generations')).toBe('https://relay.example.test/v1/images/generations')
    expect(buildImagesProtocolUrl('https://relay.example.test/proxy/images/generations?tenant=fixture', 'edits')).toBe(
      'https://relay.example.test/proxy/images/edits?tenant=fixture',
    )
    expect(buildImagesProtocolUrl('https://relay.example.test/v1/images/', 'edits')).toBe('https://relay.example.test/v1/images/edits')
    expect(() => buildImagesProtocolUrl('ftp://relay.example.test', 'generations')).toThrow('HTTP or HTTPS')
  })

  test('routes native Gemini using an inherited OpenAI provider base URL', () => {
    const [request] = buildProtocolImageRequests({
      model: 'nana-banana-2', prompt: 'draw a cat', count: 1,
    }, { ...nativeConfig, baseUrl: 'https://sub2api.example.test/v1' }, [])
    expect(request!.url).toBe('https://sub2api.example.test/v1beta/models/nana-banana-2:generateContent')
  })

  test('uses official GPT image base64 defaults for JSON generation and multipart edits', () => {
    for (const model of ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-flare', 'chatgpt-image-latest']) {
      const config: ImageGenerationRuntimeConfig = {
        ...nativeConfig, protocol: 'openai_images', model, baseUrl: 'https://api.openai.com/v1',
      }
      expect(applyOpenAIImageRequestContract({ model, prompt: 'draw a cat', response_format: 'b64_json', output_format: 'webp' }, config)).toEqual({
        model, prompt: 'draw a cat', output_format: 'webp',
      })
      const form = new FormData()
      form.set('model', model)
      form.set('prompt', 'edit the cat')
      form.set('response_format', 'b64_json')
      form.append('image[]', new Blob([PNG_BYTES], { type: 'image/png' }), 'cat.png')
      const adapted = applyOpenAIImageRequestContract(form, config)
      expect(adapted.has('response_format')).toBe(false)
      expect(adapted.get('prompt')).toBe('edit the cat')
      expect(adapted.get('image[]')).toBeInstanceOf(Blob)
    }
  })

  test('preserves relay aliases and legacy response formats without guessing', () => {
    const configs: ImageGenerationRuntimeConfig[] = [
      { ...nativeConfig, protocol: 'openai_images', model: 'gpt-image-2', baseUrl: 'https://relay.example.test/v1' },
      { ...nativeConfig, protocol: 'openai_images', model: 'custom-image-alias', baseUrl: 'https://api.openai.com/v1' },
      { ...nativeConfig, protocol: 'openai_images', model: 'dall-e-2', baseUrl: 'https://api.openai.com/v1' },
      { ...nativeConfig, protocol: 'openai_images', model: 'dall-e-3', baseUrl: 'https://api.openai.com/v1' },
      { ...nativeConfig, protocol: 'openai_images', model: 'gpt-image-2', baseUrl: 'https://api.openai.com.relay.example.test/v1' },
    ]
    for (const config of configs) {
      expect(applyOpenAIImageRequestContract({ response_format: 'b64_json' }, config)).toEqual({ response_format: 'b64_json' })
      const form = new FormData()
      form.set('response_format', 'b64_json')
      expect(applyOpenAIImageRequestContract(form, config).get('response_format')).toBe('b64_json')
    }
  })

  test('preserves the xAI contract while splitting requests into one image per call', () => {
    const requests = buildProtocolImageRequests({
      model: 'grok-custom-alias', prompt: 'A ceramic robot', count: 3, size: '1536x1024', resolution: '2k', quality: 'high',
    }, { ...nativeConfig, protocol: 'xai_images', baseUrl: 'https://api.x.ai/v1' }, [])
    expect(requests).toHaveLength(3)
    expect(requests[0]).toEqual({
      url: 'https://api.x.ai/v1/images/generations',
      body: {
        model: 'grok-custom-alias', prompt: 'A ceramic robot', n: 1,
        response_format: 'b64_json', aspect_ratio: '3:2', resolution: '2k',
      },
    })
    expect(buildXaiRequestBody({ model: 'grok-custom-alias', prompt: 'A ceramic robot', count: 3 })).toEqual({
      model: 'grok-custom-alias', prompt: 'A ceramic robot', n: 3, response_format: 'b64_json',
    })
  })

  test('uses JSON image for a single xAI edit and images for multiple references', () => {
    const input = { model: 'grok-imagine-image', prompt: 'Edit the cat', count: 1, aspect_ratio: '1:1' }
    expect(buildXaiEditRequestBody(input, [source])).toEqual({
      model: 'grok-imagine-image', prompt: 'Edit the cat', n: 1, response_format: 'b64_json', aspect_ratio: '1:1',
      image: { type: 'image_url', url: source.dataUrl },
    })
    const second = { ...source, dataUrl: 'data:image/webp;base64,cmVmZXJlbmNl' }
    expect(buildProtocolImageRequests(input, { ...nativeConfig, protocol: 'xai_images' }, [source, second])[0]).toEqual({
      url: 'https://relay.example.test/v1/images/edits',
      body: {
        model: 'grok-imagine-image', prompt: 'Edit the cat', n: 1, response_format: 'b64_json', aspect_ratio: '1:1',
        images: [
          { type: 'image_url', url: source.dataUrl },
          { type: 'image_url', url: second.dataUrl },
        ],
      },
    })
  })

  test('extracts native camelCase and snake_case image parts from mixed responses', () => {
    const images = parseGeminiImageResponse({
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { text: 'here you go' },
            { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
            { inline_data: { mime_type: 'IMAGE/WEBP', data: 'cmVmZXJlbmNl' } },
          ],
        },
        finishReason: 'STOP',
      }],
    })
    expect(images).toEqual([
      { b64Json: PNG_BASE64, mimeType: 'image/png' },
      { b64Json: 'cmVmZXJlbmNl', mimeType: 'image/webp' },
    ])
    expect(Buffer.from(images[0]!.b64Json!, 'base64')).toEqual(PNG_BYTES)
    expect(parseGeminiImageResponse({ response: { candidates: [{ content: { parts: [
      { inlineData: { mimeType: 'image/jpeg', data: 'cmVmZXJlbmNl' } },
    ] } }] } })).toEqual([{ b64Json: 'cmVmZXJlbmNl', mimeType: 'image/jpeg' }])
  })

  test('ignores thought previews, non-image attachments, empty data, and URI references', () => {
    expect(parseGeminiImageResponse({ candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
      { inlineData: { mimeType: 'audio/mpeg', data: PNG_BASE64 } },
      { inlineData: { mimeType: 'image/svg+xml', data: 'PHN2Zz4=' } },
      { inlineData: { mimeType: 'image/png', data: '' } },
      { inlineData: { mimeType: 'image/png', data: '  ' } },
      { fileData: { mimeType: 'image/png', fileUri: 'https://storage.example.test/cat.png' } },
      { text: '![image](https://storage.example.test/cat.png)' },
    ] } }] })).toEqual([])
    for (const value of [null, [], 'error', {}, { error: { code: 429 } }, { candidates: [null, {}, { content: [] }] }]) {
      expect(parseGeminiImageResponse(value)).toEqual([])
    }
  })

  test('requires explicit protocol and credentials instead of guessing from a model', () => {
    const input = { model: 'gemini-3.1-flash-image', prompt: 'draw a cat', count: 1 }
    expect(() => buildProtocolImageRequests(input, { ...nativeConfig, protocol: undefined }, [])).toThrow('Unsupported image request protocol')
    expect(() => buildProtocolImageRequests(input, { ...nativeConfig, apiKey: undefined }, [])).toThrow('Base URL or API key')
  })
})
