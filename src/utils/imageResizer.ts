import type {
  Base64ImageSource,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { logEvent } from '../services/analytics/index.js'
import {
  getImageProcessor,
  type SharpFunction,
  type SharpInstance,
} from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// Error type constants for analytics (numeric to comply with logEvent restrictions)
const ERROR_TYPE_MODULE_LOAD = 1
const ERROR_TYPE_PROCESSING = 2
const ERROR_TYPE_UNKNOWN = 3
const ERROR_TYPE_PIXEL_LIMIT = 4
const ERROR_TYPE_MEMORY = 5
const ERROR_TYPE_TIMEOUT = 6
const ERROR_TYPE_VIPS = 7
const ERROR_TYPE_PERMISSION = 8

/**
 * Error thrown when image resizing fails and the image exceeds the API limit.
 */
export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

/**
 * Classifies image processing errors for analytics.
 *
 * Uses error codes when available (Node.js module errors), falls back to
 * message matching for libraries like sharp that don't expose error codes.
 */
function classifyImageError(error: unknown): number {
  // Check for Node.js error codes first (more reliable than string matching)
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: string }
    if (
      errorWithCode.code === 'MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_DLOPEN_FAILED'
    ) {
      return ERROR_TYPE_MODULE_LOAD
    }
    if (errorWithCode.code === 'EACCES' || errorWithCode.code === 'EPERM') {
      return ERROR_TYPE_PERMISSION
    }
    if (errorWithCode.code === 'ENOMEM') {
      return ERROR_TYPE_MEMORY
    }
  }

  // Fall back to message matching for errors without codes
  // Note: sharp doesn't expose error codes, so we must match on messages
  const message = errorMessage(error)

  // Module loading errors from our native wrapper
  if (message.includes('Native image processor module not available')) {
    return ERROR_TYPE_MODULE_LOAD
  }

  // Sharp/vips processing errors (format detection, corrupt data, etc.)
  if (
    message.includes('unsupported image format') ||
    message.includes('Input buffer') ||
    message.includes('Input file is missing') ||
    message.includes('Input file has corrupt header') ||
    message.includes('corrupt header') ||
    message.includes('corrupt image') ||
    message.includes('premature end') ||
    message.includes('zlib: data error') ||
    message.includes('zero width') ||
    message.includes('zero height')
  ) {
    return ERROR_TYPE_PROCESSING
  }

  // Pixel/dimension limit errors from sharp/vips
  if (
    message.includes('pixel limit') ||
    message.includes('too many pixels') ||
    message.includes('exceeds pixel') ||
    message.includes('image dimensions')
  ) {
    return ERROR_TYPE_PIXEL_LIMIT
  }

  // Memory allocation failures
  if (
    message.includes('out of memory') ||
    message.includes('Cannot allocate') ||
    message.includes('memory allocation')
  ) {
    return ERROR_TYPE_MEMORY
  }

  // Timeout errors
  if (message.includes('timeout') || message.includes('timed out')) {
    return ERROR_TYPE_TIMEOUT
  }

  // Vips-specific errors (VipsJpeg, VipsPng, VipsWebp, etc.)
  if (message.includes('Vips')) {
    return ERROR_TYPE_VIPS
  }

  return ERROR_TYPE_UNKNOWN
}

/**
 * Computes a simple numeric hash of a string for analytics grouping.
 * Uses djb2 algorithm, returning a 32-bit unsigned integer.
 */
function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

export interface ResizeResult {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}

interface ImageCompressionContext {
  imageBuffer: Buffer
  metadata: { width?: number; height?: number; format?: string }
  format: string
  maxBytes: number
  originalSize: number
}

interface CompressedImageResult {
  base64: string
  mediaType: Base64ImageSource['media_type']
  originalSize: number
}

type ResizeDimensions = {
  width: number
  height: number
}

const IMAGE_PROMPT_SOFT_LONG_EDGE = 2048
const IMAGE_PROMPT_READABLE_LONG_EDGE = 1568
const READABLE_JPEG_QUALITIES = [85, 75] as const
const FALLBACK_JPEG_QUALITIES = [65] as const

