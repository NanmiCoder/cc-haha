import { isUtf8 } from 'node:buffer'

type LegacyDecoder = (bytes: Buffer) => string | undefined
type DecodedOutput = { content: string; bytesRead: number }

let decodeNative: LegacyDecoder | null | undefined

function decodeWindowsOutput(bytes: Buffer): string | undefined {
  if (decodeNative === undefined) {
    decodeNative = null
    if (typeof Bun !== 'undefined') {
      try {
        const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi')
        const kernel = dlopen('kernel32.dll', {
          GetOEMCP: { args: [], returns: 'u32' },
          MultiByteToWideChar: {
            args: ['u32', 'u32', 'ptr', 'i32', 'ptr', 'i32'],
            returns: 'i32',
          },
        } as const)
        // Hidden Windows subprocesses have no attached console and legacy
        // console programs then use the system OEM code page.
        const codePage = kernel.symbols.GetOEMCP()
        if (codePage && codePage !== 65001) {
          decodeNative = data => {
            const output = Buffer.allocUnsafe(data.length * 2)
            const chars = kernel.symbols.MultiByteToWideChar(
              codePage, 0, ptr(data), data.length, ptr(output), data.length,
            )
            return chars > 0 ? output.toString('utf16le', 0, chars * 2) : undefined
          }
        } else {
          kernel.close()
        }
      } catch {
        // A missing native decoder must not hide command output.
      }
    }
  }
  return decodeNative?.(bytes)
}

function tryDecodeUtf8(
  bytes: Buffer,
  startsMidFile: boolean,
  endsMidFile: boolean,
): DecodedOutput | undefined {
  let start = 0
  // The tail reader verifies a UTF-8 character across its read boundary.
  if (startsMidFile) {
    while (start < 3 && start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  }
  const input = bytes.subarray(start)
  if (isUtf8(input)) return { content: input.toString('utf8'), bytesRead: bytes.length }
  if (!endsMidFile) return undefined
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      input,
      { stream: true },
    )
    // The next range read can consume a partial trailing character once all
    // its bytes are available.
    return { content, bytesRead: start + Buffer.byteLength(content, 'utf8') }
  } catch {
    return undefined
  }
}

/** Detect a UTF-8 character crossing the tail boundary using up to three preceding bytes. */
export function hasClippedUtf8Start(bytes: Buffer, offset: number): boolean {
  if (offset <= 0 || offset >= bytes.length || (bytes[offset]! & 0xc0) !== 0x80) return false
  let start = offset
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--
  let end = offset
  while (end < bytes.length && end - start < 5 && (bytes[end]! & 0xc0) === 0x80) end++
  return start < offset && isUtf8(bytes.subarray(start, end))
}

/** Decode bounded shell-output windows, preserving the raw file and byte offsets. */
export function decodeShellOutput(
  bytes: Buffer,
  startsMidFile = false,
  endsMidFile = false,
  legacy: LegacyDecoder | undefined = process.platform === 'win32' ? decodeWindowsOutput : undefined,
): DecodedOutput {
  if (!legacy) return { content: bytes.toString('utf8'), bytesRead: bytes.length }
  const utf8 = tryDecodeUtf8(bytes, startsMidFile, endsMidFile)
  if (utf8) return utf8

  // Bash and its Windows children can write different encodings into the
  // same file. Preserve valid UTF-8 lines even when another line uses OEM.
  let content = ''
  let offset = 0
  let legacyStart: number | undefined
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset)
    const end = newline < 0 ? bytes.length : newline + 1
    const line = bytes.subarray(offset, end)
    const partialEnd = newline < 0 && endsMidFile
    const utf8Line = tryDecodeUtf8(line, offset === 0 && startsMidFile, partialEnd)
    if (utf8Line) {
      if (legacyStart !== undefined) {
        const chunk = bytes.subarray(legacyStart, offset)
        content += legacy(chunk) ?? chunk.toString('utf8')
        legacyStart = undefined
      }
      content += utf8Line.content
      if (utf8Line.bytesRead < line.length) {
        return { content, bytesRead: offset + utf8Line.bytesRead }
      }
    } else {
      legacyStart ??= offset
    }
    offset = end
  }
  if (legacyStart !== undefined) {
    const chunk = bytes.subarray(legacyStart)
    const decoded = legacy(chunk)
    // A trailing lead byte in a clipped DBCS line decodes as U+FFFD.
    if (endsMidFile && decoded?.endsWith('\uFFFD')) {
      return { content: content + decoded.slice(0, -1), bytesRead: offset - 1 }
    }
    content += decoded ?? chunk.toString('utf8')
  }
  return { content, bytesRead: offset }
}
