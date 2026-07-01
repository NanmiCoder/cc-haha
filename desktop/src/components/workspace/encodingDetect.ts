/**
 * Pure utilities for detecting file encoding (UTF-8 vs UTF-8 BOM vs
 * unsupported) and line endings (LF / CRLF / CR) for the workspace editor.
 *
 * Used by `WorkspaceEditor.tsx` to decide whether a file can be opened in
 * the CodeMirror editor (UTF-8 family only) and to round-trip the original
 * BOM / line-ending style on save.
 *
 * No I/O, no DOM. Bytes-in / characters-in / strings-out — easy to unit-test.
 *
 * _Requirements: 1.6, 1.7 (Phase 2 task 7)_
 */

export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'unsupported'

export type FileLineEnding = 'LF' | 'CRLF' | 'CR'

/**
 * UTF-8 BOM is the byte sequence EF BB BF at the start of a buffer.
 */
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const

/**
 * UTF-16 BOMs are the most common alternative — surface them as
 * `'unsupported'` so the editor can fall back to the read-only preview path.
 */
const UTF16_BE_BOM = [0xfe, 0xff] as const
const UTF16_LE_BOM = [0xff, 0xfe] as const

function startsWith(bytes: Uint8Array | ArrayLike<number>, prefix: ArrayLike<number>): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

/**
 * Detect the encoding of a byte buffer.
 *
 * - Returns `'utf-8-bom'` when the buffer starts with EF BB BF.
 * - Returns `'unsupported'` for UTF-16 BOMs (FE FF / FF FE) and any byte
 *   sequence that is not valid UTF-8.
 * - Returns `'utf-8'` for valid UTF-8 (with or without ASCII content).
 *
 * Uses `TextDecoder('utf-8', { fatal: true })` so invalid sequences throw and
 * are mapped to `'unsupported'` — matching what the editor will reject anyway.
 */
export function detectEncoding(bytes: Uint8Array): FileEncoding {
  if (startsWith(bytes, UTF8_BOM)) return 'utf-8-bom'
  if (startsWith(bytes, UTF16_BE_BOM)) return 'unsupported'
  if (startsWith(bytes, UTF16_LE_BOM)) return 'unsupported'

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    return 'unsupported'
  }
}

/**
 * Detect the dominant line-ending style of a text string.
 *
 * - Mixed buffers fall back to whichever style appears more often.
 * - Empty / single-line buffers default to `'LF'` so the editor uses the
 *   platform-neutral default rather than guessing wrong.
 * - Bare `\r` (classic Mac) is reported as `'CR'` so we can preserve it on
 *   round-trip even though we never produce it ourselves.
 */
export function detectLineEnding(text: string): FileLineEnding {
  let crlf = 0
  let lfOnly = 0
  let crOnly = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 0x0d /* CR */) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a /* LF */) {
        crlf++
        i++ // consume the paired LF
      } else {
        crOnly++
      }
    } else if (ch === 0x0a /* LF */) {
      lfOnly++
    }
  }

  if (crlf === 0 && lfOnly === 0 && crOnly === 0) return 'LF'

  if (crlf >= lfOnly && crlf >= crOnly) return 'CRLF'
  if (crOnly > lfOnly && crOnly > crlf) return 'CR'
  return 'LF'
}
