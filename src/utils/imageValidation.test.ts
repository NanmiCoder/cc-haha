import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import sharp from 'sharp'
import { normalizeImagesForAPI } from './imageValidation.js'
import * as imageResizer from './imageResizer.js'
import * as imageProcessor from '../tools/FileReadTool/imageProcessor.js'
import { createContextImage } from './fixtures/contextImages.js'
import { IMAGE_REQUEST_BASE64_BUDGET } from '../constants/apiLimits.js'

let processor: ReturnType<typeof spyOn>
beforeEach(() => {
  // Coverage loads the resizer's failure mocks into the same Bun process.
  // These tests exercise real pixels, so restore the real dependency locally.
  processor = spyOn(imageProcessor, 'getImageProcessor').mockResolvedValue(sharp)
})
afterEach(() => processor.mockRestore())

function inlineImages(content: unknown): Array<{ type: string; source: { data: string } }> {
  if (!Array.isArray(content)) return []
  return content.flatMap(block => block.type === 'image' && block.source?.type === 'base64' ? [block]
    : block.type === 'tool_result' || block.type === 'mcp_tool_result' ? inlineImages(block.content)
    : block.type === 'document' && block.source?.type === 'content' ? inlineImages(block.source.content) : [])
}

test('59 repeated screenshots count every occurrence against the encoded request budget', async () => {
  const bytes = await createContextImage()
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } }
  const messages = [{ message: { content: Array.from({ length: 59 }, (_, index) => ({
    type: 'tool_result', tool_use_id: `read-${index}`, content: [{ type: 'text', text: `frame ${index}` }, image],
  })) } }]
  const output = await normalizeImagesForAPI(messages)
  const images = inlineImages(output[0]!.message.content)
  expect(images.length).toBeGreaterThan(0)
  expect(images.reduce((sum, item) => sum + item.source.data.length, 0)).toBeLessThanOrEqual(IMAGE_REQUEST_BASE64_BUDGET)
  expect(JSON.stringify(output).length).toBeLessThan(32 * 1024 * 1024)
  expect(output[0]!.message.content.at(-1)!.tool_use_id).toBe('read-58')
  expect(inlineImages(output[0]!.message.content.at(-1)!.content)).toHaveLength(1)
  for (let index = 0; index < 59; index++) {
    expect(output[0]!.message.content[index]!.content[0]).toEqual({ type: 'text', text: `frame ${index}` })
    expect(messages[0]!.message.content[index]!.content[1]).toBe(image)
  }
})

test('distinct screenshot payloads keep their identities while sharing the cumulative budget', async () => {
  const inputs = await Promise.all([1, 2, 3].map(async seed => ({ type: 'image', source: {
    type: 'base64', media_type: 'image/png', data: (await createContextImage({ seed })).toString('base64'),
  } })))
  const messages = [{ message: { content: Array.from({ length: 60 }, (_, index) => inputs[index % 3]!) } }]
  const output = await normalizeImagesForAPI(messages)
  const images = inlineImages(output[0]!.message.content)
  expect(images.reduce((sum, item) => sum + item.source.data.length, 0)).toBeLessThanOrEqual(IMAGE_REQUEST_BASE64_BUDGET)
  expect(new Set(images.map(image => image.source.data)).size).toBe(3)
  for (const image of images) expect(await sharp(Buffer.from(image.source.data, 'base64')).metadata())
    .toMatchObject({ width: 1568, height: 882 })
})

test('only older nested images become explicit notes after bounded compression cannot reach the soft budget', async () => {
  processor.mockRejectedValue(new Error('fixture processor unavailable'))
  const header = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#336699' } }).png().toBuffer()
  const bytes = Buffer.concat([header, Buffer.alloc(800 * 1024)])
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } }
  const messages = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-read', name: 'Read', input: { file_path: '/fixtures/old.png' } }] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'old-read', content: [
        { type: 'text', text: 'old caption' }, image,
        { type: 'document', source: { type: 'content', content: [image, { type: 'text', text: 'document caption' }] } },
        { type: 'mcp_tool_result', content: Array.from({ length: 27 }, () => image) },
      ] },
    ] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ready for current input' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'current caption' }, image, image] } },
    { type: 'user', message: { role: 'user', content: [image] } },
  ]
  const original = JSON.stringify(messages)
  const optimize = spyOn(imageResizer, 'optimizeImageForContext')
  try {
    const output = await normalizeImagesForAPI(messages)
    expect(optimize).toHaveBeenCalledTimes(1)
    const old = output[1]!.message.content[0] as { tool_use_id: string; content: Array<{ type: string; text?: string }> }
    expect(old.tool_use_id).toBe('old-read')
    expect(old.content[0]).toEqual({ type: 'text', text: 'old caption' })
    expect(old.content[1]!.text).toContain('omitted from this request')
    expect(old.content[1]!.text).toContain('/fixtures/old.png')
    expect(old.content[1]!.text).toContain('Read the original image again')
    expect(inlineImages(old.content).length).toBeGreaterThan(0)
    expect(output[3]).toBe(messages[3])
    expect(output[4]).toBe(messages[4])
    const remaining = output.flatMap(message => inlineImages(message.message.content))
    expect(remaining.reduce((sum, image) => sum + image.source.data.length, 0)).toBeLessThanOrEqual(IMAGE_REQUEST_BASE64_BUDGET)
    expect(JSON.stringify(await normalizeImagesForAPI(output))).toBe(JSON.stringify(output))
    expect(JSON.stringify(messages)).toBe(original)
  } finally { optimize.mockRestore() }
})

