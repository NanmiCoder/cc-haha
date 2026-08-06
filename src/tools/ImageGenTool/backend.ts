import { randomUUID } from 'crypto'
import { constants as fsConstants } from 'fs'
import { chmod, mkdir, open, realpath, stat } from 'fs/promises'
import { basename, join, relative, resolve } from 'path'

import { getSessionId } from '../../bootstrap/state.js'
import {
  OPENAI_CODEX_API_ENDPOINT,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_TOKEN_USER_AGENT,
} from '../../services/openaiAuth/client.js'
import { ensureFreshOpenAITokens } from '../../services/openaiAuth/index.js'
import { OPENAI_DEFAULT_MAIN_MODEL } from '../../services/openaiAuth/models.js'
import {
  ensureFreshGrokTokens,
  forceRefreshGrokTokens,
} from '../../services/grokAuth/refresh.js'
import type {
  ImageGenerationProviderKind,
  ImageGenerationRuntimeConfig,
} from '../../services/imageGeneration/config.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { getCcHahaDir, getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

export type ImageGenerationInput = {
  prompt: string
  count: number
  referenced_image_paths?: string[]
  aspect_ratio?: string
  resolution?: '1k' | '2k'
  size?: 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
  quality?: 'auto' | 'low' | 'medium' | 'high'
  background?: 'auto' | 'opaque' | 'transparent'
  output_format?: 'png' | 'jpeg' | 'webp'
}

export type GeneratedImage = {
  path: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  revisedPrompt?: string
}

