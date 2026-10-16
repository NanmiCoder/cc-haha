import { afterAll, beforeAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSessionId } from '../../bootstrap/state.js'
import {
  clearUserProvidedImages,
  registerUserProvidedImage,
} from '../../utils/userProvidedImages.js'
import { OPENAI_CODEX_OAUTH_FILE_ENV_KEY } from '../../services/openaiAuth/storage.js'
import {
  getImageGenerationRuntimeConfig,
  type ImageGenerationRuntimeConfig,
} from '../../services/imageGeneration/config.js'
import { buildProviderManagedEnv } from '../../server/services/providerRuntimeEnv.js'
import type { SavedProvider } from '../../server/types/provider.js'
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
let isolatedConfig: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalHome = process.env.HOME
beforeAll(async () => {
  isolatedConfig = await mkdtemp(join(tmpdir(), 'imagegen-test-config-'))
  process.env.CLAUDE_CONFIG_DIR = isolatedConfig
  process.env.HOME = isolatedConfig
})
afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(isolatedConfig, { recursive: true, force: true })
})

afterEach(async () => {
  if (outputDir) await rm(outputDir, { recursive: true, force: true })
  outputDir = undefined
  // The registry is module-level session state; leaking it between tests would
  // silently authorize paths a later test expects to be rejected.
  clearUserProvidedImages()
})

