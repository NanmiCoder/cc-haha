import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import sharp from 'sharp'
import { normalizeImagesForAPI } from './imageValidation.js'
import * as imageResizer from './imageResizer.js'
import * as imageProcessor from '../tools/FileReadTool/imageProcessor.js'

let processor: ReturnType<typeof spyOn>
beforeEach(() => {
  // Coverage loads the resizer's failure mocks into the same Bun process.
  // These tests exercise real pixels, so restore the real dependency locally.
  processor = spyOn(imageProcessor, 'getImageProcessor').mockResolvedValue(sharp)
})
afterEach(() => processor.mockRestore())

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
  const resize = spyOn(imageResizer, 'maybeResizeAndDownsampleImageBuffer').mockImplementation(async buffer => {
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