export type ImageGenerationOutput = {
  type: 'image_generation_result'
  operation: 'generate' | 'edit'
  inputImageCount: number
  providerId: string
  providerKind: ImageGenerationProviderKind
  model: string
  prompt: string
  images: GeneratedImage[]
  durationMs: number
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type RawGeneratedImage = {
  b64Json?: string
  url?: string
  mimeType?: string
  revisedPrompt?: string
}

export type PreparedInputImage = {
  dataUrl: string
  fileName: string
  mimeType: GeneratedImage['mimeType']
  bytes: Buffer
}

type GenerateOptions = {
  fetchImpl?: FetchLike
  outputDir?: string
  inputRootDirs?: string[]
  signal?: AbortSignal
}

const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_ERROR_BODY_CHARS = 500

export async function generateImages(
  input: ImageGenerationInput,
  config: ImageGenerationRuntimeConfig,
  options: GenerateOptions = {},
): Promise<ImageGenerationOutput> {
  const startedAt = Date.now()
  const model = config.model
  const fetchImpl = options.fetchImpl ?? fetch
  const { signal, cleanup } = createCombinedAbortSignal(options.signal, {
    timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
  })

  try {
    const inputImages = await prepareInputImages(input, options.inputRootDirs)
    const rawImages = await requestImages(
      { ...input, model },
      config,
      fetchImpl,
      signal,
      inputImages,
    )
    if (rawImages.length === 0) {
      throw new Error('The image provider completed without returning an image.')
    }

    const outputDir = options.outputDir ?? defaultOutputDir()
    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    await chmod(outputDir, 0o700).catch(() => {})

    const images: GeneratedImage[] = []
    for (const [index, rawImage] of rawImages.slice(0, input.count).entries()) {
      const bytes = await resolveImageBytes(
        rawImage,
        config.kind,
        fetchImpl,
        signal,
      )
      images.push(
        await persistImage(outputDir, bytes, index, rawImage.revisedPrompt),
      )
    }

    if (images.length === 0) {
      throw new Error('The image provider returned no usable image output.')
    }

    return {
      type: 'image_generation_result',
      operation: inputImages.length > 0 ? 'edit' : 'generate',
      inputImageCount: inputImages.length,
      providerId: config.providerId,
      providerKind: config.kind,
      model,
      prompt: input.prompt,
      images,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    cleanup()
  }
}

async function requestImages(
  input: ImageGenerationInput & { model: string },
  config: ImageGenerationRuntimeConfig,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  inputImages: PreparedInputImage[],
): Promise<RawGeneratedImage[]> {
  switch (config.kind) {
    case 'openai_oauth':
      return requestChatGPTImages(input, fetchImpl, signal, inputImages)
    case 'grok_oauth':
      return requestGrokImages(input, fetchImpl, signal, inputImages)
    case 'openai_images':
      return requestCompatibleImages(input, config, fetchImpl, signal, inputImages)
  }
}

async function requestChatGPTImages(
  input: ImageGenerationInput & { model: string },
  fetchImpl: FetchLike,
  signal: AbortSignal,
  inputImages: PreparedInputImage[],
): Promise<RawGeneratedImage[]> {
  const tokens = await ensureFreshOpenAITokens()
  if (!tokens) {
    throw new Error(
      'ChatGPT OAuth is missing or expired. Reconnect ChatGPT in provider settings.',
    )
  }

  const headers = new Headers({
    Accept: 'text/event-stream',
    Authorization: `Bearer ${tokens.accessToken}`,
    'Content-Type': 'application/json',
    originator: OPENAI_CODEX_ORIGINATOR,
    'User-Agent': OPENAI_CODEX_TOKEN_USER_AGENT,
  })
  if (tokens.accountId) {
    headers.set('ChatGPT-Account-Id', tokens.accountId)
  }

  const images: RawGeneratedImage[] = []
  for (const body of buildChatGPTRequestBodies(input, inputImages)) {
    const response = await performFetch(
      fetchImpl,
      OPENAI_CODEX_API_ENDPOINT,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      },
    )
    await assertUpstreamSuccess(
      response,
      'ChatGPT image generation',
      [tokens.accessToken],
    )
    const generated = parseChatGPTImageStream(await response.text())
    if (!generated[0]) {
      throw new Error('ChatGPT completed without returning an image.')
    }
    images.push(generated[0])
  }
  return images
}

async function requestGrokImages(
  input: ImageGenerationInput & { model: string },
  fetchImpl: FetchLike,
  signal: AbortSignal,
  inputImages: PreparedInputImage[],
): Promise<RawGeneratedImage[]> {
  let tokens = await ensureFreshGrokTokens()
  if (!tokens) {
    throw new Error(
      'Grok OAuth is missing or expired. Reconnect Grok in provider settings.',
    )
  }

  const url = inputImages.length > 0
    ? 'https://api.x.ai/v1/images/edits'
    : 'https://api.x.ai/v1/images/generations'
  const body = inputImages.length > 0
    ? buildGrokEditRequestBody(input, inputImages)
    : buildGrokRequestBody(input)
  let response = await postImages(fetchImpl, url, tokens.accessToken, body, signal)
  if (response.status === 401) {
    tokens = await forceRefreshGrokTokens().catch(() => null)
    if (tokens) {
      response = await postImages(fetchImpl, url, tokens.accessToken, body, signal)
    }
  }
  await assertUpstreamSuccess(
    response,
    'Grok image generation',
    [tokens.accessToken],
  )
  return parseCompatibleImageResponse(await response.json())
}

async function requestCompatibleImages(
  input: ImageGenerationInput & { model: string },
  config: ImageGenerationRuntimeConfig,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  inputImages: PreparedInputImage[],
): Promise<RawGeneratedImage[]> {
  if (!config.baseUrl || !config.apiKey) {
    throw new Error('The configured image API is missing a Base URL or API key.')
  }

  const url = inputImages.length > 0
    ? buildImagesEditUrl(config.baseUrl)
    : buildImagesGenerationUrl(config.baseUrl)
  const images: RawGeneratedImage[] = []
  const bodies = inputImages.length > 0
    ? buildCompatibleEditBodies(input, inputImages)
    : buildCompatibleRequestBodies(input)
  for (const body of bodies) {
    const response = body instanceof FormData
      ? await postMultipartImages(fetchImpl, url, config.apiKey, body, signal)
      : await postImages(fetchImpl, url, config.apiKey, body, signal)
    await assertUpstreamSuccess(
      response,
      'Custom image generation',
      [config.apiKey],
    )
    const generated = parseCompatibleImageResponse(await response.json())
    if (!generated[0]) {
      throw new Error('Custom image generation completed without returning an image.')
    }
    images.push(generated[0])
  }
  return images
}

export function buildCompatibleRequestBody(
  input: ImageGenerationInput & { model: string },
): Record<string, unknown> {
  return compactObject({
    model: input.model,
    prompt: input.prompt,
    response_format: 'b64_json',
    size: input.size ?? sizeForAspectRatio(input.aspect_ratio),
    quality: input.quality,
    background: input.background,
    output_format: input.output_format,
  })
}

export function buildCompatibleRequestBodies(
  input: ImageGenerationInput & { model: string },
): Record<string, unknown>[] {
  return Array.from(
    { length: input.count },
    () => buildCompatibleRequestBody({ ...input, count: 1 }),
  )
}

export function buildCompatibleEditBodies(
  input: ImageGenerationInput & { model: string },
  inputImages: PreparedInputImage[],
): FormData[] {
  return Array.from(
    { length: input.count },
    () => buildCompatibleEditBody(input, inputImages),
  )
}

function buildCompatibleEditBody(
  input: ImageGenerationInput & { model: string },
  inputImages: PreparedInputImage[],
): FormData {
  const form = new FormData()
  form.set('model', input.model)
  form.set('prompt', input.prompt)
  form.set('response_format', 'b64_json')
  const values = compactObject({
    size: input.size ?? sizeForAspectRatio(input.aspect_ratio),
    quality: input.quality,
    background: input.background,
    output_format: input.output_format,
  })
  for (const [key, value] of Object.entries(values)) {
    form.set(key, String(value))
  }
  for (const image of inputImages) {
    form.append(
      'image[]',
      new Blob([image.bytes], { type: image.mimeType }),
      image.fileName,
    )
  }
  return form
}

export function buildChatGPTRequestBody(
  input: ImageGenerationInput & { model: string },
  inputImages: PreparedInputImage[] = [],
): Record<string, unknown> {
  const imageTool = compactObject({
    type: 'image_generation',
    action: inputImages.length > 0 ? 'edit' : 'generate',
    model: input.model,
    size: input.size ?? sizeForAspectRatio(input.aspect_ratio),
    quality: input.quality,
    background: input.background,
    output_format: input.output_format,
  })
  return {
    instructions: '',
    stream: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    model: process.env.ANTHROPIC_MODEL?.trim() || OPENAI_DEFAULT_MAIN_MODEL,
    store: false,
    tool_choice: { type: 'image_generation' },
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: input.prompt },
        ...inputImages.map((image) => ({
          type: 'input_image',
          image_url: image.dataUrl,
        })),
      ],
    }],
    tools: [imageTool],
  }
}

