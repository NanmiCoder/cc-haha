import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { OPENAI_CODEX_OAUTH_FILE_ENV_KEY } from '../../services/openaiAuth/storage.js'
import type { ImageGenerationRuntimeConfig } from '../../services/imageGeneration/config.js'
import {
  buildChatGPTRequestBody,
  buildChatGPTRequestBodies,
  buildCompatibleRequestBodies,
  buildGrokEditRequestBody,
  buildGrokRequestBody,
  buildImagesEditUrl,
  buildImagesGenerationUrl,
  generateImages,
  parseChatGPTImageStream,
} from './backend.js'

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
])

const customConfig: ImageGenerationRuntimeConfig = {
  kind: 'openai_images',
  providerId: 'relay-provider',
  model: 'relay-image-model',
  baseUrl: 'https://relay.example.test/v1',
  apiKey: 'relay-secret',
}

let outputDir: string | undefined

afterEach(async () => {
  if (outputDir) await rm(outputDir, { recursive: true, force: true })
  outputDir = undefined
})

describe('ImageGen backend', () => {
  test('builds the ChatGPT Responses image tool contract', () => {
    expect(buildChatGPTRequestBody({
      prompt: 'A geometric fox poster',
      count: 2,
      model: 'gpt-image-2',
      aspect_ratio: '9:16',
      quality: 'high',
    })).toMatchObject({
      stream: true,
      tool_choice: { type: 'image_generation' },
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'A geometric fox poster' }],
      }],
      tools: [{
        type: 'image_generation',
        action: 'generate',
        model: 'gpt-image-2',
        size: '1024x1536',
        quality: 'high',
      }],
    })
    expect(JSON.stringify(buildChatGPTRequestBody({
      prompt: 'A geometric fox poster',
      count: 2,
      model: 'gpt-image-2',
    }))).not.toContain('"n"')
  })

  test('builds a ChatGPT edit request with ordered image inputs', () => {
    expect(buildChatGPTRequestBody({
      prompt: 'Put a red scarf on the fox; keep everything else unchanged',
      count: 1,
      model: 'gpt-image-2',
      referenced_image_paths: [
        '/allowed/fox.png',
        '/allowed/scarf.jpg',
      ],
    }, [
      { dataUrl: 'data:image/png;base64,Zm94', fileName: 'fox.png', mimeType: 'image/png', bytes: Buffer.from('fox') },
      { dataUrl: 'data:image/jpeg;base64,c2NhcmY=', fileName: 'scarf.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('scarf') },
    ])).toMatchObject({
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Put a red scarf on the fox; keep everything else unchanged' },
          { type: 'input_image', image_url: 'data:image/png;base64,Zm94' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,c2NhcmY=' },
        ],
      }],
      tools: [{ type: 'image_generation', action: 'edit' }],
    })
  })

  test('splits ChatGPT multi-image requests into hosted-tool-compatible single calls', () => {
    const bodies = buildChatGPTRequestBodies({
      prompt: 'Three geometric fox posters',
      count: 3,
      model: 'gpt-image-2',
    })

    expect(bodies).toHaveLength(3)
    expect(bodies.every((body) => !JSON.stringify(body).includes('"n"'))).toBe(true)
  })

  test('builds the xAI Images API contract without OpenAI-only size fields', () => {
    expect(buildGrokRequestBody({
      prompt: 'A ceramic robot',
      count: 3,
      model: 'grok-imagine-image-quality',
      size: '1536x1024',
      resolution: '2k',
    })).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'A ceramic robot',
      n: 3,
      response_format: 'b64_json',
      aspect_ratio: '3:2',
      resolution: '2k',
    })
  })

  test('builds the xAI multi-image edit contract in source order', () => {
    expect(buildGrokEditRequestBody({
      prompt: 'Place both subjects together',
      count: 1,
      model: 'grok-imagine-image-quality',
      referenced_image_paths: [
        '/allowed/first.png',
        '/allowed/second.png',
      ],
      aspect_ratio: '3:2',
    }, [
      { dataUrl: 'data:image/png;base64,Zmlyc3Q=', fileName: 'first.png', mimeType: 'image/png', bytes: Buffer.from('first') },
      { dataUrl: 'data:image/png;base64,c2Vjb25k', fileName: 'second.png', mimeType: 'image/png', bytes: Buffer.from('second') },
    ])).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'Place both subjects together',
      n: 1,
      response_format: 'b64_json',
      aspect_ratio: '3:2',
      images: [
        { type: 'image_url', url: 'data:image/png;base64,Zmlyc3Q=' },
        { type: 'image_url', url: 'data:image/png;base64,c2Vjb25k' },
      ],
    })
  })

  test('drives the OpenAI-compatible request and persists one slot per returned image', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-output-'))
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json({
        data: [{
          b64_json: PNG_BYTES.toString('base64'),
          ...(calls.length === 1 ? { revised_prompt: 'first revision' } : {}),
        }],
      })
    }

    const result = await generateImages(
      {
        prompt: 'Two paper-cut fox variations',
        count: 2,
        aspect_ratio: '16:9',
      },
      customConfig,
      { fetchImpl, outputDir },
    )

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toBe('https://relay.example.test/v1/images/generations')
      const headers = new Headers(call.init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer relay-secret')
      const body = JSON.parse(String(call.init?.body))
      expect(body).toMatchObject({
        model: 'relay-image-model',
        prompt: 'Two paper-cut fox variations',
        response_format: 'b64_json',
        size: '1536x1024',
      })
      expect(body.n).toBeUndefined()
    }

    expect(result).toMatchObject({
      type: 'image_generation_result',
      providerId: 'relay-provider',
      providerKind: 'openai_images',
      model: 'relay-image-model',
      images: [
        { mimeType: 'image/png', revisedPrompt: 'first revision' },
        { mimeType: 'image/png' },
      ],
    })
    expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
    expect(await readFile(result.images[1]!.path)).toEqual(PNG_BYTES)
  })

  test('splits compatible multi-image requests into single calls without n', () => {
    const bodies = buildCompatibleRequestBodies({
      prompt: 'Three paper birds',
      count: 3,
      model: 'relay-image-model',
    })

    expect(bodies).toHaveLength(3)
    expect(bodies.every((body) => body.n === undefined)).toBe(true)
  })

  test('uses multipart image edits for compatible providers and persists each variation', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-edit-'))
    const sourcePath = join(outputDir, 'source.png')
    await writeFile(sourcePath, PNG_BYTES)
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json({ data: [{ b64_json: PNG_BYTES.toString('base64') }] })
    }

    const result = await generateImages({
      prompt: 'Make the sky purple; preserve the subject and framing',
      count: 2,
      referenced_image_paths: [sourcePath],
      quality: 'high',
    }, customConfig, {
      fetchImpl,
      outputDir,
      inputRootDirs: [outputDir],
    })

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toBe('https://relay.example.test/v1/images/edits')
      expect(new Headers(call.init?.headers).get('Content-Type')).toBeNull()
      const form = call.init?.body as FormData
      expect(form).toBeInstanceOf(FormData)
      expect(form.get('model')).toBe('relay-image-model')
      expect(form.get('prompt')).toBe('Make the sky purple; preserve the subject and framing')
      expect(form.getAll('image[]')).toHaveLength(1)
      expect(form.get('quality')).toBe('high')
    }
    expect(result.operation).toBe('edit')
    expect(result.inputImageCount).toBe(1)
    expect(result.images).toHaveLength(2)
  })

  test('uses the configured ChatGPT OAuth image model', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-openai-oauth-'))
    const tokenPath = join(outputDir, 'openai-oauth.json')
    const previousTokenPath = process.env[OPENAI_CODEX_OAUTH_FILE_ENV_KEY]
    await writeFile(tokenPath, JSON.stringify({
      accessToken: 'test-openai-access-token',
      refreshToken: 'test-openai-refresh-token',
      expiresAt: 4_100_000_000_000,
      accountId: 'test-openai-account',
    }))
    process.env[OPENAI_CODEX_OAUTH_FILE_ENV_KEY] = tokenPath

    let requestBody: Record<string, any> | undefined
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      const event = {
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          result: PNG_BYTES.toString('base64'),
        },
      }
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`)
    }

    try {
      const result = await generateImages({
        prompt: 'A paper-cut fox poster',
        count: 1,
      }, {
        kind: 'openai_oauth',
        providerId: 'openai-official',
        model: 'gpt-image-2',
      }, { fetchImpl, outputDir })

      expect(requestBody?.tools?.[0]).toMatchObject({
        type: 'image_generation',
        model: 'gpt-image-2',
      })
      expect(result).toMatchObject({
        providerId: 'openai-official',
        providerKind: 'openai_oauth',
        model: 'gpt-image-2',
      })
    } finally {
      if (previousTokenPath === undefined) {
        delete process.env[OPENAI_CODEX_OAUTH_FILE_ENV_KEY]
      } else {
        process.env[OPENAI_CODEX_OAUTH_FILE_ENV_KEY] = previousTokenPath
      }
    }
  })

  test('rejects edit paths outside the session upload and generated-image roots', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-edit-root-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'imagegen-edit-outside-'))
    const outsidePath = join(outsideDir, 'private.png')
    await writeFile(outsidePath, PNG_BYTES)
    try {
      await expect(generateImages({
        prompt: 'Edit this image',
        count: 1,
        referenced_image_paths: [outsidePath],
      }, customConfig, {
        outputDir,
        inputRootDirs: [outputDir],
        fetchImpl: async () => Response.json({ data: [] }),
      })).rejects.toThrow('not a staged upload or a generated image from this session')
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('rejects relay-provided download URLs instead of turning the desktop into an SSRF client', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-output-'))
    const fetchImpl = async () => Response.json({
      data: [{ url: 'https://untrusted.example.test/generated.png' }],
    })

    await expect(generateImages(
      { prompt: 'A safe image', count: 1 },
      customConfig,
      { fetchImpl, outputDir },
    )).rejects.toThrow('Configure it to return b64_json')
  })

  test('redacts the configured API key from provider error bodies', async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ error: 'relay-secret was rejected' }),
      { status: 401 },
    )

    await expect(generateImages(
      { prompt: 'A safe image', count: 1 },
      customConfig,
      { fetchImpl },
    )).rejects.toThrow('{"error":"[redacted] was rejected"}')
  })

  test('extracts image_generation_call results from both terminal Responses events without duplicates', () => {
    const first = PNG_BYTES.toString('base64')
    const second = Buffer.from([...PNG_BYTES, 0x01]).toString('base64')
    const stream = [
      `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: first, revised_prompt: 'rev A' } })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { output: [
        { type: 'image_generation_call', result: first },
        { type: 'image_generation_call', result: second, output_format: 'png' },
      ] } })}`,
      'data: [DONE]',
    ].join('\n\n')

    expect(parseChatGPTImageStream(stream)).toEqual([
      { b64Json: first, revisedPrompt: 'rev A' },
      { b64Json: second, mimeType: 'image/png' },
    ])
  })

  test('normalizes provider base URLs without duplicating v1', () => {
    expect(buildImagesGenerationUrl('https://relay.test')).toBe(
      'https://relay.test/v1/images/generations',
    )
    expect(buildImagesGenerationUrl('https://relay.test/v1/')).toBe(
      'https://relay.test/v1/images/generations',
    )
    expect(buildImagesGenerationUrl('https://relay.test/v1/images/generations')).toBe(
      'https://relay.test/v1/images/generations',
    )
    expect(buildImagesEditUrl('https://relay.test/v1/images/generations')).toBe(
      'https://relay.test/v1/images/edits',
    )
  })
})
