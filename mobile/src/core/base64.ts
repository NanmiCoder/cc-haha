/**
 * Base64 与字节互转（Hermes 没有 Buffer）。图片经直连下载时整段都要过一遍：
 * Hermes 没有 JIT，逐字符拼接的纯 JS 实现对几 MB 的正文会卡住界面，所以有平台的
 * atob/btoa（Hermes 和浏览器都有）就用它们，纯 JS 只做兜底。调用时才检查，测试能去掉它们验证兜底。
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const VALUES = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i
/**
 * 3 的倍数：除了最后一段，每段编码后都不带补位，可以直接拼起来。
 * 也是 String.fromCharCode.apply 一次的参数个数，留在各引擎的参数上限以内。
 */
const SLICE = 3 * 4096

type Platform = { atob?: (text: string) => string; btoa?: (text: string) => string }
const platform = () => globalThis as Platform

export function bytesToBase64(bytes: Uint8Array): string {
  const btoa = platform().btoa
  const parts: string[] = []
  for (let start = 0; start < bytes.length; start += SLICE) {
    const slice = bytes.subarray(start, Math.min(bytes.length, start + SLICE))
    parts.push(btoa ? btoa(String.fromCharCode.apply(null, slice as unknown as number[])) : encodeSlice(slice))
  }
  return parts.join('')
}

export function base64ToBytes(text: string): Uint8Array {
  const atob = platform().atob
  if (atob) {
    try {
      const binary = atob(text)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    } catch {
      /* 平台实现不接受这段文本（例如不规范的补位）：交给下面的宽松解码。 */
    }
  }
  return decode(text)
}

function encodeSlice(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out +=
      ALPHABET[a >> 2]! +
      ALPHABET[((a & 3) << 4) | (b >> 4)]! +
      (i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : '=') +
      (i + 2 < bytes.length ? ALPHABET[c & 63]! : '=')
  }
  return out
}

/** 跳过字母表以外的字符（换行、补位），按 6 位一组拼回字节。 */
function decode(text: string) {
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4))
  let length = 0
  let bits = 0
  let value = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const digit = code < 128 ? VALUES[code]! : -1
    if (digit < 0) continue
    value = ((value << 6) | digit) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[length++] = (value >> bits) & 255
    }
  }
  return bytes.subarray(0, length)
}