/**
 * Extracted from FileReadTool's readImage function
 * Resizes image buffer to meet size and dimension constraints
 * An explicit request limit also requires verifiable dimensions on fallback.
 */
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
  dimensionLimit?: number,
): Promise<ResizeResult> {
  const maxWidth = dimensionLimit ?? IMAGE_MAX_WIDTH
  const maxHeight = dimensionLimit ?? IMAGE_MAX_HEIGHT
  let knownDimensions: { width: number; height: number } | undefined
  if (imageBuffer.length === 0) {
    // Empty buffer would fall through the catch block below (sharp throws
    // "Unable to determine image format"), and the fallback's size check
    // `0 ≤ 5MB` would pass it through, yielding an empty base64 string
    // that the API rejects with `image cannot be empty`.
    throw new ImageResizeError('Image file is empty (0 bytes)')
  }
  try {
    const sharp = await getImageProcessor({ requireAutoOrient: dimensionLimit !== undefined })
    const image = sharp(imageBuffer)
    const metadata = await image.metadata()

    const mediaType = metadata.format ?? ext
    // Normalize "jpg" to "jpeg" for media type compatibility
    const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType

    // If dimensions aren't available from metadata
    if (!metadata.width || !metadata.height) {
      if (dimensionLimit !== undefined) {
        throw new ImageResizeError('Unable to determine image dimensions for this request')
      }
      if (originalSize > IMAGE_TARGET_RAW_SIZE) {
        // Create fresh sharp instance for compression
        const compressedBuffer = await sharp(imageBuffer)
          .jpeg({ quality: 80 })
          .toBuffer()
        return { buffer: compressedBuffer, mediaType: 'jpeg' }
      }
      // Return without dimensions if we can't determine them
      return { buffer: imageBuffer, mediaType: normalizedMediaType }
    }

    // Store original dimensions (guaranteed to be defined here)
    const autoOrient = dimensionLimit !== undefined && !!metadata.orientation && metadata.orientation !== 1
    const swapAxes = autoOrient && metadata.orientation! >= 5
    const originalWidth = swapAxes ? metadata.height : metadata.width
    const originalHeight = swapAxes ? metadata.width : metadata.height
    knownDimensions = { width: originalWidth, height: originalHeight }

    // Calculate dimensions while maintaining aspect ratio
    let width = originalWidth
    let height = originalHeight

    // Check if the original file just works
    if (
      originalSize <= IMAGE_TARGET_RAW_SIZE &&
      width <= maxWidth &&
      height <= maxHeight
    ) {
      return {
        buffer: imageBuffer,
        mediaType: normalizedMediaType,
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: width,
          displayHeight: height,
        },
      }
    }

    const hardDims = constrainDimensions(
      width,
      height,
      maxWidth,
      maxHeight,
    )
    const needsDimensionResize =
      hardDims.width !== width || hardDims.height !== height

    // Try lossless or high-quality compression at original dimensions first.
    // This keeps screenshot text sharp when the only problem is payload size.
    if (!needsDimensionResize && originalSize > IMAGE_TARGET_RAW_SIZE) {
      const compressed = await tryEncodeImageCandidate({
        sharp,
        autoOrient,
        imageBuffer,
        originalWidth,
        originalHeight,
        dimensions: { width, height },
        format: normalizedMediaType,
        maxBytes: IMAGE_TARGET_RAW_SIZE,
      })
      if (compressed) return compressed
    }

    if (needsDimensionResize) {
      logForDebugging(`Resizing to ${hardDims.width}x${hardDims.height}`)
      const hardResize = await tryEncodeImageCandidate({
        sharp,
        autoOrient,
        imageBuffer,
        originalWidth,
        originalHeight,
        dimensions: hardDims,
        format: normalizedMediaType,
        maxBytes: IMAGE_TARGET_RAW_SIZE,
      })
      if (hardResize) return hardResize
    }

    const softDims = constrainDimensions(
      hardDims.width,
      hardDims.height,
      IMAGE_PROMPT_SOFT_LONG_EDGE,
      IMAGE_PROMPT_SOFT_LONG_EDGE,
    )
    if (
      softDims.width !== hardDims.width ||
      softDims.height !== hardDims.height
    ) {
      logForDebugging(
        `Downsampling image to ${softDims.width}x${softDims.height}`,
      )
      const softResize = await tryEncodeImageCandidate({
        sharp,
        autoOrient,
        imageBuffer,
        originalWidth,
        originalHeight,
        dimensions: softDims,
        format: normalizedMediaType,
        maxBytes: IMAGE_TARGET_RAW_SIZE,
      })
      if (softResize) return softResize
    }

    const readableDims = constrainDimensions(
      hardDims.width,
      hardDims.height,
      IMAGE_PROMPT_READABLE_LONG_EDGE,
      IMAGE_PROMPT_READABLE_LONG_EDGE,
    )
    if (
      readableDims.width !== softDims.width ||
      readableDims.height !== softDims.height
    ) {
      logForDebugging(
        `Downsampling image to readable fallback ${readableDims.width}x${readableDims.height}`,
      )
      const readableResize = await tryEncodeImageCandidate({
        sharp,
        autoOrient,
        imageBuffer,
        originalWidth,
        originalHeight,
        dimensions: readableDims,
        format: normalizedMediaType,
        maxBytes: IMAGE_TARGET_RAW_SIZE,
        allowFallbackQuality: true,
      })
      if (readableResize) return readableResize
    }

    throw new ImageResizeError(
      `Unable to compress image (${formatFileSize(originalSize)}) below the 5MB API base64 limit without over-compressing it. ` +
        `Please resize the image manually or use a smaller image.`,
    )
  } catch (error) {
    // Log the error and emit analytics event
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('tengu_image_resize_failed', {
      original_size_bytes: originalSize,
      error_type: errorType,
      error_message_hash: hashString(errorMsg),
    })

    // Detect actual format from magic bytes instead of trusting extension
    const detected = detectImageFormatFromBuffer(imageBuffer)
    const normalizedExt = detected.slice(6) // Remove 'image/' prefix

    // Calculate the base64 size (API limit is on base64-encoded length)
    const base64Size = Math.ceil((originalSize * 4) / 3)

    // If encoding failed, metadata still describes the original image (all
    // formats). If the processor could not load, PNG has a fixed-size header.
    if (!knownDimensions &&
      imageBuffer.length >= 24 &&
      imageBuffer[0] === 0x89 &&
      imageBuffer[1] === 0x50 &&
      imageBuffer[2] === 0x4e &&
      imageBuffer[3] === 0x47
    ) {
      const width = imageBuffer.readUInt32BE(16)
      const height = imageBuffer.readUInt32BE(20)
      if (width > 0 && height > 0) knownDimensions = { width, height }
    }
    const overDim = knownDimensions &&
      (knownDimensions.width > maxWidth || knownDimensions.height > maxHeight)
    // At the request boundary, an unknown size must not silently bypass the
    // per-request cap when a native processor is unavailable.
    const unknownDim = dimensionLimit !== undefined && !knownDimensions

    // If original image's base64 encoding is within API limit, allow it through uncompressed
    if (base64Size <= API_IMAGE_MAX_BASE64_SIZE && !overDim && !unknownDim) {
      logEvent('tengu_image_resize_fallback', {
        original_size_bytes: originalSize,
        base64_size_bytes: base64Size,
        error_type: errorType,
      })
      return { buffer: imageBuffer, mediaType: normalizedExt }
    }

    // Image is too large and we failed to compress it - fail with user-friendly error
    throw new ImageResizeError(
      unknownDim
        ? `Unable to verify image dimensions against the ${maxWidth}x${maxHeight}px request limit because image processing failed. Please use a smaller image or restore image processing support.`
        : overDim
        ? `Unable to resize image — dimensions exceed the ${maxWidth}x${maxHeight}px limit and image processing failed. ` +
            `Please resize the image to reduce its pixel dimensions.`
        : `Unable to resize image (${formatFileSize(originalSize)} raw, ${formatFileSize(base64Size)} base64). ` +
            `The image exceeds the 5MB API limit and compression failed. ` +
            `Please resize the image manually or use a smaller image.`,
    )
  }
}

function constrainDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): ResizeDimensions {
  let nextWidth = width
  let nextHeight = height

  if (nextWidth > maxWidth) {
    nextHeight = Math.round((nextHeight * maxWidth) / nextWidth)
    nextWidth = maxWidth
  }

  if (nextHeight > maxHeight) {
    nextWidth = Math.round((nextWidth * maxHeight) / nextHeight)
    nextHeight = maxHeight
  }

  return {
    width: Math.max(1, nextWidth),
    height: Math.max(1, nextHeight),
  }
}

function constrainDimensionsToPixelBudget(
  width: number,
  height: number,
  maxPixels: number,
): ResizeDimensions {
  if (width * height <= maxPixels) {
    return { width, height }
  }

  const scale = Math.sqrt(maxPixels / (width * height))
  let nextWidth = Math.max(1, Math.round(width * scale))
  let nextHeight = Math.max(1, Math.round(height * scale))

  while (nextWidth * nextHeight > maxPixels) {
    if (nextWidth >= nextHeight) {
      nextWidth -= 1
    } else {
      nextHeight -= 1
    }
  }

  return {
    width: nextWidth,
    height: nextHeight,
  }
}

function createResizeResult(
  buffer: Buffer,
  mediaType: string,
  originalWidth: number,
  originalHeight: number,
  dimensions: ResizeDimensions,
): ResizeResult {
  return {
    buffer,
    mediaType,
    dimensions: {
      originalWidth,
      originalHeight,
      displayWidth: dimensions.width,
      displayHeight: dimensions.height,
    },
  }
}

