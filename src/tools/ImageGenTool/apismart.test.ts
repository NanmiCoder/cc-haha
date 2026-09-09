import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PROVIDER_PRESETS } from '../../server/config/providerPresets.js'
import { buildProviderManagedEnv } from '../../server/services/providerRuntimeEnv.js'
import { getImageGenerationRuntimeConfig } from '../../services/imageGeneration/config.js'
import { clearUserProvidedImages } from '../../utils/userProvidedImages.js'
import { generateImages } from './backend.js'
import { buildApiSmartImageBodies, isApiSmartImageConfig } from './apiSmart.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')
let outputDir: string | undefined
let server: ReturnType<typeof Bun.serve> | undefined

afterEach(async () => {
  server?.stop(true)
  server = undefined
  if (outputDir) await rm(outputDir, { recursive: true, force: true })
  outputDir = undefined
  clearUserProvidedImages()
})

function runtimeConfig() {
  const preset = PROVIDER_PRESETS.find(p => p.id === 'apismart')!
  const env = buildProviderManagedEnv({
    id: 'saved-apismart', presetId: preset.id, name: preset.name,
    baseUrl: preset.baseUrl, apiKey: 'fake-apismart-key', apiFormat: preset.apiFormat,
    models: preset.defaultModels, imageGeneration: preset.defaultImageGeneration,
  })
  const config = getImageGenerationRuntimeConfig(env)
  expect(config).toEqual({
    kind: 'openai_images', providerId: 'saved-apismart', model: 'doubao-seedream-5-0',
    baseUrl: 'https://gw.apismart.ai/v1', apiKey: 'fake-apismart-key',
  })
  return config!
}

// Local server rejects the old generic OpenAI defaults using ApiSmart's published
// contract: response_format=url, >= 3,686,400 pixels, multipart field=image.
describe('ApiSmart image provider contract', () => {
  test('keeps the URL-only adapter scoped to the ApiSmart gateway', () => {
    const config = runtimeConfig()
    expect(isApiSmartImageConfig(config)).toBe(true)
    for (const baseUrl of ['https://relay.example.test/v1', 'https://gw.apismart.ai.evil.test/v1', '', 'invalid']) {
      expect(isApiSmartImageConfig({ ...config, baseUrl })).toBe(false)
    }
    expect(isApiSmartImageConfig({ ...config, kind: 'grok_oauth' })).toBe(false)
  })

  test('uses valid Seedream sizes and rejects unsupported image options before sending', () => {
    const input = { prompt: 'poster', model: 'doubao-seedream-5-0', count: 2 }
    expect(buildApiSmartImageBodies(input, [])).toEqual(Array(2).fill({
      model: 'doubao-seedream-5-0', prompt: 'poster',
      response_format: 'url', size: '2K', output_format: 'png',
    }))
    for (const aspect_ratio of ['1:1', '16:9', '9:16', '20:9']) {
      const body = buildApiSmartImageBodies({ ...input, aspect_ratio }, [])[0] as Record<string, string>
      const [w, h] = body.size!.split('x').map(Number)
      const [rw, rh] = aspect_ratio.split(':').map(Number)
      expect(w! * h!).toBeGreaterThanOrEqual(3686400)
      expect(w! * h!).toBeLessThanOrEqual(16777216)
      expect(w! / h!).toBeCloseTo(rw! / rh!, 2)
    }
    for (const [size, expected] of [['1024x1536', '2048x3072'], ['1536x1024', '3072x2048']] as const) {
      expect(buildApiSmartImageBodies({ ...input, size, output_format: 'jpeg' }, [])[0])
        .toMatchObject({ size: expected, output_format: 'jpeg' })
    }
    expect(buildApiSmartImageBodies({ ...input, size: 'auto', aspect_ratio: 'auto' }, [])[0])
      .toMatchObject({ size: '2K' })
    expect(() => buildApiSmartImageBodies({ ...input, output_format: 'webp' }, [])).toThrow('PNG or JPEG')
    expect(() => buildApiSmartImageBodies({ ...input, background: 'transparent' }, [])).toThrow('transparent')
    expect(() => buildApiSmartImageBodies({ ...input, aspect_ratio: '100:1' }, [])).toThrow('aspect ratio')
    expect(() => buildApiSmartImageBodies(input, [{
      dataUrl: '', fileName: 'large.png', mimeType: 'image/png', bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
    }])).toThrow('10 MB')
  })

  test.each([false, true])('saves generated image bytes through the %s edit path', async (edit) => {
    outputDir = await mkdtemp(join(tmpdir(), 'apismart-image-'))
    const source = join(outputDir, 'input.png')
    await writeFile(source, png)
    const requests: string[] = []
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      if (path === '/result.png') {
        expect(req.headers.get('authorization')).toBeNull()
        return new Response(png, { headers: { 'Content-Type': 'image/png' } })
      }
      expect(req.method).toBe('POST')
      expect(req.headers.get('authorization')).toBe('Bearer fake-apismart-key')
      let body: Record<string, unknown>
      if (edit) {
        expect(path).toBe('/v1/images/edits')
        const form = await req.formData()
        expect(form.has('image[]')).toBe(false)
        const file = form.get('image') as File
        expect(Buffer.from(await file.arrayBuffer())).toEqual(png)
        body = Object.fromEntries(form.entries())
      } else {
        expect(path).toBe('/v1/images/generations')
        body = await req.json()
      }
      expect(body.model).toBe('doubao-seedream-5-0')
      expect(body.response_format).toBe('url')
      expect(body.size).toBe('2048x2048')
      expect(body.quality).toBeUndefined()
      expect(body.background).toBeUndefined()
      expect(body.n).toBeUndefined()
      return Response.json({ data: [{ url: 'https://cdn.example.test/result.png' }] })
    } })
    const result = await generateImages({
      prompt: 'A blue square', count: 1, size: '1024x1024', quality: 'high',
      ...(edit ? { referenced_image_paths: [source] } : {}),
    }, runtimeConfig(), {
      outputDir, inputRootDirs: [outputDir],
      fetchImpl: async (url, init) => {
        expect(new URL(String(url)).origin).toBe('https://gw.apismart.ai')
        return fetch(new URL(new URL(String(url)).pathname, server!.url), init)
      },
      downloadImage: async (url) => {
        expect(url).toBe('https://cdn.example.test/result.png')
        return Buffer.from(await (await fetch(new URL('/result.png', server!.url))).arrayBuffer())
      },
    })
    expect(requests).toEqual([edit ? '/v1/images/edits' : '/v1/images/generations', '/result.png'])
    expect(result.operation).toBe(edit ? 'edit' : 'generate')
    expect(await readFile(result.images[0]!.path)).toEqual(png)
  })
})