test('a current multi-image input over the soft budget retains every hard-limit-valid image', async () => {
  processor.mockRejectedValue(new Error('fixture processor unavailable'))
  const header = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#998855' } }).png().toBuffer()
  const data = Buffer.concat([header, Buffer.alloc(800 * 1024)]).toString('base64')
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }
  const messages = [{ type: 'user', message: { role: 'user', content: Array.from({ length: 30 }, () => image) } }]
  const output = await normalizeImagesForAPI(messages)
  expect(inlineImages(output[0]!.message.content)).toHaveLength(30)
  expect(inlineImages(output[0]!.message.content).reduce((sum, item) => sum + item.source.data.length, 0))
    .toBeGreaterThan(IMAGE_REQUEST_BASE64_BUDGET)
  expect(output[0]).toBe(messages[0])
})

async function largeImage() {
  const buffer = await sharp({ create: { width: 3000, height: 60, channels: 3, background: '#339966' } }).png().toBuffer()
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') },
    cache_control: { type: 'ephemeral' } }
}

async function width(image: Awaited<ReturnType<typeof largeImage>>) {
  return (await sharp(Buffer.from(image.source.data, 'base64')).metadata()).width
}

test('URL and file images count, but image-shaped tool inputs do not', async () => {
  const image = await largeImage()
  const remote: Array<{ type: string; source: { type: string; url?: string; file_id?: string } }> =
    Array.from({ length: 19 }, () => ({ type: 'image', source: { type: 'url', url: 'https://fixture.invalid/image.png' } }))
  const messages = [{ message: { content: [image, ...remote,
    { type: 'tool_use', input: { content: Array.from({ length: 30 }, () => image) } },
  ] } }]
  const twenty = await normalizeImagesForAPI(messages)
  expect(twenty[0]).toBe(messages[0])
  messages[0]!.message.content.push({ type: 'image', source: { type: 'file', file_id: 'fixture_file' } })
  const before = JSON.stringify(messages)
  const twentyOne = await normalizeImagesForAPI(messages)
  const normalized = twentyOne[0]!.message.content.find(block => block.type === 'image') as typeof image
  expect(await width(normalized)).toBe(2000)
  expect(normalized.cache_control).toEqual(image.cache_control)
  expect(twentyOne[0]!.message.content).toContain(remote[0])
  expect(JSON.stringify(messages)).toBe(before)
})

test('images inside document content and MCP tool results count and are resized', async () => {
  const image = await largeImage()
  const messages = [{ message: { content: [
    { type: 'document', source: { type: 'content', content: [image] } },
    { type: 'mcp_tool_result', tool_use_id: 'fixture', content: Array.from({ length: 20 }, () => image) },
  ] } }]
  const before = JSON.stringify(messages)
  const output = await normalizeImagesForAPI(messages)
  expect(await width(output[0]!.message.content[0]!.source!.content.find(block => block.type === 'image')!)).toBe(2000)
  for (const result of output[0]!.message.content[1]!.content!.filter(block => block.type === 'image')) expect(await width(result)).toBe(2000)
  expect(JSON.stringify(messages)).toBe(before)
})

test('document blocks contribute to the cloud-provider threshold only', async () => {
  const image = await largeImage()
  const messages = [{ message: { content: [
    ...Array.from({ length: 20 }, () => image),
    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'fixture' } },
  ] } }]
  const firstParty = await normalizeImagesForAPI(messages)
  expect(firstParty[0]).toBe(messages[0])
  const cloud = await normalizeImagesForAPI(messages, { countDocuments: true })
  expect(await width(cloud[0]!.message.content.find(block => block.type === 'image') as typeof image)).toBe(2000)
  // A later smaller request must use original pixels, not a previous 2000px result.
  const later = await normalizeImagesForAPI([{ message: { content: [image] } }])
  expect(later[0]!.message.content[0]).toBe(image)
})

