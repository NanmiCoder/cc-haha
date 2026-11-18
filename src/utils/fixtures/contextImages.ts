import sharp from 'sharp'

/** Generated screenshot-like pixels, never a real user's image or filesystem. */
export async function createContextImage(options: {
  width?: number
  height?: number
  alpha?: boolean
  seed?: number
  marker?: { r: number; g: number; b: number }
} = {}): Promise<Buffer> {
  const { width = 1600, height = 900, alpha = false } = options
  const channels = alpha ? 4 : 3
  const pixels = Buffer.alloc(width * height * channels)
  let seed = options.seed ?? 1888
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const noise = (seed >>> 27) - 16
      const offset = (y * width + x) * channels
      pixels[offset] = Math.round(40 + x / width * 80 + noise)
      pixels[offset + 1] = Math.round(60 + y / height * 80 + noise)
      pixels[offset + 2] = Math.round(90 + x / width * 80 + noise)
      if (alpha) pixels[offset + 3] = x < width / 2 ? 0 : 128
    }
  }
  const image = sharp(pixels, { raw: { width, height, channels } })
  // Mark the raw fixture before its only PNG encode, rather than round-tripping
  // every screenshot through an intermediate PNG inside the timed Read test.
  const marked = options.marker ? image.composite([{
    input: { create: { width: 64, height: 64, channels: 3, background: options.marker } },
    left: 32,
    top: 32,
  }]) : image
  return marked.png().toBuffer()
}