function createImagePipeline(
  sharp: SharpFunction,
  imageBuffer: Buffer,
  originalWidth: number,
  originalHeight: number,
  dimensions: ResizeDimensions,
  autoOrient = false,
): SharpInstance {
  let pipeline = sharp(imageBuffer)
  if (autoOrient) {
    if (!pipeline.autoOrient) throw new ImageResizeError('Image processor cannot preserve image orientation')
    pipeline = pipeline.autoOrient()
  }
  if (
    dimensions.width === originalWidth &&
    dimensions.height === originalHeight
  ) {
    return pipeline
  }

  return pipeline.resize(dimensions.width, dimensions.height, {
    fit: 'inside',
    withoutEnlargement: true,
  })
}

async function tryEncodeImageCandidate({
  sharp,
  autoOrient = false,
  imageBuffer,
  originalWidth,
  originalHeight,
  dimensions,
  format,
  maxBytes,
  allowFallbackQuality = false,
}: {
  sharp: SharpFunction
  autoOrient?: boolean
  imageBuffer: Buffer
  originalWidth: number
  originalHeight: number
  dimensions: ResizeDimensions
  format: string
  maxBytes: number
  allowFallbackQuality?: boolean
}): Promise<ResizeResult | null> {
  const normalizedFormat = format === 'jpg' ? 'jpeg' : format

  if (normalizedFormat === 'png') {
    const pngCompressed = await createImagePipeline(
      sharp,
      imageBuffer,
      originalWidth,
      originalHeight,
      dimensions,
      autoOrient,
    )
      .png({ compressionLevel: 9 })
      .toBuffer()
    if (pngCompressed.length <= maxBytes) {
      return createResizeResult(
        pngCompressed,
        'png',
        originalWidth,
        originalHeight,
        dimensions,
      )
    }

    const webpLossless = await createImagePipeline(
      sharp,
      imageBuffer,
      originalWidth,
      originalHeight,
      dimensions,
      autoOrient,
    )
      .webp({ lossless: true })
      .toBuffer()
    if (webpLossless.length <= maxBytes) {
      return createResizeResult(
        webpLossless,
        'webp',
        originalWidth,
        originalHeight,
        dimensions,
      )
    }
  } else if (normalizedFormat === 'webp') {
    const webpLossless = await createImagePipeline(
      sharp,
      imageBuffer,
      originalWidth,
      originalHeight,
      dimensions,
      autoOrient,
    )
      .webp({ lossless: true })
      .toBuffer()
    if (webpLossless.length <= maxBytes) {
      return createResizeResult(
        webpLossless,
        'webp',
        originalWidth,
        originalHeight,
        dimensions,
      )
    }
  }

  const jpegQualities = allowFallbackQuality
    ? [...READABLE_JPEG_QUALITIES, ...FALLBACK_JPEG_QUALITIES]
    : READABLE_JPEG_QUALITIES
  for (const quality of jpegQualities) {
    const jpegBuffer = await createImagePipeline(
      sharp,
      imageBuffer,
      originalWidth,
      originalHeight,
      dimensions,
      autoOrient,
    )
      .jpeg({ quality })
      .toBuffer()
    if (jpegBuffer.length <= maxBytes) {
      return createResizeResult(
        jpegBuffer,
        'jpeg',
        originalWidth,
        originalHeight,
        dimensions,
      )
    }
  }

  return null
}