test('an image no request can verify becomes a note instead of failing every later request', async () => {
  // BMP bytes behind an image extension: tool entry points pass it through,
  // and the request snapshot is rebuilt from that same history every turn.
  const undecodable = { type: 'image', source: { type: 'base64', media_type: 'image/png',
    data: Buffer.concat([Buffer.from('BM'), Buffer.alloc(64)]).toString('base64') } }
  const valid = await largeImage()
  const cached = { ...undecodable, cache_control: { type: 'ephemeral' } }
  const messages = [{ message: { content: [
    { type: 'tool_result', tool_use_id: 'read', content: [{ type: 'text', text: 'caption' }, undecodable, cached] },
    valid,
  ] } }]
  const before = JSON.stringify(messages)
  const output = await normalizeImagesForAPI(messages)
  const tool = output[0]!.message.content[0] as { content: Array<{ type: string; text?: string; cache_control?: unknown }> }
  expect(tool.content[0]).toEqual({ type: 'text', text: 'caption' })
  for (const note of tool.content.slice(1)) {
    expect(note.type).toBe('text')
    expect(note.text).toStartWith('[Image omitted from this request: Unable to verify image dimensions')
  }
  expect(tool.content[1]!.cache_control).toBeUndefined()
  expect(tool.content[2]!.cache_control).toEqual(cached.cache_control)
  expect(output[0]!.message.content[1]).toBe(valid)
  expect(JSON.stringify(messages)).toBe(before)
})

test('tool screenshots retain their action units and get an adjacent current pixel grid', async () => {
  const image = await largeImage()
  const caption = '\nImage 1: 3000×60 pixels. Image pixel bounds: top-left (0,0), bottom-right (2999,59). Zoom image for inspection; action coordinates still refer to the full-screen screenshot in the tool\'s documented units.\n'
  const messages = [{ message: { content: [
    ...Array.from({ length: 20 }, () => image),
    { type: 'tool_result', tool_use_id: 'zoom', content: [{ type: 'text', text: caption }, image] },
  ] } }]
  const output = await normalizeImagesForAPI(messages)
  const tool = output[0]!.message.content.find(block => block.type === 'tool_result')!
  expect(tool.content![0]).toEqual({ type: 'text', text: caption })
  const currentNote = tool.content![1] as { type: string; text: string }
  expect(currentNote.text).toContain('2000x40 pixels')
  expect(currentNote.text).toContain('earlier 3000x60 grid require multiplying x by 1.5000 and y by 1.5000')
  expect(currentNote.text).toContain('Preserve the tool\'s action coordinate units')
  expect(tool.content![2]!.type).toBe('image')
  expect(tool.content![2]).not.toBe(image)
})

test('separate old metadata notes are matched by their pixel grid without swapping images', async () => {
  const first = await largeImage()
  const secondBytes = await sharp(Buffer.from(first.source.data, 'base64')).resize(1500, 3000, { fit: 'fill' }).png().toBuffer()
  const second = { ...first, source: { ...first.source, data: secondBytes.toString('base64') } }
  const messages = [
    { message: { content: [...Array.from({ length: 20 }, () => first), second] } },
    { message: { content: [
      { type: 'text', text: '[Image: source: /wide.png, original 6000x120, displayed at 3000x60. Multiply coordinates by 2.00 to map to original image.]' },
      { type: 'text', text: '[Image: source: /tall.png, original 3000x6000, displayed at 1500x3000. Multiply coordinates by 2.00 to map to original image.]' },
    ] } },
  ]
  const before = JSON.stringify(messages)
  const output = await normalizeImagesForAPI(messages)
  expect((output[1]!.message.content[0] as { text: string }).text).toContain('source: /wide.png, original 6000x120, displayed at 2000x40. Multiply coordinates by 3.00')
  expect((output[1]!.message.content[1] as { text: string }).text).toContain('source: /tall.png, original 3000x6000, displayed at 1000x2000. Multiply coordinates by 3.00')
  expect(JSON.stringify(messages)).toBe(before)
})

test('ambiguous old grids keep their prior mapping instead of guessing an image association', async () => {
  const first = await largeImage()
  const second = { ...first, source: { ...first.source,
    data: (await sharp(Buffer.from(first.source.data, 'base64')).negate().png().toBuffer()).toString('base64'),
  } }
  // Model the encoder's smaller byte-budget fallback on only one image.
  const resize = spyOn(imageResizer, 'optimizeImageForContext').mockImplementation(async buffer => {
    const width = buffer.toString('base64') === first.source.data ? 2000 : 1568
    const height = Math.round(width / 50)
    return { buffer: await sharp(buffer).resize(width, height).png().toBuffer(), mediaType: 'png',
      dimensions: { originalWidth: 3000, originalHeight: 60, displayWidth: width, displayHeight: height } }
  })
  try {
    const note = '[Image: original 6000x120, displayed at 3000x60. Multiply coordinates by 2.00 to map to original image.]'
    const output = await normalizeImagesForAPI([{ message: { content: [first, second, { type: 'text', text: note }] } }])
    const content = output[0]!.message.content as Array<{ type: string; text?: string }>
    expect(content[0]!.text).toContain('2000x40 pixels')
    expect(content[2]!.text).toContain('1568x31 pixels')
    expect(content.at(-1)!.text).toBe(note.replace('[Image:', '[Image before request resizing:'))
  } finally {
    resize.mockRestore()
  }
})
