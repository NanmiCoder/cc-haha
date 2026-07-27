import { promises as fs } from 'node:fs'

/**
 * 从文件头读出图片的像素尺寸，只认站点用到的四种格式。
 * 不引第三方依赖 —— 站点的构建链路是刻意保持零外部图像库的。
 * 读不出来就返回 null，调用方跳过即可（顶多是那张图没有 width/height）。
 */
export async function readImageSize(filePath) {
  let handle
  try {
    handle = await fs.open(filePath, 'r')
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0)
    if (bytesRead < 16) return null

    // PNG: 8 字节签名 + IHDR，宽高是 16..24 的两个大端 uint32
    if (buffer.readUInt32BE(0) === 0x89504e47) {
      return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) }
    }

    // GIF: "GIF8" + 逻辑屏幕宽高（小端 uint16）
    if (buffer.toString('ascii', 0, 4) === 'GIF8') {
      return { height: buffer.readUInt16LE(8), width: buffer.readUInt16LE(6) }
    }

    // WebP: RIFF....WEBP，三种子格式的宽高位置各不相同
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

    // JPEG: 逐个 marker 往下走，直到碰上 SOFn
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

  // 帧头最多往后找 2000 个 marker，避免坏文件把构建卡死
  for (let guard = 0; guard < 2000; guard += 1) {
    const marker = await handle.read(head, 0, 2, offset)
    if (marker.bytesRead < 2 || head[0] !== 0xff) return null

    const code = head[1]
    // SOF0..SOF15，跳过 DHT(c4) / JPG(c8) / DAC(cc) 这三个不是帧头的
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
