import { promises as fs } from 'node:fs'

/**
 * Read an image's pixel size from its file header; only the four formats the site uses are recognized.
 * No third-party dependency — the site build deliberately has zero external image libraries.
 * Returns null when it cannot read the size; callers just skip it (at worst that image has no width/height).
 */
export async function readImageSize(filePath) {
  let handle
  try {
    handle = await fs.open(filePath, 'r')
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0)
    if (bytesRead < 16) return null

    // PNG: 8-byte signature + IHDR; width and height are two big-endian uint32s at 16..24
    if (buffer.readUInt32BE(0) === 0x89504e47) {
      return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) }
    }

    // GIF: "GIF8" + logical screen width/height (little-endian uint16)
    if (buffer.toString('ascii', 0, 4) === 'GIF8') {
      return { height: buffer.readUInt16LE(8), width: buffer.readUInt16LE(6) }
    }

    // WebP: RIFF....WEBP; the three sub-formats store width/height in different places
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const format = buffer.toString('ascii', 12, 16)

      if (format === 'VP8 ') {
        return { height: buffer.readUInt16LE(28) & 0x3fff, width: buffer.readUInt16LE(26) & 0x3fff }
      }
      if (format === 'VP8L') {
        const bits = buffer.readUInt32LE(21)
        return { height: ((bits >> 14) & 0x3fff) + 1, width: (bits & 0x3fff) + 1 }
      }
      if (format === 'VP8X') {
        const read24 = (offset) =>
          buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
        return { height: read24(27) + 1, width: read24(24) + 1 }
      }
      return null
    }

    // JPEG: walk marker by marker until hitting SOFn
    if (buffer.readUInt16BE(0) === 0xffd8) {
      return await readJpegSize(handle)
    }

    return null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

async function readJpegSize(handle) {
  const head = Buffer.alloc(2)
  const size = Buffer.alloc(2)
  const frame = Buffer.alloc(5)
  let offset = 2

  // Look at most 2000 markers ahead for the frame header so a broken file cannot hang the build
  for (let guard = 0; guard < 2000; guard += 1) {
    const marker = await handle.read(head, 0, 2, offset)
    if (marker.bytesRead < 2 || head[0] !== 0xff) return null

    const code = head[1]
    // SOF0..SOF15, skipping DHT(c4) / JPG(c8) / DAC(cc), which are not frame headers
    if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      const read = await handle.read(frame, 0, 5, offset + 4)
      if (read.bytesRead < 5) return null
      return { height: frame.readUInt16BE(1), width: frame.readUInt16BE(3) }
    }

    const length = await handle.read(size, 0, 2, offset + 2)
    if (length.bytesRead < 2) return null
    offset += 2 + size.readUInt16BE(0)
  }

  return null
}