describe('ImageGen backend', () => {
  test('edits a migrated session upload referenced by its historical path', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-relocated-'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = outputDir
    try {
      const originalRoot = join(outputDir, 'absent-original')
      const uploadDir = join(outputDir, 'uploads', getSessionId())
      await mkdir(uploadDir, { recursive: true })
      await mkdir(join(outputDir, 'cc-haha'))
      await writeFile(join(uploadDir, 'source.png'), PNG_BYTES)
      await writeFile(join(outputDir, 'cc-haha/storage-relocations.json'), JSON.stringify({ version: 1, previousRoots: [originalRoot] }))
      const result = await generateImages({ prompt: 'edit my image', count: 1, referenced_image_paths: [join(originalRoot, 'uploads', getSessionId(), 'source.png')] }, customConfig, {
        outputDir,
        fetchImpl: async () => Response.json({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }),
      })
      expect(result.inputImageCount).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

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

  test('rejects edit paths the user never provided, wherever they point', async () => {
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
      })).rejects.toThrow('was not provided by the user in this session')
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('accepts an image the user attached with @, wherever it lives on disk', async () => {
    // Regression: an @-mentioned file keeps its original path, so the session
    // root dirs can never contain it. Before the registry existed this threw
    // and the model told the user to re-attach a file they had just attached.
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-at-mention-'))
    const desktopDir = await mkdtemp(join(tmpdir(), 'imagegen-user-desktop-'))
    const attachedPath = join(desktopDir, 'portrait.png')
    await writeFile(attachedPath, PNG_BYTES)
    try {
      await registerUserProvidedImage(attachedPath)
      const forms: FormData[] = []
      const fetchImpl = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        forms.push(init?.body as FormData)
        return Response.json({ data: [{ b64_json: PNG_BYTES.toString('base64') }] })
      }

      const result = await generateImages({
        prompt: 'Swap in this portrait; keep the rest of the poster unchanged',
        count: 1,
        referenced_image_paths: [attachedPath],
      }, customConfig, {
        fetchImpl,
        outputDir,
        // Deliberately excludes the attached file's directory: the registry is
        // the only thing that can let it through.
        inputRootDirs: [outputDir],
      })

      expect(result.operation).toBe('edit')
      expect(result.inputImageCount).toBe(1)
      expect(forms[0]?.getAll('image[]')).toHaveLength(1)
    } finally {
      await rm(desktopDir, { recursive: true, force: true })
    }
  })

  test('recognizes an attached image through a symlink', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-symlink-'))
    const realDir = await mkdtemp(join(tmpdir(), 'imagegen-symlink-real-'))
    const linkDir = await mkdtemp(join(tmpdir(), 'imagegen-symlink-link-'))
    const realPath = join(realDir, 'portrait.png')
    const linkPath = join(linkDir, 'portrait.png')
    await writeFile(realPath, PNG_BYTES)
    await symlink(realPath, linkPath)
    try {
      // The user attached the link; the tool resolves to the real file. Both
      // sides realpath(), so the two must still line up.
      await registerUserProvidedImage(linkPath)

      const result = await generateImages({
        prompt: 'Edit the attached portrait',
        count: 1,
        referenced_image_paths: [linkPath],
      }, customConfig, {
        fetchImpl: async () =>
          Response.json({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }),
        outputDir,
        inputRootDirs: [outputDir],
      })

      expect(result.inputImageCount).toBe(1)
    } finally {
      await rm(realDir, { recursive: true, force: true })
      await rm(linkDir, { recursive: true, force: true })
    }
  })

  test('accepts an image pasted into the chat this session', async () => {
    // Pasted and dropped images land in ~/.claude/image-cache/<sessionId>/,
    // which is a distinct root from the bridge upload dir.
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-pasted-'))
    const configDir = await mkdtemp(join(tmpdir(), 'imagegen-config-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      const pastedDir = join(configDir, 'image-cache', getSessionId())
      await mkdir(pastedDir, { recursive: true })
      const pastedPath = join(pastedDir, '1.png')
      await writeFile(pastedPath, PNG_BYTES)

      const result = await generateImages({
        prompt: 'Edit the pasted screenshot',
        count: 1,
        referenced_image_paths: [pastedPath],
      }, customConfig, {
        fetchImpl: async () =>
          Response.json({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }),
        outputDir,
        // No inputRootDirs override: this exercises defaultInputRootDirs().
      })

      expect(result.inputImageCount).toBe(1)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test.each([false, true])('downloads and saves a relay URL for edit=%s', async (edit) => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-url-'))
    const source = join(outputDir, 'source.png')
    await writeFile(source, PNG_BYTES)
    const imageUrl = 'https://cdn.example.test/generated.png?signature=fixture'
    const downloads: string[] = []
    const requests: string[] = []
    const result = await generateImages({
      prompt: 'A relay image', count: 1,
      ...(edit ? { referenced_image_paths: [source] } : {}),
    }, customConfig, {
      outputDir, inputRootDirs: [outputDir],
      fetchImpl: async (url) => {
        requests.push(String(url))
        return Response.json({ data: [{ b64_json: '', url: imageUrl, revised_prompt: 'relay revision' }] })
      },
      downloadImage: async (url, signal) => {
        signal.throwIfAborted()
        downloads.push(url)
        return PNG_BYTES
      },
    })
    expect(requests).toEqual([`https://relay.example.test/v1/images/${edit ? 'edits' : 'generations'}`])
    expect(downloads).toEqual([imageUrl])
    expect(result.operation).toBe(edit ? 'edit' : 'generate')
    expect(result.images[0]).toMatchObject({ mimeType: 'image/png', revisedPrompt: 'relay revision' })
    expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
  })

  for (const field of ['url', 'b64_json']) {
    test.each([false, true])(`decodes a Data URL in ${field} without downloading, edit=%s`, async (edit) => {
      outputDir = await mkdtemp(join(tmpdir(), 'imagegen-data-url-'))
      const source = join(outputDir, 'source.png')
      await writeFile(source, PNG_BYTES)
      let downloads = 0
      const result = await generateImages({
        prompt: 'A relay image', count: 1,
        ...(edit ? { referenced_image_paths: [source] } : {}),
      }, customConfig, {
        outputDir, inputRootDirs: [outputDir],
        fetchImpl: async () => Response.json({ data: [{ [field]: `data:image/png;base64,${PNG_BYTES.toString('base64')}` }] }),
        downloadImage: async () => { downloads++; throw new Error('Data URLs must not be downloaded') },
      })
      expect(downloads).toBe(0)
      expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
    })
  }

  test('prefers returned Base64 over a URL without contacting the CDN', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-base64-priority-'))
    const result = await generateImages({ prompt: 'A relay image', count: 1 }, customConfig, {
      outputDir,
      fetchImpl: async () => Response.json({ data: [{ b64_json: PNG_BYTES.toString('base64'), url: 'https://127.0.0.1/private.png' }] }),
      downloadImage: async () => { throw new Error('Base64 must take priority') },
    })
    expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
  })

  test.each([
    ['https://127.0.0.1/private.png', 'non-public'],
    ['http://cdn.example.test/image.png', 'HTTPS'],
    ['file:///tmp/private.png', 'HTTPS'],
    ['data:text/html;base64,aGVsbG8=', 'image Data URL'],
    ['data:image/png,not-base64', 'image Data URL'],
    ['data:image/png;base64,not!base64', 'Base64'],
  ])('rejects unsafe or malformed image result %s', async (url, error) => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-unsafe-result-'))
    await expect(generateImages({ prompt: 'A relay image', count: 1 }, customConfig, {
      outputDir,
      fetchImpl: async () => Response.json({ data: [{ url }] }),
    })).rejects.toThrow(error)
  })

  test('surfaces a failed CDN download without retrying generation', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-download-failure-'))
    let requests = 0
    await expect(generateImages({ prompt: 'A relay image', count: 1 }, customConfig, {
      outputDir,
      fetchImpl: async () => { requests++; return Response.json({ data: [{ url: 'https://cdn.example.test/expired.png' }] }) },
      downloadImage: async () => { throw new Error('Image download failed with HTTP 403') },
    })).rejects.toThrow('HTTP 403')
    expect(requests).toBe(1)
  })

  for (const aspectRatio of ['4:5', '21:9']) {
    test.each([false, true])(`inherits the official Gemini chat base for native ${aspectRatio} images, edit=%s`, async (edit) => {
      // The image override is deliberately absent: the desktop form inherits
      // Google's OpenAI-compatible chat URL, which must become a native URL.
      const provider: SavedProvider = {
        id: 'gemini-shared-base-fixture', presetId: 'custom', name: 'Gemini fixture',
        apiKey: 'fake-gemini-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiFormat: 'openai_chat', runtimeKind: 'anthropic_compatible',
        models: { main: 'gemini-chat-fixture', haiku: '', sonnet: '', opus: '' },
        imageGeneration: { protocol: 'gemini_native', model: 'gemini-image-fixture' },
      }
      const config = getImageGenerationRuntimeConfig(buildProviderManagedEnv(provider))
      expect(config).not.toBeNull()
      outputDir = await mkdtemp(join(tmpdir(), 'imagegen-gemini-shared-base-'))
      const source = join(outputDir, 'source.png')
      await writeFile(source, PNG_BYTES)
      const requests: string[] = []
      const expectedUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-image-fixture:generateContent'
      const result = await generateImages({
        prompt: 'A native Gemini fixture', count: 1, aspect_ratio: aspectRatio, resolution: '2k',
        ...(edit ? { referenced_image_paths: [source] } : {}),
      }, config!, {
        outputDir, inputRootDirs: [outputDir],
        fetchImpl: async (url, init) => {
          requests.push(String(url))
          if (String(url) !== expectedUrl) return new Response('Unknown fixture route', { status: 404 })
          expect(init?.method).toBe('POST')
          const headers = new Headers(init?.headers)
          expect(headers.get('x-goog-api-key')).toBe('fake-gemini-key')
          expect(headers.get('authorization')).toBeNull()
          expect(headers.get('content-type')).toBe('application/json')
          expect(JSON.parse(String(init?.body))).toEqual({
            contents: [{
              role: 'user',
              parts: [
                { text: 'A native Gemini fixture' },
                ...(edit ? [{ inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } }] : []),
              ],
            }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: { aspectRatio, imageSize: '2K' },
            },
          })
          return Response.json({ candidates: [{ content: { parts: [
            { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
          ] } }] })
        },
      })
      expect(requests).toEqual([expectedUrl])
      expect(result).toMatchObject({
        providerId: provider.id, model: 'gemini-image-fixture',
        operation: edit ? 'edit' : 'generate', inputImageCount: edit ? 1 : 0,
      })
      expect(result.images).toHaveLength(1)
      expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
    })
  }

  for (const model of ['gemini-3.1-flash-lite-image', 'models/gemini-3.1-flash-lite-image']) {
    test.each([false, true])(`rejects unsupported 2K Gemini Lite resolution for ${model} before fetching, edit=%s`, async (edit) => {
      outputDir = await mkdtemp(join(tmpdir(), 'imagegen-gemini-lite-invalid-resolution-'))
      const source = join(outputDir, 'source.png')
      await writeFile(source, PNG_BYTES)
      let requests = 0
      await expect(generateImages({
        prompt: 'A Gemini Lite fixture', count: 1, resolution: '2k',
        ...(edit ? { referenced_image_paths: [source] } : {}),
      }, { ...customConfig, protocol: 'gemini_native', model }, {
        outputDir, inputRootDirs: [outputDir],
        fetchImpl: async () => {
          requests++
          return Response.json({ candidates: [{ content: { parts: [
            { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
          ] } }] })
        },
      })).rejects.toThrow(/gemini-3\.1-flash-lite-image/)
      expect(requests).toBe(0)
    })

    for (const resolution of ['1k', undefined] as const) {
      test.each([false, true])(`saves Gemini Lite ${model} output with ${resolution ?? 'default'} resolution, edit=%s`, async (edit) => {
        outputDir = await mkdtemp(join(tmpdir(), 'imagegen-gemini-lite-supported-resolution-'))
        const source = join(outputDir, 'source.png')
        await writeFile(source, PNG_BYTES)
        const prompt = 'A Gemini Lite fixture'
        const requests: string[] = []
        const expectedUrl = 'https://relay.example.test/v1beta/models/gemini-3.1-flash-lite-image:generateContent'
        const result = await generateImages({
          prompt, count: 1, aspect_ratio: '16:9',
          ...(resolution ? { resolution } : {}),
          ...(edit ? { referenced_image_paths: [source] } : {}),
        }, { ...customConfig, protocol: 'gemini_native', model }, {
          outputDir, inputRootDirs: [outputDir],
          fetchImpl: async (url, init) => {
            requests.push(String(url))
            const body = JSON.parse(String(init?.body))
            expect(body.contents).toEqual([{
              role: 'user',
              parts: [
                { text: prompt },
                ...(edit ? [{ inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } }] : []),
              ],
            }])
            expect(body.generationConfig).toEqual({
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: {
                aspectRatio: '16:9',
                ...(resolution ? { imageSize: '1K' } : {}),
              },
            })
            return Response.json({ candidates: [{ content: { parts: [
              { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
            ] } }] })
          },
        })
        expect(requests).toEqual([expectedUrl])
        expect(result).toMatchObject({
          model, operation: edit ? 'edit' : 'generate', inputImageCount: edit ? 1 : 0,
        })
        expect(result.images).toHaveLength(1)
        expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
      })
    }
  }

  test('rejects an unsupported native Gemini aspect ratio before fetching when called without the tool schema', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-gemini-invalid-ratio-'))
    let requests = 0
    await expect(generateImages({
      prompt: 'A native Gemini fixture', count: 1, aspect_ratio: '2:1',
    }, { ...customConfig, protocol: 'gemini_native' }, {
      outputDir,
      fetchImpl: async () => {
        requests++
        return Response.json({ candidates: [{ content: { parts: [
          { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
        ] } }] })
      },
    })).rejects.toThrow('aspect ratio')
    expect(requests).toBe(0)
  })

  for (const protocol of ['gemini_native', 'xai_images'] as const) {
    test.each([false, true])(`persists ${protocol} output through its configured generate/edit request, edit=%s`, async (edit) => {
      outputDir = await mkdtemp(join(tmpdir(), 'imagegen-native-'))
      const source = join(outputDir, 'source.png')
      await writeFile(source, PNG_BYTES)
      const calls: string[] = []
      const result = await generateImages({
        prompt: 'A native image', count: 1, aspect_ratio: '16:9', resolution: '2k',
        ...(edit ? { referenced_image_paths: [source] } : {}),
      }, { ...customConfig, protocol }, {
        outputDir, inputRootDirs: [outputDir],
        fetchImpl: async (url, init) => {
          calls.push(String(url))
          const headers = new Headers(init?.headers)
          expect(headers.get('content-type')).toBe('application/json')
          expect(init?.body).not.toBeInstanceOf(FormData)
          const body = JSON.parse(String(init?.body))
          if (protocol === 'gemini_native') {
            expect(headers.get('x-goog-api-key')).toBe('relay-secret')
            expect(headers.get('authorization')).toBeNull()
            expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' })
            expect(body.contents[0].parts).toHaveLength(edit ? 2 : 1)
            if (edit) expect(body.contents[0].parts[1].inlineData.data).toBe(PNG_BYTES.toString('base64'))
            return Response.json({ candidates: [{ content: { parts: [
              { text: 'Done' },
              { inline_data: { mime_type: 'image/png', data: PNG_BYTES.toString('base64') } },
            ] } }] })
          }
          expect(headers.get('authorization')).toBe('Bearer relay-secret')
          expect(body).toMatchObject({ n: 1, aspect_ratio: '16:9', resolution: '2k' })
          expect(body.size).toBeUndefined()
          if (edit) expect(body.image).toEqual({ type: 'image_url', url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` })
          return Response.json({ data: [{ url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` }] })
        },
      })
      expect(calls).toEqual([protocol === 'gemini_native'
        ? 'https://relay.example.test/v1beta/models/relay-image-model:generateContent'
        : `https://relay.example.test/v1/images/${edit ? 'edits' : 'generations'}`])
      expect(result.inputImageCount).toBe(edit ? 1 : 0)
      expect(result.operation).toBe(edit ? 'edit' : 'generate')
      expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
    })
  }

  test.each([
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00]), '.jpg'],
    ['image/webp', Buffer.from('RIFF0000WEBP'), '.webp'],
  ])('saves supported Data URL bytes as %s using the detected format', async (mime, bytes, extension) => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-data-format-'))
    const result = await generateImages({ prompt: 'A relay image', count: 1 }, customConfig, {
      outputDir,
      fetchImpl: async () => Response.json({ data: [{ url: `data:${mime};base64,${bytes.toString('base64')}` }] }),
    })
    expect(result.images[0]!.mimeType).toBe(mime)
    expect(result.images[0]!.path.endsWith(extension)).toBe(true)
    expect(await readFile(result.images[0]!.path)).toEqual(bytes)
  })

  test('bounds inline image decoding before allocating an oversized decoded buffer', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-large-inline-'))
    await expect(generateImages({ prompt: 'A relay image', count: 1 }, customConfig, {
      outputDir,
      fetchImpl: async () => Response.json({ data: [{ url: `data:image/png;base64,${'A'.repeat(40 * 1024 * 1024 + 12)}` }] }),
    })).rejects.toThrow('30 MB')
  })

  test.each([false, true])('uses official GPT Image Base64 defaults through the real request path, edit=%s', async (edit) => {
    outputDir = await mkdtemp(join(tmpdir(), 'imagegen-openai-contract-'))
    const source = join(outputDir, 'source.png')
    await writeFile(source, PNG_BYTES)
    const result = await generateImages({
      prompt: 'An official GPT image', count: 1,
      ...(edit ? { referenced_image_paths: [source] } : {}),
    }, { ...customConfig, model: 'gpt-image-2', baseUrl: 'https://api.openai.com/v1' }, {
      outputDir, inputRootDirs: [outputDir],
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(`https://api.openai.com/v1/images/${edit ? 'edits' : 'generations'}`)
        if (edit) expect((init?.body as FormData).has('response_format')).toBe(false)
        else expect(JSON.parse(String(init?.body)).response_format).toBeUndefined()
        return Response.json({ data: [{ b64_json: PNG_BYTES.toString('base64') }] })
      },
    })
    expect(await readFile(result.images[0]!.path)).toEqual(PNG_BYTES)
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
