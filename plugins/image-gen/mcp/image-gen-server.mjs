#!/usr/bin/env node

/**
 * image-gen MCP Server
 *
 * Multi-provider image generation with automatic fallback.
 * Supports any OpenAI-compatible /v1/images/generations endpoint.
 * Zero external dependencies — uses Node.js built-in fetch + raw JSON-RPC over stdio.
 *
 * Compatible providers: Agnes, GPT-image-2, Gemini image, nano-banana, DALL-E,
 * Flux, Stable Diffusion, and any OpenAI-compatible relay (New API / OneAPI style).
 */

import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'

// ─── Config ───────────────────────────────────────────────────────────────────

function isUnset(val) {
  return !val || val.trim() === '' || val.startsWith('${user_config.')
}

function isPrivateHostname(hostname) {
  // Strip IPv6 brackets: new URL() returns "[::1]" but we compare against "::1"
  const h = hostname.replace(/^\[|\]$/g, '')
  // IPv4-mapped IPv6: ::ffff:127.0.0.1 → extract trailing IPv4
  const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Mapped) return isPrivateHostname(v4Mapped[1])
  // IPv4 private ranges
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h.startsWith('169.254.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) return true
  // IPv6 loopback / link-local / private
  if (
    h === '::1' ||
    h.startsWith('fe80:') ||           // link-local
    h.startsWith('fc00:') ||           // unique local (fc00::/7)
    h.startsWith('fd')                 // unique local (fd00::/8)
  ) return true
  return false
}

