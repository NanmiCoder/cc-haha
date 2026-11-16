import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import sharp from 'sharp'
import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/apiLimits.js'
import * as imageProcessor from '../tools/FileReadTool/imageProcessor.js'
import type { SharpFunction, SharpInstance } from '../tools/FileReadTool/imageProcessor.js'
import { createContextImage } from './fixtures/contextImages.js'
import { ImageResizeError, optimizeImageForContext } from './imageResizer.js'
import { normalizeImagesForAPI } from './imageValidation.js'

let processor: ReturnType<typeof spyOn>
beforeEach(() => {
  // Other resizer suites install failure mocks in coverage's shared process.
  processor = spyOn(imageProcessor, 'getImageProcessor').mockResolvedValue(sharp)
})
afterEach(() => processor.mockRestore())

async function meanPixelError(input: Buffer, output: Buffer): Promise<number> {
  const pixels = (bytes: Buffer) => sharp(bytes).autoOrient()
    .resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const [before, after] = await Promise.all([pixels(input), pixels(output)])
  expect(after.length).toBe(before.length)
  let difference = 0
  for (let index = 0; index < before.length; index++) difference += Math.abs(before[index]! - after[index]!)
  return difference / before.length
}

test('context encoding reduces ordinary sub-hard-limit screenshots while keeping their original dimensions and pixels', async () => {
  const source = await createContextImage()
  const result = await optimizeImageForContext(source, source.length, 'png')
  expect(result.buffer.length).toBeLessThan(source.length / 2)
  expect(result.buffer.length).toBeLessThanOrEqual(512 * 1024)
  expect(await sharp(result.buffer).metadata()).toMatchObject({ width: 1600, height: 900 })
  expect(result.dimensions).toMatchObject({ originalWidth: 1600, originalHeight: 900,
    displayWidth: 1600, displayHeight: 900 })
  expect(await meanPixelError(source, result.buffer)).toBeLessThan(5)
  const repeat = await optimizeImageForContext(result.buffer, result.buffer.length, result.mediaType)
  expect(repeat.buffer).toEqual(result.buffer)
})

test('low-byte tall images and small thumbnails remain byte-identical without enlargement', async () => {
  for (const source of [
    await createContextImage({ width: 180, height: 120 }),
    await sharp({ create: { width: 900, height: 3200, channels: 3, background: '#f3f1ec' } }).png().toBuffer(),
  ]) {
    const result = await optimizeImageForContext(source, source.length, 'png')
    expect(result.buffer).toEqual(source)
    const before = await sharp(source).metadata()
    expect(await sharp(result.buffer).metadata()).toMatchObject({ width: before.width, height: before.height })
  }
})

test('transparent context images retain transparent and partially transparent pixels', async () => {
  const source = await createContextImage({ alpha: true })
  const result = await optimizeImageForContext(source, source.length, 'png')
  expect(result.buffer.length).toBeLessThan(source.length)
  const metadata = await sharp(result.buffer).metadata()
  expect(metadata.hasAlpha).toBe(true)
  expect(['png', 'webp']).toContain(metadata.format)
  const { data, info } = await sharp(result.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (const [fraction, alpha] of [[0.25, 0], [0.75, 128]] as const) {
    const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width * fraction)) * 4
    expect(Math.abs(data[offset + 3]! - alpha)).toBeLessThanOrEqual(1)
  }
})

test('EXIF rotated context images keep their displayed orientation and correct dimensions after encoding', async () => {
  const source = await sharp(await createContextImage()).jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 }).toBuffer()
  expect(source.length).toBeGreaterThan(512 * 1024)
  const result = await optimizeImageForContext(source, source.length, 'jpeg')
  const metadata = await sharp(result.buffer).metadata()
  expect(metadata.width).toBeLessThan(metadata.height!)
  expect(metadata.width).toBeLessThanOrEqual(900)
  expect(metadata.height).toBeLessThanOrEqual(1600)
  expect(result.dimensions).toMatchObject({ originalWidth: 900, originalHeight: 1600,
    displayWidth: metadata.width, displayHeight: metadata.height })
  expect(await meanPixelError(source, result.buffer)).toBeLessThan(5)
})

for (const format of ['jpeg', 'webp'] as const) {
  test(`context ${format} encoding returns a smaller supported image with matching MIME`, async () => {
    const source = await sharp(await createContextImage()).toFormat(format,
      format === 'jpeg' ? { quality: 100 } : { lossless: true }).toBuffer()
    const result = await optimizeImageForContext(source, source.length, format)
    expect(result.buffer.length).toBeLessThan(source.length)
    expect(result.mediaType).toBe((await sharp(result.buffer).metadata()).format!)
    expect(await meanPixelError(source, result.buffer)).toBeLessThan(5)
  })
}

