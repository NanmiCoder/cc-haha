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

// ─── Config ───────────────────────────────────────────────────────────────────

function isUnset(val) {
  return !val || val.trim() === '' || val.startsWith('${user_config.')
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
  // Exact match
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model]
  // Partial match
  const lower = model.toLowerCase()
  for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.includes(key) || key.includes(lower)) return caps
  }
  // Pattern-based defaults
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

  return {
    name: (!isUnset(name) && name) || model,
    baseUrl: baseUrl.replace(/\/+$/, ''),
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
      // Attempt 2: minimal params (compatibility fallback)
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
        const parsed = new URL(imageUrl)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error(`不允许的 URL 协议: ${parsed.protocol}。仅支持 http/https/data URL。`)
        }
        // Block private/link-local IP ranges
        const hostname = parsed.hostname
        if (
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '::1' ||
          hostname.startsWith('169.254.') ||
          hostname.startsWith('10.') ||
          hostname.startsWith('192.168.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
        ) {
          throw new Error(`不允许访问内网地址: ${hostname}`)
        }
        const imgRes = await fetchWithTimeout(imageUrl, { method: 'GET' }, 30_000)
        if (!imgRes.ok) throw new Error(`下载参考图失败: HTTP ${imgRes.status}`)
        imageBlob = await imgRes.blob()
      }
    } catch (imgErr) {
      errors.push({ provider: provider.name, error: `参考图获取失败: ${imgErr.message}` })
      continue
    }

    // Attempt 1: full params
    try {
      const form = new FormData()
      form.set('model', provider.model)
      form.set('prompt', prompt)
      form.set('n', String(n || 1))
      form.set('size', size || '1024x1024')
      form.set('response_format', 'b64_json')
      if (transparent) form.set('background', 'transparent')
      form.append('image', imageBlob, 'reference.png')

      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: form,
      }, timeoutMs)
      const data = await readJson(res)
      if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
      const result = await resolveImageResult(data)
      return { ...result, provider: provider.name, model: provider.model, warnings: [] }
    } catch (err1) {
      // Attempt 2: minimal params
      if (shouldRetryWithMinimalPayload(err1)) {
        try {
          const form = new FormData()
          form.set('model', provider.model)
          form.set('prompt', prompt)
          form.set('n', String(n || 1))
          form.set('size', size || '1024x1024')
          form.append('image', imageBlob, 'reference.png')

          const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${provider.apiKey}` },
            body: form,
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

// ─── List models for a provider ───────────────────────────────────────────────

async function listModelsForProvider(provider) {
  const baseUrl = trimSlash(provider.baseUrl)
  const url = `${baseUrl}/models`
  const timeoutMs = Math.min(60_000, provider.timeoutMs || 60_000)
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
    }, timeoutMs)
    const data = await readJson(res)
    if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
    const ids = Array.isArray(data?.data)
      ? data.data.map(m => typeof m === 'string' ? m : m?.id).filter(Boolean)
      : []
    return { success: true, models: ids }
  } catch (err) {
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

function formatResult(result) {
  if (result.type === 'error') {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    }
  }

  const parts = []

  if (result.type === 'base64') {
    parts.push({
      type: 'image',
      data: result.data,
      mimeType: 'image/png',
    })
  }

  const meta = []
  if (result.provider) meta.push(`Provider: ${result.provider}`)
  if (result.model) meta.push(`Model: ${result.model}`)
  if (result.warnings?.length) meta.push(...result.warnings)
  if (result.type === 'url') meta.push(`URL: ${result.data}`)
  if (meta.length) parts.push({ type: 'text', text: meta.join('\n') })

  return { content: parts, isError: false }
}

async function handleToolCall(name, args) {
  const providers = loadProviders()

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
      return formatResult(result)
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
      return formatResult(result)
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
      handleMessage(msg).catch(err => {
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, `Internal error: ${err.message}`)
        }
      })
    } catch {
      // Incomplete message, wait for more lines
    }
  })

  rl.on('close', () => {
    process.exit(0)
  })

  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))

  // Log to stderr (not stdout, which is reserved for JSON-RPC)
  console.error('[image-gen] MCP server started')
}

main()