export function buildChatGPTRequestBodies(
  input: ImageGenerationInput & { model: string },
  inputImages: PreparedInputImage[] = [],
): Record<string, unknown>[] {
  return Array.from(
    { length: input.count },
    () => buildChatGPTRequestBody({ ...input, count: 1 }, inputImages),
  )
}

export function buildGrokRequestBody(
  input: ImageGenerationInput & { model: string },
): Record<string, unknown> {
  return compactObject({
    model: input.model,
    prompt: input.prompt,
    n: input.count,
    response_format: 'b64_json',
    aspect_ratio: input.aspect_ratio ?? aspectRatioForSize(input.size),
    resolution: input.resolution,
  })
}

export function buildGrokEditRequestBody(
  input: ImageGenerationInput & { model: string },
  inputImages: PreparedInputImage[],
): Record<string, unknown> {
  const sources = inputImages.map((image) => ({
    type: 'image_url',
    url: image.dataUrl,
  }))
  return compactObject({
    model: input.model,
    prompt: input.prompt,
    n: input.count,
    response_format: 'b64_json',
    aspect_ratio: input.aspect_ratio ?? aspectRatioForSize(input.size),
    resolution: input.resolution,
    ...(sources.length === 1
      ? { image: sources[0] }
      : { images: sources }),
  })
}

async function postImages(
  fetchImpl: FetchLike,
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return performFetch(fetchImpl, url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
}

async function postMultipartImages(
  fetchImpl: FetchLike,
  url: string,
  accessToken: string,
  body: FormData,
  signal: AbortSignal,
): Promise<Response> {
  return performFetch(fetchImpl, url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body,
    signal,
  })
}

async function performFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    ...getProxyFetchOptions({ targetUrl: url }),
  } as RequestInit)
}