test('animated GIF and WebP inputs keep their frames when the soft byte target is unattainable', async () => {
  const width = 20, pageHeight = 20
  const pixels = Buffer.alloc(width * pageHeight * 2 * 3)
  pixels.fill(200, width * pageHeight * 3)
  for (const format of ['gif', 'webp'] as const) {
    const source = await sharp(pixels, { raw: { width, height: pageHeight * 2, channels: 3, pageHeight } })
      .toFormat(format, { loop: 0 }).toBuffer()
    expect((await sharp(source, { animated: true }).metadata()).pages).toBe(2)
    const result = await optimizeImageForContext(source, source.length, format, undefined, 1)
    expect(result.buffer).toEqual(source)
    expect((await sharp(result.buffer, { animated: true }).metadata()).pages).toBe(2)
  }
})

test('an unrealistically low soft target preserves a useful image instead of repeatedly shrinking it', async () => {
  const source = await createContextImage()
  const result = await optimizeImageForContext(source, source.length, 'png', undefined, 1)
  expect(result.buffer.length).toBeGreaterThan(1)
  expect(result.buffer.length).toBeLessThan(source.length)
  const metadata = await sharp(result.buffer).metadata()
  expect(metadata.width).toBeGreaterThanOrEqual(1568)
  expect(metadata.height).toBeGreaterThanOrEqual(882)
  expect(await meanPixelError(source, result.buffer)).toBeLessThan(5)
})

test('a codec producing larger candidates cannot inflate an otherwise valid context image', async () => {
  const source = await createContextImage()
  const larger = Buffer.alloc(source.length + 1024)
  const instance: SharpInstance = {
    metadata: async () => ({ width: 1600, height: 900, format: 'png' }),
    resize: () => instance, autoOrient: () => instance,
    jpeg: () => instance, png: () => instance, webp: () => instance,
    toBuffer: async () => larger,
  }
  processor.mockResolvedValue((() => instance) as SharpFunction)
  const result = await optimizeImageForContext(source, source.length, 'png')
  expect(result.buffer).toBe(source)
})

test('processor failure keeps only a header-verifiable image within the hard cap', async () => {
  const source = await createContextImage()
  const overDimension = await sharp({ create: {
    width: 2001, height: 40, channels: 3, background: '#335577',
  } }).png().toBuffer()
  processor.mockRejectedValue(new Error('fixture processor unavailable'))
  const result = await optimizeImageForContext(source, source.length, 'png')
  expect(result.buffer).toBe(source)
  expect(result.mediaType).toBe('png')
  expect(result.buffer.toString('base64').length).toBeLessThan(API_IMAGE_MAX_BASE64_SIZE)
  await expect(optimizeImageForContext(overDimension, overDimension.length, 'png', 2000))
    .rejects.toThrow('2000x2000px')
  await expect(optimizeImageForContext(Buffer.from('undecodable'), 11, 'png'))
    .rejects.toThrow('Unable to verify image dimensions')
  await expect(optimizeImageForContext(Buffer.alloc(0), 0, 'png')).rejects.toBeInstanceOf(ImageResizeError)
})

test('unattainable soft targets do not create successive lossy image generations', async () => {
  const width = 1400, height = 800
  const pixels = Buffer.alloc(width * height * 3)
  let seed = 1888
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    pixels[index] = seed >>> 24
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
  expect(png.length).toBeLessThan(3.75 * 1024 * 1024)
  const first = await optimizeImageForContext(png, png.length, 'png')
  expect(first.mediaType).toBe('jpeg')
  expect(first.buffer.length).toBeGreaterThan(512 * 1024)
  let messages = [{ type: 'user', message: { role: 'user', content: [{ type: 'image', source: {
    type: 'base64', media_type: 'image/jpeg', data: first.buffer.toString('base64'),
  } }] } }]
  const before = JSON.stringify(messages)
  for (let pass = 0; pass < 3; pass++) {
    expect((await optimizeImageForContext(first.buffer, first.buffer.length, first.mediaType)).buffer).toEqual(first.buffer)
    messages = await normalizeImagesForAPI(messages)
    expect(JSON.stringify(messages)).toBe(before)
  }
  const alpha = await createContextImage({ alpha: true })
  const webp = await optimizeImageForContext(alpha, alpha.length, 'png', undefined, 1)
  expect(webp.mediaType).toBe('webp')
  for (let pass = 0; pass < 3; pass++) {
    const repeated = await optimizeImageForContext(webp.buffer, webp.buffer.length, 'webp', undefined, 1)
    expect(repeated.buffer).toEqual(webp.buffer)
  }
})