export async function downsampleImageBufferToVisionTokenBudget(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
  maxTokens: number,
): Promise<ResizeResult> {
  const sharp = await getImageProcessor()
  const metadata = await sharp(imageBuffer).metadata()
  const format = metadata.format ?? ext
  const normalizedMediaType = format === 'jpg' ? 'jpeg' : format

  if (!metadata.width || !metadata.height) {
    throw new ImageResizeError(
      'Unable to downsample image for token budget because dimensions are unavailable.',
    )
  }

  const originalWidth = metadata.width
  const originalHeight = metadata.height
  const hardDims = constrainDimensions(
    originalWidth,
    originalHeight,
    IMAGE_MAX_WIDTH,
    IMAGE_MAX_HEIGHT,
  )
  const maxPixels = Math.max(1, maxTokens * 750)
  const tokenDims = constrainDimensionsToPixelBudget(
    hardDims.width,
    hardDims.height,
    maxPixels,
  )

  const tokenResize = await tryEncodeImageCandidate({
    sharp,
    imageBuffer,
    originalWidth,
    originalHeight,
    dimensions: tokenDims,
    format: normalizedMediaType,
    maxBytes: IMAGE_TARGET_RAW_SIZE,
    allowFallbackQuality: true,
  })
  if (tokenResize) return tokenResize

  const readableDims = constrainDimensions(
    tokenDims.width,
    tokenDims.height,
    IMAGE_PROMPT_READABLE_LONG_EDGE,
    IMAGE_PROMPT_READABLE_LONG_EDGE,
  )
  if (
    readableDims.width !== tokenDims.width ||
    readableDims.height !== tokenDims.height
  ) {
    const readableResize = await tryEncodeImageCandidate({
      sharp,
      imageBuffer,
      originalWidth,
      originalHeight,
      dimensions: readableDims,
      format: normalizedMediaType,
      maxBytes: IMAGE_TARGET_RAW_SIZE,
      allowFallbackQuality: true,
    })
    if (readableResize) return readableResize
  }

  throw new ImageResizeError(
    `Unable to downsample image (${formatFileSize(originalSize)}) below the ${maxTokens} token budget without over-compressing it.`,
  )
}

export interface ImageBlockWithDimensions {
  block: ImageBlockParam
  dimensions?: ImageDimensions
}

/**
 * Resizes an image content block if needed
 * Takes an image ImageBlockParam and returns a resized version if necessary
 * Also returns dimension information for coordinate mapping
 */
export async function maybeResizeAndDownsampleImageBlock(
  imageBlock: ImageBlockParam,
): Promise<ImageBlockWithDimensions> {
  // Only process base64 images
  if (imageBlock.source.type !== 'base64') {
    return { block: imageBlock }
  }

  // Decode base64 to buffer
  const imageBuffer = Buffer.from(imageBlock.source.data, 'base64')
  const originalSize = imageBuffer.length

  // Extract extension from media type
  const mediaType = imageBlock.source.media_type
  const ext = mediaType?.split('/')[1] || 'png'

  // Resize if needed
  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    originalSize,
    ext,
  )

  // Return resized image block with dimension info
  return {
    block: {
      type: 'image',
      source: {
        type: 'base64',
        media_type:
          `image/${resized.mediaType}` as Base64ImageSource['media_type'],
        data: resized.buffer.toString('base64'),
      },
    },
    dimensions: resized.dimensions,
  }
}

/**
 * Compresses an image buffer to fit within a maximum byte size.
 *
 * Uses a multi-strategy fallback approach because simple compression often fails for
 * large screenshots, high-resolution photos, or images with complex gradients. Each
 * strategy is progressively more aggressive to handle edge cases where earlier
 * strategies produce files still exceeding the size limit.
 *
 * Strategy (from FileReadTool):
 * 1. Try to preserve original format (PNG, JPEG, WebP) with progressive resizing
 * 2. For PNG: Use palette optimization and color reduction if needed
 * 3. Last resort: Convert to JPEG with aggressive compression
 *
 * This ensures images fit within context windows while maintaining format when possible.
 */
