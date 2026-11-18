import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { IMAGE_REQUEST_BASE64_BUDGET } from '../../constants/apiLimits.js'
import type { ToolUseContext } from '../../Tool.js'
import { createContextImage } from '../../utils/fixtures/contextImages.js'

const previousEnvironment = { ...process.env }
let root: string
let FileReadTool: typeof import('./FileReadTool.js').FileReadTool
let getEmptyToolPermissionContext: typeof import('../../Tool.js').getEmptyToolPermissionContext

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'read-image-context-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(root, {
    CLAUDE_CODE_SIMPLE: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }, previousEnvironment))
  ;({ FileReadTool } = await import('./FileReadTool.js'))
  ;({ getEmptyToolPermissionContext } = await import('../../Tool.js'))
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, previousEnvironment)
  await rm(root, { recursive: true, force: true })
})

function context(): ToolUseContext {
  return {
    readFileState: new Map(), abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as ToolUseContext
}

test('Read compresses an ordinary screenshot before producing its model-facing image without changing the file', async () => {
  const source = await createContextImage()
  expect(source.length).toBeGreaterThan(1024 * 1024)
  expect(source.length).toBeLessThan(3.75 * 1024 * 1024)
  const path = join(root, 'render.png')
  await writeFile(path, source)
  const { data } = await FileReadTool.call({ file_path: path }, context())
  expect(data.type).toBe('image')
  if (data.type !== 'image') throw new Error('Expected an image tool result')
  const result = Buffer.from(data.file.base64, 'base64')
  expect(result.length).toBeLessThan(source.length / 2)
  expect(data.file.originalSize).toBe(source.length)
  const metadata = await sharp(result).metadata()
  expect(data.file.type).toBe(`image/${metadata.format}`)
  expect(metadata.width).toBeLessThanOrEqual(1600)
  expect(metadata.height).toBeLessThanOrEqual(900)
  const block = FileReadTool.mapToolResultToToolResultBlockParam(data, 'read-context-render')
  expect(block.tool_use_id).toBe('read-context-render')
  expect(block.content).toContainEqual({ type: 'image', source: {
    type: 'base64', media_type: data.file.type, data: data.file.base64,
  } })
  expect(await readFile(path)).toEqual(source)
})

test('Read leaves a small thumbnail byte-identical and never enlarges it', async () => {
  const source = await createContextImage({ width: 180, height: 120 })
  const path = join(root, 'thumbnail.png')
  await writeFile(path, source)
  const { data } = await FileReadTool.call({ file_path: path }, context())
  if (data.type !== 'image') throw new Error('Expected an image tool result')
  expect(Buffer.from(data.file.base64, 'base64')).toEqual(source)
  expect(await sharp(Buffer.from(data.file.base64, 'base64')).metadata())
    .toMatchObject({ width: 180, height: 120 })
  expect(await readFile(path)).toEqual(source)
})

test('59 sequential Reads of distinct screenshots retain every image within the request budget and preserve every original', async () => {
  const { normalizeImagesForAPI } = await import('../../utils/imageValidation.js')
  const directory = await mkdtemp(join(root, 'sequential-'))
  const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
  type Content = { type: string; text?: string; tool_use_id?: string; content?: unknown }
  const messages: Array<{ message: { content: Content[] } }> = []
  const originals: Array<{ path: string; hash: string }> = []
  const readImages = new Set<string>()
  const toolContext = context()
  let originalBytes = 0
  let readBytes = 0
  let readEncodedBytes = 0
  const started = performance.now()
  let fixtureMs = 0
  let readMs = 0
  let normalizationMs = 0
  let verificationMs = 0
  const readFormats: Record<string, number> = {}
  try {
    for (let index = 0; index < 59; index++) {
      const fixtureStarted = performance.now()
      // Sparse noise avoids costly WebP searches during Read. Encode the
      // marker once with low PNG compression so inputs still exceed the soft
      // limit and the combined Read results exercise request-budget reduction.
      const source = await createContextImage({
        width: 1024, height: 576, seed: 1888 + index,
        noiseStride: 2, compressionLevel: 1,
        marker: { r: index * 4, g: 200 - index * 2, b: 20 + index * 3 },
      })
      expect(source.length).toBeGreaterThan(512 * 1024)
      expect(source.length).toBeLessThan(3.75 * 1024 * 1024)
      if (index === 0) {
        expect((await sharp(source).jpeg({ quality: 90 }).toBuffer()).length).toBeLessThan(300 * 1024)
      }
      const path = join(directory, `render-${index}.png`)
      await writeFile(path, source)
      originals.push({ path, hash: hash(source) })
      originalBytes += source.length
      fixtureMs += performance.now() - fixtureStarted
      const readStarted = performance.now()
      const { data } = await FileReadTool.call({ file_path: path }, toolContext)
      if (data.type !== 'image') throw new Error(`Read ${index} did not return an image`)
      const encoded = Buffer.from(data.file.base64, 'base64')
      expect(encoded.length).toBeLessThanOrEqual(512 * 1024)
      expect(await sharp(encoded).metadata()).toMatchObject({ width: 1024, height: 576 })
      readMs += performance.now() - readStarted
      readFormats[data.file.type] = (readFormats[data.file.type] ?? 0) + 1
      readBytes += encoded.length
      readEncodedBytes += data.file.base64.length
      readImages.add(hash(encoded))
      const tool = FileReadTool.mapToolResultToToolResultBlockParam(data, `read-sequential-${index}`)
      messages.push({ message: { content: [
        { type: 'text', text: `Caption for screenshot ${index}` }, tool,
      ] } })
    }
    expect(readImages.size).toBe(59)
    expect(readEncodedBytes).toBeGreaterThan(IMAGE_REQUEST_BASE64_BUDGET)
    const before = hash(JSON.stringify(messages))
    console.info(JSON.stringify({ stage: 'before request normalization', fixtureMs, readMs,
      images: originals.length, originalBytes, readBytes, readFormats, elapsedMs: performance.now() - started }))
    const normalizationStarted = performance.now()
    const normalized = await normalizeImagesForAPI(messages)
    normalizationMs = performance.now() - normalizationStarted
    console.info(JSON.stringify({ stage: 'after request normalization', normalizationMs, elapsedMs: performance.now() - started }))
    const verificationStarted = performance.now()
    expect(normalized).toHaveLength(59)
    let requestEncodedBytes = 0
    const sentImages = new Set<string>()
    for (let index = 0; index < normalized.length; index++) {
      const content = normalized[index]!.message.content
      expect(content[0]).toEqual({ type: 'text', text: `Caption for screenshot ${index}` })
      const tool = content.find(block => block.type === 'tool_result')!
      expect(tool.tool_use_id).toBe(`read-sequential-${index}`)
      const blocks = tool.content as Array<{ type: string; source?: { type: string; data: string } }>
      const images = blocks.filter(block => block.type === 'image')
      expect(images).toHaveLength(1)
      const source = images[0]!.source!
      expect(source.type).toBe('base64')
      requestEncodedBytes += source.data.length
      const encoded = Buffer.from(source.data, 'base64')
      sentImages.add(hash(encoded))
      const marker = await sharp(encoded).removeAlpha().extract({ left: 48, top: 48, width: 1, height: 1 }).raw().toBuffer()
      const expectedMarker = [index * 4, 200 - index * 2, 20 + index * 3]
      for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(marker[channel]! - expectedMarker[channel]!)).toBeLessThanOrEqual(8)
      }
      expect(hash(await readFile(originals[index]!.path))).toBe(originals[index]!.hash)
    }
    expect(sentImages.size).toBe(59)
    expect(requestEncodedBytes).toBeLessThanOrEqual(IMAGE_REQUEST_BASE64_BUDGET)
    expect(hash(JSON.stringify(messages))).toBe(before)
    verificationMs = performance.now() - verificationStarted
    console.info(JSON.stringify({ scenario: '59 sequential distinct Read screenshots',
      images: originals.length, originalBytes, readBytes, readEncodedBytes, requestEncodedBytes,
      requestJsonBytes: Buffer.byteLength(JSON.stringify(normalized)),
      originalFilesUnchanged: true, distinctImagesRetained: sentImages.size,
      fixtureMs, readMs, normalizationMs, verificationMs, elapsedMs: performance.now() - started,
    }))
  } finally {
    const cleanupStarted = performance.now()
    await rm(directory, { recursive: true, force: true })
    console.info(JSON.stringify({ stage: 'cleanup', cleanupMs: performance.now() - cleanupStarted,
      elapsedMs: performance.now() - started }))
  }
}, 90_000)
