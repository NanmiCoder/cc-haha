import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ProcessorMode = 'metadata' | 'throw'

let processorMode: ProcessorMode = 'metadata'
let resizeCalls: Array<{ width: number; height: number }> = []
let jpegCalls: Array<{ quality?: number; resized: boolean }> = []
let pngCalls: Array<{ compressionLevel?: number; palette?: boolean }> = []
let webpCalls: Array<{ quality?: number; lossless?: boolean }> = []

let originalPngDimensions: { width?: number; height?: number; format?: string } =
  { width: 1394, height: 4404, format: 'png' }
let outputForOperations: (operations: Operation[]) => Buffer = () =>
  Buffer.from('resized-image')

// PNG magic header (89 50 4E 47 0D 0A 1A 0A). `readImageWithTokenBudget`
// validates magic bytes before doing anything else, so test fixtures that
// pretend to be `.png` files must start with a real signature even when the
// rest of the bytes are filler. The buffer's total length is preserved
// because the test cases reason about size, not pixel content.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function makeFakePngBufferWithMagic(size: number, fillByte: number): Buffer {
  const buf = Buffer.alloc(size, fillByte)
  PNG_MAGIC.copy(buf, 0)
  return buf
}

type Operation =
  | { type: 'resize'; width: number; height: number }
  | { type: 'jpeg'; quality?: number }
  | { type: 'png'; compressionLevel?: number; palette?: boolean }
  | { type: 'webp'; quality?: number; lossless?: boolean }

mock.module('../../tools/FileReadTool/imageProcessor.js', () => ({
  getImageProcessor: async () => {
    if (processorMode === 'throw') {
      throw new Error('image processor unavailable')
    }

    return (_input: Buffer) => {
      const operations: Operation[] = []
      const instance = {
        metadata: async () => originalPngDimensions,
        resize: (width: number, height: number) => {
          resizeCalls.push({ width, height })
          operations.push({ type: 'resize', width, height })
          return instance
        },
        jpeg: (options?: { quality?: number }) => {
          jpegCalls.push({
            quality: options?.quality,
            resized: operations.some(op => op.type === 'resize'),
          })
          operations.push({ type: 'jpeg', quality: options?.quality })
          return instance
        },
        png: (options?: { compressionLevel?: number; palette?: boolean }) => {
          pngCalls.push(options ?? {})
          operations.push({
            type: 'png',
            compressionLevel: options?.compressionLevel,
            palette: options?.palette,
          })
          return instance
        },
        webp: (options?: { quality?: number; lossless?: boolean }) => {
          webpCalls.push(options ?? {})
          operations.push({
            type: 'webp',
            quality: options?.quality,
            lossless: options?.lossless,
          })
          return instance
        },
        toBuffer: async () => outputForOperations(operations),
      }
      return instance
    }
  },
}))

const {
  ImageResizeError,
  downsampleImageBufferToVisionTokenBudget,
  maybeResizeAndDownsampleImageBuffer,
} = await import('../imageResizer.js')
const { readImageWithTokenBudget } = await import(
  '../../tools/FileReadTool/FileReadTool.js'
)

function makePngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer[0] = 0x89
  buffer[1] = 0x50
  buffer[2] = 0x4e
  buffer[3] = 0x47
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

beforeEach(() => {
  processorMode = 'metadata'
  resizeCalls = []
  jpegCalls = []
  pngCalls = []
  webpCalls = []
  originalPngDimensions = { width: 1394, height: 4404, format: 'png' }
  outputForOperations = () => Buffer.from('resized-image')
})