async function assertUpstreamSuccess(
  response: Response,
  label: string,
  secrets: string[] = [],
): Promise<void> {
  if (response.ok) return
  const errorBody = await response.text().catch(() => '')
  const detail = safeUpstreamError(errorBody, secrets)
  throw new Error(
    `${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
  )
}

function safeUpstreamError(body: string, secrets: string[]): string {
  const withoutExactSecrets = secrets
    .filter(Boolean)
    .reduce((value, secret) => value.split(secret).join('[redacted]'), body)
  const compact = withoutExactSecrets
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
  return compact.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_BODY_CHARS)
}

export function buildImagesGenerationUrl(baseUrl: string): string {
  return buildImagesApiUrl(baseUrl, 'generations')
}

export function buildImagesEditUrl(baseUrl: string): string {
  return buildImagesApiUrl(baseUrl, 'edits')
}

function buildImagesApiUrl(
  baseUrl: string,
  operation: 'generations' | 'edits',
): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Image API Base URL must use HTTP or HTTPS.')
  }

  const pathname = url.pathname.replace(/\/+$/, '')
  if (/\/images\/(?:generations|edits)$/i.test(pathname)) {
    url.pathname = pathname.replace(/(?:generations|edits)$/i, operation)
  } else if (/\/v1$/i.test(pathname)) {
    url.pathname = `${pathname}/images/${operation}`
  } else {
    url.pathname = `${pathname}/v1/images/${operation}`
  }
  return url.toString()
}

export function parseCompatibleImageResponse(value: unknown): RawGeneratedImage[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  return value.data.flatMap((item): RawGeneratedImage[] => {
    if (!isRecord(item)) return []
    const b64Json = stringValue(item.b64_json)
    const url = stringValue(item.url)
    if (!b64Json && !url) return []
    return [{
      ...(b64Json ? { b64Json } : {}),
      ...(url ? { url } : {}),
      ...(stringValue(item.mime_type)
        ? { mimeType: stringValue(item.mime_type) }
        : {}),
      ...(stringValue(item.revised_prompt)
        ? { revisedPrompt: stringValue(item.revised_prompt) }
        : {}),
    }]
  })
}

export function parseChatGPTImageStream(stream: string): RawGeneratedImage[] {
  const images: RawGeneratedImage[] = []
  const seen = new Set<string>()

  for (const line of stream.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    collectChatGPTImages(event, images, seen)
  }

  return images
}

function collectChatGPTImages(
  value: unknown,
  images: RawGeneratedImage[],
  seen: Set<string>,
): void {
  if (!isRecord(value)) return

  const candidates: unknown[] = []
  if (isRecord(value.item)) candidates.push(value.item)
  if (isRecord(value.output_item)) candidates.push(value.output_item)
  if (isRecord(value.response) && Array.isArray(value.response.output)) {
    candidates.push(...value.response.output)
  }
  if (Array.isArray(value.output)) candidates.push(...value.output)

  for (const candidate of candidates) {
    if (!isRecord(candidate) || candidate.type !== 'image_generation_call') {
      continue
    }
    const result = stringValue(candidate.result)
    if (!result || seen.has(result)) continue
    seen.add(result)
    images.push({
      b64Json: result,
      ...(stringValue(candidate.output_format)
        ? { mimeType: `image/${stringValue(candidate.output_format)}` }
        : {}),
      ...(stringValue(candidate.revised_prompt)
        ? { revisedPrompt: stringValue(candidate.revised_prompt) }
        : {}),
    })
  }
}

async function prepareInputImages(
  input: ImageGenerationInput,
  overrideRootDirs?: string[],
): Promise<PreparedInputImage[]> {
  const requested = input.referenced_image_paths ?? []
  if (requested.length === 0) return []
  if (requested.length > 3) {
    throw new Error('Image editing supports at most 3 input images per call.')
  }

  const rootDirs = overrideRootDirs ?? defaultInputRootDirs()
  const resolvedRoots = await Promise.all(
    rootDirs.map(async (rootDir) => realpath(rootDir).catch(() => resolve(rootDir))),
  )

  return Promise.all(requested.map(async (inputPath) => {
    const resolvedPath = await realpath(inputPath).catch(() => null)
    if (
      !resolvedPath ||
      !resolvedRoots.some((rootDir) => isPathInside(rootDir, resolvedPath))
    ) {
      throw new Error(
        `Image edit input is not a staged upload or a generated image from this session: ${inputPath}`,
      )
    }

    const fileInfo = await stat(resolvedPath)
    if (!fileInfo.isFile()) {
      throw new Error(`Image edit input is not a regular file: ${inputPath}`)
    }
    if (fileInfo.size <= 0 || fileInfo.size > MAX_INPUT_IMAGE_BYTES) {
      throw new Error('Image edit inputs must be non-empty and no larger than 20 MB each.')
    }

    const file = await open(
      resolvedPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
    let bytes: Buffer
    try {
      bytes = await file.readFile()
    } finally {
      await file.close()
    }
    const detected = detectImage(bytes)
    if (!detected) {
      throw new Error('Image edit inputs must be PNG, JPEG, or WebP files.')
    }
    return {
      bytes,
      mimeType: detected.mimeType,
      fileName: basename(resolvedPath),
      dataUrl: `data:${detected.mimeType};base64,${bytes.toString('base64')}`,
    }
  }))
}

function defaultInputRootDirs(): string[] {
  const sessionId = safeSessionId()
  return [
    join(getClaudeConfigHomeDir(), 'uploads', sessionId),
    join(getCcHahaDir(), 'generated-images', sessionId),
  ]
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const pathFromRoot = relative(rootDir, candidate)
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !pathFromRoot.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(pathFromRoot)
  )
}

async function resolveImageBytes(
  image: RawGeneratedImage,
  providerKind: ImageGenerationProviderKind,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<Buffer> {
  if (image.b64Json) {
    const normalized = image.b64Json.replace(/\s+/g, '')
    if (!normalized || normalized.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {
      throw new Error('The generated image exceeded the 30 MB size limit.')
    }
    const bytes = Buffer.from(normalized, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('The generated image was empty or too large.')
    }
    return bytes
  }

  if (!image.url) {
    throw new Error('The image provider returned an empty image item.')
  }
  if (providerKind !== 'grok_oauth') {
    throw new Error(
      'The custom image API returned a URL. Configure it to return b64_json so the desktop can save the image safely.',
    )
  }

  const url = new URL(image.url)
  if (url.protocol !== 'https:' || !isOfficialXaiImageHost(url.hostname)) {
    throw new Error('Grok returned an untrusted image download URL.')
  }
  const response = await performFetch(fetchImpl, url.toString(), {
    method: 'GET',
    redirect: 'error',
    signal,
  })
  await assertUpstreamSuccess(response, 'Grok image download')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error('The generated image exceeded the 30 MB size limit.')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('The generated image was empty or too large.')
  }
  return bytes
}

function isOfficialXaiImageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'x.ai' || normalized.endsWith('.x.ai')
}

async function persistImage(
  outputDir: string,
  bytes: Buffer,
  index: number,
  revisedPrompt?: string,
): Promise<GeneratedImage> {
  const detected = detectImage(bytes)
  if (!detected) {
    throw new Error('The provider response was not a supported PNG, JPEG, or WebP image.')
  }

  const filePath = join(
    outputDir,
    `${Date.now()}-${index + 1}-${randomUUID()}.${detected.extension}`,
  )
  const file = await open(filePath, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
  } finally {
    await file.close()
  }
  return {
    path: filePath,
    mimeType: detected.mimeType,
    ...(revisedPrompt ? { revisedPrompt } : {}),
  }
}

function detectImage(bytes: Buffer): {
  mimeType: GeneratedImage['mimeType']
  extension: 'png' | 'jpg' | 'webp'
} | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { mimeType: 'image/png', extension: 'png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' }
  }
  return null
}

function defaultOutputDir(): string {
  return join(getCcHahaDir(), 'generated-images', safeSessionId())
}

function safeSessionId(): string {
  return getSessionId().replace(/[^A-Za-z0-9._-]/g, '_') || 'session'
}

function sizeForAspectRatio(
  aspectRatio: string | undefined,
): ImageGenerationInput['size'] | undefined {
  if (!aspectRatio || aspectRatio === 'auto') return undefined
  if (aspectRatio === '1:1') return '1024x1024'
  if (['9:16', '3:4', '2:3', '1:2', '9:19.5', '9:20'].includes(aspectRatio)) {
    return '1024x1536'
  }
  return '1536x1024'
}

function aspectRatioForSize(size: ImageGenerationInput['size']): string | undefined {
  if (size === '1024x1024') return '1:1'
  if (size === '1024x1536') return '2:3'
  if (size === '1536x1024') return '3:2'
  return undefined
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