function validateUrlSafety(urlString, label) {
  const parsed = new URL(urlString)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label}: 不允许的协议 ${parsed.protocol}。仅支持 http/https。`)
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error(`${label}: 不允许访问内网地址 ${parsed.hostname.replace(/^\[|\]$/g, '')}`)
  }
}

const MODEL_CAPABILITIES = {
  // Agnes image models
  'agnes-image-2.1-flash': { sizes: ['512x512', '768x768', '1024x1024'], edit: false, transparent: false, maxN: 4, format: 'url' },
  'agnes-image-2.0-flash': { sizes: ['512x512', '768x768', '1024x1024'], edit: false, transparent: false, maxN: 4, format: 'url' },
  // GPT image models
  'gpt-image-2': { sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'], edit: true, transparent: true, maxN: 10, format: 'b64_json', notes: 'size must be multiple of 16, max 3840px' },
  'gpt-image-1': { sizes: ['1024x1024', '1536x1024', '1024x1536', '256x256', '512x512', 'auto'], edit: true, transparent: true, maxN: 10, format: 'b64_json' },
  // DALL-E models
  'dall-e-3': { sizes: ['1024x1024', '1792x1024', '1024x1792'], edit: false, transparent: false, maxN: 1, format: 'url' },
  'dall-e-2': { sizes: ['256x256', '512x512', '1024x1024'], edit: true, transparent: false, maxN: 10, format: 'url' },
  // Gemini image
  'gemini-2.5-flash-image-preview': { sizes: ['1024x1024', '512x512', '1536x1536'], edit: true, transparent: false, maxN: 4, format: 'b64_json' },
  'gemini-2.0-flash-exp-image-generation': { sizes: ['1024x1024', '512x512'], edit: false, transparent: false, maxN: 4, format: 'b64_json' },
  // Flux models
  'flux-schnell': { sizes: ['512x512', '768x768', '1024x1024', '1536x1024', '1024x1536'], edit: false, transparent: false, maxN: 4, format: 'url' },
  'flux-pro': { sizes: ['512x512', '768x768', '1024x1024', '1536x1024', '1024x1536'], edit: false, transparent: true, maxN: 4, format: 'url' },
  // Stable Diffusion
  'stable-diffusion-xl': { sizes: ['512x512', '768x768', '1024x1024'], edit: true, transparent: false, maxN: 4, format: 'url' },
}

function getModelCapabilities(model) {
  // 1. Exact match
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model]
  // 2. Prefix match: known model name is prefix of user's model (e.g. "gpt-image-2-turbo" starts with "gpt-image-2")
  const lower = model.toLowerCase()
  for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.startsWith(key)) return caps
  }
  // 3. Contains match: user's model contains known name (e.g. "my-gpt-image-2-fork" contains "gpt-image-2")
  for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.includes(key)) return caps
  }
  // 4. Pattern-based defaults
  if (/image/i.test(lower)) return { sizes: ['512x512', '1024x1024'], edit: false, transparent: false, maxN: 4, format: 'url' }
  // Unknown
  return null
}

function loadProviderFromEnv(prefix) {
  const name = process.env[`${prefix}_NAME`]
  const baseUrl = process.env[`${prefix}_BASE_URL`]
  const apiKey = process.env[`${prefix}_API_KEY`]
  const model = process.env[`${prefix}_MODEL`]

  if (isUnset(baseUrl) || isUnset(apiKey) || isUnset(model)) return null

  const cleanedUrl = baseUrl.replace(/\/+$/, '')

  // Validate provider baseUrl is not a private/internal address
  try {
    validateUrlSafety(cleanedUrl, `${prefix}_BASE_URL`)
  } catch (err) {
    console.error(`[image-gen] Skipping ${prefix}: ${err.message}`)
    return null
  }

  return {
    name: (!isUnset(name) && name) || model,
    baseUrl: cleanedUrl,
    apiKey,
    model,
    enabled: true,
    timeoutMs: 300_000,
    capabilities: getModelCapabilities(model),
  }
}

function loadProviders() {
  const providers = []

  for (let i = 1; i <= 3; i++) {
    const p = loadProviderFromEnv(`IMAGE_GEN_P${i}`)
    if (p) providers.push(p)
  }

  if (providers.length === 0) {
    return []
  }

  return providers
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function trimSlash(s) {
  return s.replace(/\/+$/, '')
}

function jsonHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function pickError(data, fallback) {
  if (data?.error) {
    if (typeof data.error === 'string') return data.error
    if (typeof data.error?.message === 'string') return data.error.message
  }
  if (typeof data?.message === 'string') return data.message
  return fallback
}

function extensionFromMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/png':
    default:
      return 'png'
  }
}

async function saveImageBuffer(buffer, outputDir, mimeType = 'image/png') {
  if (!outputDir || typeof outputDir !== 'string' || outputDir.trim() === '') return null
  const dir = path.resolve(outputDir)
  await mkdir(dir, { recursive: true })
  const filename = `image-${Date.now()}-${randomUUID()}.${extensionFromMime(mimeType)}`
  const filePath = path.join(dir, filename)
  await writeFile(filePath, buffer)
  return filePath
}

async function saveBase64Image(base64, outputDir, mimeType = 'image/png') {
  return saveImageBuffer(Buffer.from(base64, 'base64'), outputDir, mimeType)
}

async function saveUrlImage(imageUrl, outputDir) {
  if (!outputDir || typeof outputDir !== 'string' || outputDir.trim() === '') return null
  validateUrlSafety(imageUrl, 'image_url')
  const res = await fetchWithTimeout(imageUrl, { method: 'GET' }, 30_000)
  if (!res.ok) throw new Error(`下载生成图失败: HTTP ${res.status}`)
  const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png'
  if (!mimeType.startsWith('image/')) throw new Error(`下载生成图失败: 响应不是图片 (${mimeType})`)
  const buffer = Buffer.from(await res.arrayBuffer())
  return saveImageBuffer(buffer, outputDir, mimeType)
}

// ─── Compatibility fallback (from spriteflow) ─────────────────────────────────

function shouldRetryWithMinimalPayload(error) {
  const msg = error instanceof Error ? error.message : String(error || '')
  return /ECONNRESET|connection was reset|unsupported.*response_format|unsupported.*background|unknown parameter|unrecognized parameter/i.test(msg)
}

function buildImageBody(model, prompt, size, n, transparent, minimal) {
  const body = { model, prompt, n: n || 1, size: size || '1024x1024' }
  if (!minimal) {
    body.response_format = 'b64_json'
    if (transparent) body.background = 'transparent'
  }
  return body
}

async function resolveImageResult(data) {
  const first = data?.data?.[0]
  if (!first) throw new Error('图像接口没有返回数据')
  if (first.b64_json) return { type: 'base64', data: first.b64_json }
  if (first.url) return { type: 'url', data: first.url }
  throw new Error('图像响应缺少 b64_json 或 url')
}

// ─── Core: generate with provider fallback ────────────────────────────────────

function shouldRetryWithV1Prefix(baseUrl, error) {
  const msg = error instanceof Error ? error.message : String(error || '')
  return /HTTP (403|404)/.test(msg) && !/\/v1(\/|$)/.test(baseUrl)
}

async function generateWithFallback(prompt, size, n, transparent, providers) {
  const errors = []

  for (const provider of providers) {
    if (!provider.enabled && provider.enabled !== undefined) continue
    const baseUrl = trimSlash(provider.baseUrl)
    const url = `${baseUrl}/images/generations`
    const timeoutMs = provider.timeoutMs || 300_000

    // Attempt 1: full params
    try {
      const body = buildImageBody(provider.model, prompt, size, n, transparent, false)
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: jsonHeaders(provider.apiKey),
        body: JSON.stringify(body),
      }, timeoutMs)
      const data = await readJson(res)
      if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
      const result = await resolveImageResult(data)
      return { ...result, provider: provider.name, model: provider.model, warnings: [] }
    } catch (err1) {
      // Attempt 2: retry with /v1 prefix if base URL is missing it (common misconfiguration)
      if (shouldRetryWithV1Prefix(baseUrl, err1)) {
        const v1Url = `${baseUrl}/v1/images/generations`
        // Try /v1 with full params first
        try {
          const body = buildImageBody(provider.model, prompt, size, n, transparent, false)
          const res = await fetchWithTimeout(v1Url, {
            method: 'POST',
            headers: jsonHeaders(provider.apiKey),
            body: JSON.stringify(body),
          }, timeoutMs)
          const data = await readJson(res)
          if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
          const result = await resolveImageResult(data)
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 自动添加 /v1 前缀重试成功（建议更新 BASE_URL 为 ${baseUrl}/v1）`],
          }
        } catch (err1v1) {
          // Try /v1 with minimal params (some providers reject response_format etc.)
          try {
            const body = buildImageBody(provider.model, prompt, size, n, transparent, true)
            const res = await fetchWithTimeout(v1Url, {
              method: 'POST',
              headers: jsonHeaders(provider.apiKey),
              body: JSON.stringify(body),
            }, timeoutMs)
            const data = await readJson(res)
            if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
            const result = await resolveImageResult(data)
            return {
              ...result,
              provider: provider.name,
              model: provider.model,
              warnings: [`[${provider.name}] 自动添加 /v1 前缀 + 兼容模式重试成功（建议更新 BASE_URL 为 ${baseUrl}/v1）`],
            }
          } catch {
            // Fall through to other retry strategies
          }
        }
      }
      // Attempt 3: minimal params (compatibility fallback)
      if (shouldRetryWithMinimalPayload(err1)) {
        try {
          const body = buildImageBody(provider.model, prompt, size, n, transparent, true)
          const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: jsonHeaders(provider.apiKey),
            body: JSON.stringify(body),
          }, timeoutMs)
          const data = await readJson(res)
          if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
          const result = await resolveImageResult(data)
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 使用兼容模式（精简参数）重试成功`],
          }
        } catch (err2) {
          errors.push({ provider: provider.name, error: err2.message })
          continue
        }
      }
      errors.push({ provider: provider.name, error: err1.message })
    }
  }

  return {
    type: 'error',
    error: `所有 provider 均失败:\n${errors.map(e => `  - ${e.provider}: ${e.error}`).join('\n')}`,
  }
}

// ─── Core: edit with provider fallback ────────────────────────────────────────

async function editWithFallback(prompt, imageUrl, size, n, transparent, providers) {
  const errors = []

  for (const provider of providers) {
    if (!provider.enabled && provider.enabled !== undefined) continue
    const baseUrl = trimSlash(provider.baseUrl)
    const url = `${baseUrl}/images/edits`
    const timeoutMs = provider.timeoutMs || 600_000

    // Fetch reference image as blob (with SSRF protection)
    let imageBlob
    try {
      if (imageUrl.startsWith('data:')) {
        const [meta, b64] = imageUrl.split(',')
        const mime = meta.match(/data:([^;]+)/)?.[1] || 'image/png'
        const buf = Buffer.from(b64, 'base64')
        imageBlob = new Blob([buf], { type: mime })
      } else {
        validateUrlSafety(imageUrl, 'image_url')
        const imgRes = await fetchWithTimeout(imageUrl, { method: 'GET' }, 30_000)
        if (!imgRes.ok) throw new Error(`下载参考图失败: HTTP ${imgRes.status}`)
        imageBlob = await imgRes.blob()
      }
    } catch (imgErr) {
      errors.push({ provider: provider.name, error: `参考图获取失败: ${imgErr.message}` })
      continue
    }

    async function attemptEdit(editUrl, form) {
      const res = await fetchWithTimeout(editUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: form,
      }, timeoutMs)
      const data = await readJson(res)
      if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
      return resolveImageResult(data)
    }

    function buildFullForm() {
      const form = new FormData()
      form.set('model', provider.model)
      form.set('prompt', prompt)
      form.set('n', String(n || 1))
      form.set('size', size || '1024x1024')
      form.set('response_format', 'b64_json')
      if (transparent) form.set('background', 'transparent')
      form.append('image', imageBlob, 'reference.png')
      return form
    }

    function buildMinimalForm() {
      const form = new FormData()
      form.set('model', provider.model)
      form.set('prompt', prompt)
      form.set('n', String(n || 1))
      form.set('size', size || '1024x1024')
      form.append('image', imageBlob, 'reference.png')
      return form
    }

    // Attempt 1: full params
    try {
      const result = await attemptEdit(url, buildFullForm())
      return { ...result, provider: provider.name, model: provider.model, warnings: [] }
    } catch (err1) {
      // Attempt 2: retry with /v1 prefix if base URL is missing it
      if (shouldRetryWithV1Prefix(baseUrl, err1)) {
        try {
          const v1Url = `${baseUrl}/v1/images/edits`
          const result = await attemptEdit(v1Url, buildFullForm())
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 自动添加 /v1 前缀重试成功（建议更新 BASE_URL 为 ${baseUrl}/v1）`],
          }
        } catch (err1v1) {
          // Fall through to minimal payload attempt
        }
      }
      // Attempt 3: minimal params
      if (shouldRetryWithMinimalPayload(err1)) {
        try {
          const result = await attemptEdit(url, buildMinimalForm())
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 使用兼容模式（精简参数）重试成功`],
          }
        } catch (err2) {
          errors.push({ provider: provider.name, error: err2.message })
          continue
        }
      }
      errors.push({ provider: provider.name, error: err1.message })
    }
  }

  return {
    type: 'error',
    error: `所有 provider 均失败:\n${errors.map(e => `  - ${e.provider}: ${e.error}`).join('\n')}`,
  }
}

// ─── List models for a provider ───────────────────────────────────────────────

async function listModelsForProvider(provider) {
  const baseUrl = trimSlash(provider.baseUrl)
  const timeoutMs = Math.min(60_000, provider.timeoutMs || 60_000)

  async function tryFetchModels(modelsUrl) {
    const res = await fetchWithTimeout(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
    }, timeoutMs)
    const data = await readJson(res)
    if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
    const ids = Array.isArray(data?.data)
      ? data.data.map(m => typeof m === 'string' ? m : m?.id).filter(Boolean)
      : []
    return { success: true, models: ids }
  }

  try {
    return await tryFetchModels(`${baseUrl}/models`)
  } catch (err) {
    // Retry with /v1 prefix if missing
    if (shouldRetryWithV1Prefix(baseUrl, err)) {
      try {
        return await tryFetchModels(`${baseUrl}/v1/models`)
      } catch {
        // fall through
      }
    }
    return { success: false, error: err.message, models: [] }
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. Tries providers in priority order with automatic fallback. Supports any OpenAI-compatible image generation API (Agnes, GPT-image-2, Gemini, DALL-E, Flux, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate',
        },
        size: {
          type: 'string',
          description: 'Image size (e.g. "1024x1024", "512x512", "auto"). Default: 1024x1024',
          default: '1024x1024',
        },
        n: {
          type: 'number',
          description: 'Number of images to generate. Default: 1',
          default: 1,
        },
        transparent: {
          type: 'boolean',
          description: 'Request transparent background (not supported by all providers). Default: false',
          default: false,
        },
        output_dir: {
          type: 'string',
          description: 'Optional local directory to save generated images. When omitted, images are returned without saving to disk.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: 'Edit an existing image using a text prompt and a reference image. Tries providers in priority order with automatic fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the desired edit',
        },
        image_url: {
          type: 'string',
          description: 'URL or data URL of the reference image to edit',
        },
        size: {
          type: 'string',
          description: 'Output image size. Default: 1024x1024',
          default: '1024x1024',
        },
        n: {
          type: 'number',
          description: 'Number of images to generate. Default: 1',
          default: 1,
        },
        transparent: {
          type: 'boolean',
          description: 'Request transparent background. Default: false',
          default: false,
        },
        output_dir: {
          type: 'string',
          description: 'Optional local directory to save edited images. When omitted, images are returned without saving to disk.',
        },
      },
      required: ['prompt', 'image_url'],
    },
  },
  {
    name: 'list_providers',
    description: 'List all configured image generation providers with their status and priority order.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_models',
    description: 'List available models from all configured providers (calls each provider\'s /v1/models endpoint).',
    inputSchema: {
      type: 'object',
      properties: {
        provider_index: {
          type: 'number',
          description: 'Only query a specific provider by index (0-based). Omit to query all.',
        },
      },
    },
  },
]

// ─── MCP JSON-RPC server ──────────────────────────────────────────────────────

async function formatResult(result, outputDir) {
  if (result.type === 'error') {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    }
  }

  const parts = []
  const meta = []
  let savedPath = null

  if (result.type === 'base64') {
    savedPath = await saveBase64Image(result.data, outputDir, 'image/png')
    if (savedPath) {
      parts.push({
        type: 'text',
        text: `![generated-image](${pathToFileURL(savedPath).href})`,
      })
    } else {
      parts.push({
        type: 'image',
        data: result.data,
        mimeType: 'image/png',
      })
    }
  }

  if (result.type === 'url') {
    savedPath = await saveUrlImage(result.data, outputDir)
    const displayUrl = savedPath ? pathToFileURL(savedPath).href : result.data
    // MCP content schema only allows text/image/audio/resource/resource_link.
    // We return the URL in a standard text block. The CLI MCP client layer
    // (transformResultContent) detects image URLs and converts them to
    // Anthropic API's {type:'image', source:{type:'url', url}} format,
    // which avoids accumulating base64 data in conversation history.
    // Desktop's extractImageBlocks also handles image_url annotations
    // embedded in the _meta field for inline rendering.
    parts.push({
      type: 'text',
      text: `![generated-image](${displayUrl})`,
    })
  }

  if (result.provider) meta.push(`Provider: ${result.provider}`)
  if (result.model) meta.push(`Model: ${result.model}`)
  if (result.warnings?.length) meta.push(...result.warnings)
  if (result.type === 'url') meta.push(`URL: ${result.data}`)
  if (savedPath) meta.push(`Saved to: ${savedPath}`)
  if (meta.length) parts.push({ type: 'text', text: meta.join('\n') })

  // Attach image_url annotation for Desktop inline rendering (non-standard
  // but safe: _meta is ignored by MCP schema validation, and Desktop's
  // extractImageBlocks reads it for URL-based images).
  if (result.type === 'url') {
    return {
      content: parts,
      isError: false,
      _meta: { imageUrls: [savedPath ? pathToFileURL(savedPath).href : result.data] },
    }
  }

  return { content: parts, isError: false }
}

// Cache providers at startup (env vars don't change during process lifetime)
const cachedProviders = loadProviders()

async function handleToolCall(name, args) {
  const providers = cachedProviders

  if (providers.length === 0) {
    return {
      content: [{ type: 'text', text: '没有可用的 provider。请在插件配置中设置 PROVIDERS_JSON。' }],
      isError: true,
    }
  }

  switch (name) {
    case 'generate_image': {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: prompt is required and must be a non-empty string.' }], isError: true }
      }
      const firstCaps = providers[0]?.capabilities
      const maxN = firstCaps?.maxN || 10
      const n = Math.min(Math.max(Math.floor(Number(args.n) || 1), 1), maxN)
      const requestedSize = args.size || '1024x1024'
      if (firstCaps && firstCaps.sizes.length > 0 && !firstCaps.sizes.includes(requestedSize) && requestedSize !== 'auto') {
        return {
          content: [{ type: 'text', text: `Size "${requestedSize}" may not be supported by ${providers[0].model}. Supported sizes: ${firstCaps.sizes.join(', ')}. Will attempt anyway with compatibility fallback.` }],
          isError: false,
        }
      }
      const result = await generateWithFallback(
        args.prompt.trim(),
        requestedSize,
        n,
        args.transparent,
        providers,
      )
      return await formatResult(result, args.output_dir)
    }

    case 'edit_image': {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: prompt is required.' }], isError: true }
      }
      if (!args.image_url || typeof args.image_url !== 'string') {
        return { content: [{ type: 'text', text: 'Error: image_url is required.' }], isError: true }
      }
      const editProviders = providers.filter(p => p.capabilities?.edit !== false)
      if (editProviders.length === 0) {
        return {
          content: [{ type: 'text', text: 'None of the configured providers support image editing. Use generate_image instead, or add a provider that supports editing (e.g., gpt-image-2, gemini-2.5-flash-image-preview).' }],
          isError: true,
        }
      }
      const result = await editWithFallback(
        args.prompt.trim(),
        args.image_url,
        args.size || '1024x1024',
        args.n || 1,
        args.transparent,
        editProviders,
      )
      return await formatResult(result, args.output_dir)
    }

    case 'list_providers': {
      const lines = providers.map((p, i) => {
        const status = p.enabled === false ? ' [DISABLED]' : ''
        const caps = p.capabilities
        let capStr = ''
        if (caps) {
          const parts = []
          parts.push(`sizes: ${caps.sizes.join(', ')}`)
          if (caps.edit) parts.push('supports edit')
          if (caps.transparent) parts.push('supports transparent')
          parts.push(`max n: ${caps.maxN}`)
          parts.push(`returns: ${caps.format}`)
          if (caps.notes) parts.push(`note: ${caps.notes}`)
          capStr = `\n   capabilities: ${parts.join(' | ')}`
        } else {
          capStr = '\n   capabilities: unknown (will try all params, fallback on error)'
        }
        return `${i}. ${p.name}${status}\n   baseUrl: ${p.baseUrl}\n   model: ${p.model}${capStr}`
      })
      return {
        content: [{ type: 'text', text: `Configured providers (${providers.length}):\n\n${lines.join('\n\n')}` }],
        isError: false,
      }
    }

    case 'list_models': {
      const indices = args?.provider_index !== undefined
        ? [args.provider_index]
        : providers.map((_, i) => i)

      const results = []
      for (const idx of indices) {
        const p = providers[idx]
        if (!p) {
          results.push(`[${idx}] INVALID INDEX`)
          continue
        }
        const r = await listModelsForProvider(p)
        if (r.success) {
          const imageModels = r.models.filter(m =>
            /image|img|vision|dall|flux|stable|banana|gemini.*image|gpt-image|agnes-image/i.test(m)
          )
          results.push(`${p.name} (${r.models.length} models, ${imageModels.length} image models):\n  Image models: ${imageModels.join(', ') || '(none matched)'}\n  All: ${r.models.join(', ')}`)
        } else {
          results.push(`${p.name}: ERROR - ${r.error}`)
        }
      }
      return {
        content: [{ type: 'text', text: results.join('\n\n') }],
        isError: false,
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }
  }
}

// ─── Stdio JSON-RPC transport ─────────────────────────────────────────────────

const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB

function sendResponse(id, result) {
  const msg = { jsonrpc: '2.0', id, result }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendError(id, code, message) {
  const msg = { jsonrpc: '2.0', id, error: { code, message } }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendNotification(method, params) {
  const msg = { jsonrpc: '2.0', method, params }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handleMessage(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'image-gen',
          version: '1.0.0',
        },
      })
      break

    case 'notifications/initialized':
      // no response needed for notification
      break

    case 'tools/list':
      sendResponse(id, { tools: TOOLS })
      break

    case 'tools/call': {
      try {
        const result = await handleToolCall(params.name, params.arguments || {})
        sendResponse(id, result)
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        })
      }
      break
    }

    case 'ping':
      sendResponse(id, {})
      break

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`)
      }
      break
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const rl = createInterface({ input: process.stdin })

  let buffer = ''
  const pending = new Set()

  rl.on('line', (line) => {
    buffer += line
    if (buffer.length > MAX_BUFFER_SIZE) {
      console.error(`[image-gen] Buffer overflow (>1MB), resetting`)
      buffer = ''
      return
    }
    try {
      const msg = JSON.parse(buffer)
      buffer = ''
      const p = handleMessage(msg).catch(err => {
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, `Internal error: ${err.message}`)
        }
      }).finally(() => pending.delete(p))
      pending.add(p)
    } catch {
      // Incomplete message, wait for more lines
    }
  })

  rl.on('close', async () => {
    // Wait for all pending message handlers to complete before exiting
    if (pending.size > 0) {
      await Promise.allSettled([...pending])
    }
    process.exit(0)
  })

  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))

  // Log to stderr (not stdout, which is reserved for JSON-RPC)
  console.error('[image-gen] MCP server started')
}

main()