describe('maybeResizeAndDownsampleImageBuffer', () => {
  test('passes through a tall screenshot when bytes are already within API limits', async () => {
    const imageBuffer = Buffer.alloc(1024, 1)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.buffer).toBe(imageBuffer)
    expect(result.mediaType).toBe('png')
    expect(resizeCalls).toEqual([])
    expect(result.dimensions).toEqual({
      originalWidth: 1394,
      originalHeight: 4404,
      displayWidth: 1394,
      displayHeight: 4404,
    })
  })

  test('falls back to the original tall screenshot if local image processing is unavailable', async () => {
    processorMode = 'throw'
    const imageBuffer = makePngHeader(1394, 4404)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.buffer).toBe(imageBuffer)
    expect(result.mediaType).toBe('png')
  })

  test('tries lossless webp compression before lossy jpeg for oversized screenshots', async () => {
    originalPngDimensions = { width: 4096, height: 2304, format: 'png' }
    outputForOperations = operations => {
      if (operations.some(op => op.type === 'webp')) {
        return Buffer.alloc(1024, 3)
      }
      return Buffer.alloc(4 * 1024 * 1024, 2)
    }
    const imageBuffer = Buffer.alloc(4 * 1024 * 1024, 1)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.mediaType).toBe('webp')
    expect(result.buffer.length).toBe(1024)
    expect(resizeCalls).toEqual([])
    expect(webpCalls).toEqual([{ lossless: true }])
    expect(jpegCalls).toEqual([])
    expect(result.dimensions).toEqual({
      originalWidth: 4096,
      originalHeight: 2304,
      displayWidth: 4096,
      displayHeight: 2304,
    })
  })

  test('downsamples to a codex-sized long edge before lowering jpeg below readable quality', async () => {
    originalPngDimensions = { width: 5000, height: 3000, format: 'png' }
    outputForOperations = operations => {
      const resizeOp = operations.find(
        (op): op is Extract<Operation, { type: 'resize' }> =>
          op.type === 'resize',
      )
      const jpegOp = operations.find(
        (op): op is Extract<Operation, { type: 'jpeg' }> =>
          op.type === 'jpeg',
      )
      if (resizeOp?.width === 2048 && resizeOp.height === 1229) {
        if (jpegOp?.quality === 85) {
          return Buffer.alloc(1024, 4)
        }
      }
      return Buffer.alloc(6 * 1024 * 1024, 5)
    }
    const imageBuffer = Buffer.alloc(6 * 1024 * 1024, 1)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.mediaType).toBe('jpeg')
    expect(result.buffer.length).toBe(1024)
    expect(resizeCalls).toContainEqual({ width: 2048, height: 1229 })
    expect(jpegCalls.some(call => (call.quality ?? 100) < 75)).toBe(false)
    expect(result.dimensions).toEqual({
      originalWidth: 5000,
      originalHeight: 3000,
      displayWidth: 2048,
      displayHeight: 1229,
    })
  })

  test('resizes to the hard dimension cap when only height exceeds the API limit', async () => {
    originalPngDimensions = { width: 1000, height: 9000, format: 'png' }
    outputForOperations = operations => {
      const resizeOp = operations.find(
        (op): op is Extract<Operation, { type: 'resize' }> =>
          op.type === 'resize',
      )
      const jpegOp = operations.find(
        (op): op is Extract<Operation, { type: 'jpeg' }> =>
          op.type === 'jpeg',
      )
      if (
        resizeOp?.width === 889 &&
        resizeOp.height === 8000 &&
        jpegOp?.quality === 85
      ) {
        return Buffer.alloc(1024, 6)
      }
      return Buffer.alloc(6 * 1024 * 1024, 5)
    }
    const imageBuffer = Buffer.alloc(200_000, 1)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.mediaType).toBe('jpeg')
    expect(resizeCalls).toContainEqual({ width: 889, height: 8000 })
    expect(result.dimensions).toEqual({
      originalWidth: 1000,
      originalHeight: 9000,
      displayWidth: 889,
      displayHeight: 8000,
    })
  })

  test('uses readable fallback dimensions before dropping to fallback jpeg quality', async () => {
    originalPngDimensions = { width: 6000, height: 5000, format: 'png' }
    outputForOperations = operations => {
      const resizeOp = operations.find(
        (op): op is Extract<Operation, { type: 'resize' }> =>
          op.type === 'resize',
      )
      const jpegOp = operations.find(
        (op): op is Extract<Operation, { type: 'jpeg' }> =>
          op.type === 'jpeg',
      )
      if (
        resizeOp?.width === 1568 &&
        resizeOp.height === 1307 &&
        jpegOp?.quality === 65
      ) {
        return Buffer.alloc(1024, 6)
      }
      return Buffer.alloc(6 * 1024 * 1024, 5)
    }
    const imageBuffer = Buffer.alloc(6 * 1024 * 1024, 1)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.mediaType).toBe('jpeg')
    expect(resizeCalls).toContainEqual({ width: 2048, height: 1707 })
    expect(resizeCalls).toContainEqual({ width: 1568, height: 1307 })
    expect(jpegCalls.some(call => call.quality === 65)).toBe(true)
    expect(result.dimensions).toEqual({
      originalWidth: 6000,
      originalHeight: 5000,
      displayWidth: 1568,
      displayHeight: 1307,
    })
  })

  test('throws instead of over-compressing when readable fallback cannot fit', async () => {
    originalPngDimensions = { width: 6000, height: 5000, format: 'png' }
    outputForOperations = () => Buffer.alloc(6 * 1024 * 1024, 5)
    const imageBuffer = Buffer.alloc(6 * 1024 * 1024, 1)

    expect(
      maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      ),
    ).rejects.toBeInstanceOf(ImageResizeError)
  })

  test('tries lossless webp for oversized webp screenshots before jpeg conversion', async () => {
    originalPngDimensions = { width: 4096, height: 2304, format: 'webp' }
    outputForOperations = operations => {
      if (operations.some(op => op.type === 'webp')) {
        return Buffer.alloc(1024, 3)
      }
      return Buffer.alloc(4 * 1024 * 1024, 2)
    }
    const imageBuffer = Buffer.alloc(4 * 1024 * 1024, 1)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'webp',
    )

    expect(result.mediaType).toBe('webp')
    expect(webpCalls).toEqual([{ lossless: true }])
    expect(jpegCalls).toEqual([])
  })
})