export async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Extract format from originalMediaType if provided (e.g., "image/png" -> "png")
  const fallbackFormat = originalMediaType?.split('/')[1] || 'jpeg'
  const normalizedFallback = fallbackFormat === 'jpg' ? 'jpeg' : fallbackFormat

  try {
    const sharp = await getImageProcessor()
    const metadata = await sharp(imageBuffer).metadata()
    const format = metadata.format || normalizedFallback
    const originalSize = imageBuffer.length

    const context: ImageCompressionContext = {
      imageBuffer,
      metadata,
      format,
      maxBytes,
      originalSize,
    }

    // If image is already within size limit, return as-is without processing
    if (originalSize <= maxBytes) {
      return createCompressedImageResult(imageBuffer, format, originalSize)
    }

    // Try progressive resizing with format preservation
    const resizedResult = await tryProgressiveResizing(context, sharp)
    if (resizedResult) {
      return resizedResult
    }

    // For PNG, try palette optimization
    if (format === 'png') {
      const palettizedResult = await tryPalettePNG(context, sharp)
      if (palettizedResult) {
        return palettizedResult
      }
    }

    // Try JPEG conversion with moderate compression
    const jpegResult = await tryJPEGConversion(context, 50, sharp)
    if (jpegResult) {
      return jpegResult
    }

    // Last resort: ultra-compressed JPEG
    return await createUltraCompressedJPEG(context, sharp)
  } catch (error) {
    // Log the error and emit analytics event
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('tengu_image_compress_failed', {
      original_size_bytes: imageBuffer.length,
      max_bytes: maxBytes,
      error_type: errorType,
      error_message_hash: hashString(errorMsg),
    })

    // If original image is within the requested limit, allow it through
    if (imageBuffer.length <= maxBytes) {
      // Detect actual format from magic bytes instead of trusting the provided media type
      const detected = detectImageFormatFromBuffer(imageBuffer)
      return {
        base64: imageBuffer.toString('base64'),
        mediaType: detected,
        originalSize: imageBuffer.length,
      }
    }

    // Image is too large and compression failed - throw error
    throw new ImageResizeError(
      `Unable to compress image (${formatFileSize(imageBuffer.length)}) to fit within ${formatFileSize(maxBytes)}. ` +
        `Please use a smaller image.`,
    )
  }
}

/**
 * Compresses an image buffer to fit within a token limit.
 * Converts tokens to bytes using the formula: maxBytes = (maxTokens / 0.125) * 0.75
 */
export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Convert token limit to byte limit
  // base64 uses about 4/3 the original size, so we reverse this
  const maxBase64Chars = Math.floor(maxTokens / 0.125)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)

  return compressImageBuffer(imageBuffer, maxBytes, originalMediaType)
}

/**
 * Compresses an image block to fit within a maximum byte size.
 * Wrapper around compressImageBuffer for ImageBlockParam.
 */
export async function compressImageBlock(
  imageBlock: ImageBlockParam,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
): Promise<ImageBlockParam> {
  // Only process base64 images
  if (imageBlock.source.type !== 'base64') {
    return imageBlock
  }

  // Decode base64 to buffer
  const imageBuffer = Buffer.from(imageBlock.source.data, 'base64')

  // Check if already within size limit
  if (imageBuffer.length <= maxBytes) {
    return imageBlock
  }

  // Compress the image
  const compressed = await compressImageBuffer(imageBuffer, maxBytes)

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: compressed.mediaType,
      data: compressed.base64,
    },
  }
}

// Helper functions for compression pipeline

function createCompressedImageResult(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
): CompressedImageResult {
  const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType
  return {
    base64: buffer.toString('base64'),
    mediaType:
      `image/${normalizedMediaType}` as Base64ImageSource['media_type'],
    originalSize,
  }
}

async function tryProgressiveResizing(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const scalingFactors = [1.0, 0.75, 0.5, 0.25]

  for (const scalingFactor of scalingFactors) {
    const newWidth = Math.round(
      (context.metadata.width || 2000) * scalingFactor,
    )
    const newHeight = Math.round(
      (context.metadata.height || 2000) * scalingFactor,
    )

    let resizedImage = sharp(context.imageBuffer).resize(newWidth, newHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })

    // Apply format-specific optimizations
    resizedImage = applyFormatOptimizations(resizedImage, context.format)

    const resizedBuffer = await resizedImage.toBuffer()

    if (resizedBuffer.length <= context.maxBytes) {
      return createCompressedImageResult(
        resizedBuffer,
        context.format,
        context.originalSize,
      )
    }
  }

  return null
}

