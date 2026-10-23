import { beforeEach, describe, expect, test } from 'bun:test'
import {
  API_MANY_IMAGE_MAX_DIMENSION,
  API_MANY_IMAGE_THRESHOLD,
} from '../../constants/apiLimits.js'
import {
  getImageCreator,
  getImageProcessor,
} from '../../tools/FileReadTool/imageProcessor.js'
import {
  __resetPreparedImageCacheForTests,
  INVALID_IMAGE_PLACEHOLDER,
  prepareRequestImages,
} from './requestImages.js'

type ImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

async function png(width: number, height: number): Promise<ImageBlock> {
  const creator = await getImageCreator()
  const buffer = await creator({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer()
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') },
  }
}

async function jpeg(width: number, height: number): Promise<ImageBlock> {
  const creator = await getImageCreator()
  const buffer = await creator({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg()
    .toBuffer()
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') },
  }
}

function userMessage(content: unknown[]) {
  return { type: 'user' as const, message: { role: 'user' as const, content } }
}

async function dimensions(block: ImageBlock): Promise<{ width?: number; height?: number; format?: string }> {
  const sharp = await getImageProcessor()
  const { width, height, format } = await sharp(Buffer.from(block.source.data, 'base64')).metadata()
  return { width, height, format }
}

const notAnImage: ImageBlock = {
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: Buffer.from('<html><body>302 Found: redirecting to /login</body></html>').toString('base64'),
  },
}

beforeEach(() => {
  __resetPreparedImageCacheForTests()
})

describe('prepareRequestImages', () => {
  test('returns the same array when the request carries no images', async () => {
    const messages = [userMessage([{ type: 'text', text: 'hello' }])]
    expect(await prepareRequestImages(messages)).toBe(messages)
  })

  test('replaces bytes that are not an image with a text note, including inside tool results', async () => {
    const valid = await png(4, 4)
    const messages = [
      userMessage([{ type: 'text', text: 'first' }, notAnImage, valid]),
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: [{ type: 'text', text: 'Read diagram.png' }, notAnImage],
        },
      ]),
    ]

    const prepared = await prepareRequestImages(messages)

    expect(prepared).not.toBe(messages)
    expect(prepared[0]!.message.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: INVALID_IMAGE_PLACEHOLDER },
      valid,
    ])
    expect(prepared[1]!.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'read-1',
        content: [
          { type: 'text', text: 'Read diagram.png' },
          { type: 'text', text: INVALID_IMAGE_PLACEHOLDER },
        ],
      },
    ])
    // Persisted messages are untouched: only the request copy changed.
    expect(messages[0]!.message.content[1]).toBe(notAnImage)
  })

  test('leaves oversized images alone while the request stays at or below the many-image threshold', async () => {
    const wide = await png(API_MANY_IMAGE_MAX_DIMENSION + 500, 40)
    const small = await Promise.all(
      Array.from({ length: API_MANY_IMAGE_THRESHOLD - 1 }, () => png(2, 2)),
    )
    const messages = [userMessage([wide, ...small])]

    expect(await prepareRequestImages(messages)).toBe(messages)
  })

  test('downscales every image above the per-image limit once the request carries more than the threshold', async () => {
    const wide = await png(API_MANY_IMAGE_MAX_DIMENSION + 500, 40)
    const tall = await jpeg(30, API_MANY_IMAGE_MAX_DIMENSION + 200)
    const small = await Promise.all(
      Array.from({ length: API_MANY_IMAGE_THRESHOLD - 1 }, () => png(2, 2)),
    )
    const messages = [
      userMessage([wide, ...small]),
      userMessage([
        { type: 'tool_result', tool_use_id: 'shot-1', content: [tall] },
      ]),
    ]

    const prepared = await prepareRequestImages(messages)

    const firstContent = prepared[0]!.message.content as ImageBlock[]
    const resizedWide = firstContent[0]!
    expect(resizedWide).not.toBe(wide)
    expect(resizedWide.source.media_type).toBe('image/png')
    const wideDims = await dimensions(resizedWide)
    expect(wideDims.width).toBe(API_MANY_IMAGE_MAX_DIMENSION)
    expect(wideDims.height).toBeLessThanOrEqual(API_MANY_IMAGE_MAX_DIMENSION)
    expect(wideDims.format).toBe('png')
    // Small images pass through by identity.
    for (const [index, block] of small.entries()) {
      expect(firstContent[index + 1]).toBe(block)
    }

    const toolResult = (prepared[1]!.message.content as Array<{ content: ImageBlock[] }>)[0]!
    const resizedTall = toolResult.content[0]!
    expect(resizedTall.source.media_type).toBe('image/jpeg')
    const tallDims = await dimensions(resizedTall)
    expect(tallDims.height).toBe(API_MANY_IMAGE_MAX_DIMENSION)
    expect(tallDims.width).toBeLessThanOrEqual(API_MANY_IMAGE_MAX_DIMENSION)
    expect(tallDims.format).toBe('jpeg')
  })

  test('reuses the prepared result for the same image on the next turn', async () => {
    const wide = await png(API_MANY_IMAGE_MAX_DIMENSION + 100, 20)
    const small = await Promise.all(
      Array.from({ length: API_MANY_IMAGE_THRESHOLD }, () => png(2, 2)),
    )
    const firstTurn = [userMessage([wide, ...small])]
    const secondTurn = [
      userMessage([wide, ...small]),
      userMessage([{ type: 'text', text: 'and now?' }]),
    ]

    const first = await prepareRequestImages(firstTurn)
    const second = await prepareRequestImages(secondTurn)

    const firstResized = (first[0]!.message.content as ImageBlock[])[0]!
    const secondResized = (second[0]!.message.content as ImageBlock[])[0]!
    expect(secondResized.source.data).toBe(firstResized.source.data)
  })
})