describe('readImageWithTokenBudget', () => {
  test('does not recompress readable screenshots just because their base64 text would exceed maxTokens', async () => {
    originalPngDimensions = { width: 1920, height: 1080, format: 'png' }
    outputForOperations = () => Buffer.from('compressed-image')
    const imageBuffer = makeFakePngBufferWithMagic(200_000, 1)
    const imagePath = join(tmpdir(), `cc-haha-image-budget-${Date.now()}.png`)
    await writeFile(imagePath, imageBuffer)

    try {
      const result = await readImageWithTokenBudget(imagePath, 25_000)

      expect(result.file.base64).toBe(imageBuffer.toString('base64'))
      expect(result.file.type).toBe('image/png')
      expect(jpegCalls).toEqual([])
      expect(resizeCalls).toEqual([])
    } finally {
      await rm(imagePath, { force: true })
    }
  })

  test('downsamples over-budget vision images by pixel budget instead of base64 text budget', async () => {
    originalPngDimensions = { width: 6000, height: 4000, format: 'png' }
    outputForOperations = operations => {
      const resizeOp = operations.find(
        (op): op is Extract<Operation, { type: 'resize' }> =>
          op.type === 'resize',
      )
      const jpegOp = operations.find(
        (op): op is Extract<Operation, { type: 'jpeg' }> =>
          op.type === 'jpeg',
      )
      if (
        resizeOp?.width === 3674 &&
        resizeOp.height === 2449 &&
        jpegOp?.quality === 85
      ) {
        return Buffer.alloc(1024, 7)
      }
      return Buffer.alloc(6 * 1024 * 1024, 8)
    }
    const imageBuffer = makeFakePngBufferWithMagic(200_000, 1)
    const imagePath = join(
      tmpdir(),
      `cc-haha-image-vision-budget-${Date.now()}.png`,
    )
    await writeFile(imagePath, imageBuffer)

    try {
      const result = await readImageWithTokenBudget(imagePath, 12_000)

      expect(result.file.type).toBe('image/jpeg')
      expect(Buffer.from(result.file.base64, 'base64').length).toBe(1024)
      expect(resizeCalls).toContainEqual({ width: 3674, height: 2449 })
      expect(jpegCalls.some(call => (call.quality ?? 100) < 75)).toBe(false)
      expect(result.file.dimensions).toEqual({
        originalWidth: 6000,
        originalHeight: 4000,
        displayWidth: 3674,
        displayHeight: 2449,
      })
    } finally {
      await rm(imagePath, { force: true })
    }
  })

  test('uses a readable fallback when the vision-budget resize cannot fit the byte cap', async () => {
    originalPngDimensions = { width: 6000, height: 4000, format: 'png' }
    outputForOperations = operations => {
      const resizeOp = operations.find(
        (op): op is Extract<Operation, { type: 'resize' }> =>
          op.type === 'resize',
      )
      const jpegOp = operations.find(
        (op): op is Extract<Operation, { type: 'jpeg' }> =>
          op.type === 'jpeg',
      )
      if (
        resizeOp?.width === 1568 &&
        resizeOp.height === 1045 &&
        jpegOp?.quality === 65
      ) {
        return Buffer.alloc(1024, 7)
      }
      return Buffer.alloc(6 * 1024 * 1024, 8)
    }
    const imageBuffer = Buffer.alloc(200_000, 1)

    const result = await downsampleImageBufferToVisionTokenBudget(
      imageBuffer,
      imageBuffer.length,
      'png',
      12_000,
    )

    expect(result.mediaType).toBe('jpeg')
    expect(resizeCalls).toContainEqual({ width: 3674, height: 2449 })
    expect(resizeCalls).toContainEqual({ width: 1568, height: 1045 })
    expect(result.dimensions).toEqual({
      originalWidth: 6000,
      originalHeight: 4000,
      displayWidth: 1568,
      displayHeight: 1045,
    })
  })

  test('reports an image resize error when token-budget dimensions are unavailable', async () => {
    originalPngDimensions = { format: 'png' }
    const imageBuffer = Buffer.alloc(200_000, 1)

    expect(
      downsampleImageBufferToVisionTokenBudget(
        imageBuffer,
        imageBuffer.length,
        'png',
        12_000,
      ),
    ).rejects.toBeInstanceOf(ImageResizeError)
  })
})