function applyFormatOptimizations(
  image: SharpInstance,
  format: string,
): SharpInstance {
  switch (format) {
    case 'png':
      return image.png({
        compressionLevel: 9,
        palette: true,
      })
    case 'jpeg':
    case 'jpg':
      return image.jpeg({ quality: 80 })
    case 'webp':
      return image.webp({ quality: 80 })
    default:
      return image
  }
}

async function tryPalettePNG(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const palettePng = await sharp(context.imageBuffer)
    .resize(800, 800, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({
      compressionLevel: 9,
      palette: true,
      colors: 64, // Reduce colors to 64 for better compression
    })
    .toBuffer()

  if (palettePng.length <= context.maxBytes) {
    return createCompressedImageResult(palettePng, 'png', context.originalSize)
  }

  return null
}

async function tryJPEGConversion(
  context: ImageCompressionContext,
  quality: number,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const jpegBuffer = await sharp(context.imageBuffer)
    .resize(600, 600, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer()

  if (jpegBuffer.length <= context.maxBytes) {
    return createCompressedImageResult(jpegBuffer, 'jpeg', context.originalSize)
  }

  return null
}

async function createUltraCompressedJPEG(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult> {
  const ultraCompressedBuffer = await sharp(context.imageBuffer)
    .resize(400, 400, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 20 })
    .toBuffer()

  return createCompressedImageResult(
    ultraCompressedBuffer,
    'jpeg',
    context.originalSize,
  )
}

/**
 * Detect image format from a buffer using magic bytes
 * @param buffer Buffer containing image data
 * @returns Media type string (e.g., 'image/png', 'image/jpeg') or 'image/png' as default
 */
export function detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType {
  if (buffer.length < 4) return 'image/png' // default

  // Check PNG signature
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }

  // Check JPEG signature (FFD8FF)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  // Check GIF signature (GIF87a or GIF89a)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif'
  }

  // Check WebP signature (RIFF....WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  ) {
    if (
      buffer.length >= 12 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp'
    }
  }

  // Default to PNG if unknown
  return 'image/png'
}

/**
 * Detect image format from base64 data using magic bytes
 * @param base64Data Base64 encoded image data
 * @returns Media type string (e.g., 'image/png', 'image/jpeg') or 'image/png' as default
 */
export function detectImageFormatFromBase64(
  base64Data: string,
): ImageMediaType {
  try {
    const buffer = Buffer.from(base64Data, 'base64')
    return detectImageFormatFromBuffer(buffer)
  } catch {
    // Default to PNG on any error
    return 'image/png'
  }
}

/**
 * Creates a text description of image metadata including dimensions and source path.
 * Returns null if no useful metadata is available.
 */
export function createImageMetadataText(
  dims: ImageDimensions,
  sourcePath?: string,
): string | null {
  const { originalWidth, originalHeight, displayWidth, displayHeight } = dims
  // Skip if dimensions are not available or invalid
  // Note: checks for undefined/null and zero to prevent division by zero
  if (
    !originalWidth ||
    !originalHeight ||
    !displayWidth ||
    !displayHeight ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    // If we have a source path but no valid dimensions, still return source info
    if (sourcePath) {
      return `[Image source: ${sourcePath}]`
    }
    return null
  }
  // Check if image was resized
  const wasResized =
    originalWidth !== displayWidth || originalHeight !== displayHeight

  // Only include metadata if there's useful info (resized or has source path)
  if (!wasResized && !sourcePath) {
    return null
  }

  // Build metadata parts
  const parts: string[] = []

  if (sourcePath) {
    parts.push(`source: ${sourcePath}`)
  }

  if (wasResized) {
    const scaleFactor = originalWidth / displayWidth
    parts.push(
      `original ${originalWidth}x${originalHeight}, displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scaleFactor.toFixed(2)} to map to original image.`,
    )
  }

  return `[Image: ${parts.join(', ')}]`
}
