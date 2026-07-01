/**
 * Regression coverage for the IMAGE_FORMAT_UNSUPPORTED loop.
 *
 * Background: when an HTTP endpoint returns a JSON error body and curl -s writes
 * it into a file named `*.png`, `readImageWithTokenBudget` previously trusted
 * the extension, packaged the JSON bytes into a base64 image content block, and
 * Bedrock rejected the request with `IMAGE_FORMAT_UNSUPPORTED`. The bad block
 * stayed in the conversation history, so every subsequent turn re-triggered the
 * same 400 — the loop the user actually saw.
 *
 * These tests lock in: when the file's magic bytes don't match a known image
 * format, the tool surfaces a typed error (`InvalidImageDataError`) instead of
 * silently shipping malformed bytes to the model API.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../utils/fsOperations.js'
import {
  InvalidImageDataError,
  readImageWithTokenBudget,
} from './FileReadTool.js'

// Minimal valid 1x1 PNG — magic bytes `89 50 4E 47 0D 0A 1A 0A` then a real IHDR.
// Hand-crafted so we don't need sharp/node-canvas at test time.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636060000000050001a5f64570000000049454e44ae426082',
  'hex',
)

// The actual bug payload: 43 bytes of JSON error body written into a `.png` file.
const NOT_A_PNG_43_BYTES = Buffer.from(
  '{"ok":false,"message":"not found"}\n',
  'utf8',
)

function installFakeFs(fileMap: Record<string, Buffer>): void {
  const realFs = getFsImplementation()
  setFsImplementation({
    ...realFs,
    async readFileBytes(p: string) {
      const buf = fileMap[p]
      if (!buf) {
        throw new Error(`fake fs: no file at ${p}`)
      }
      return buf
    },
  })
}

describe('readImageWithTokenBudget — magic byte validation', () => {
  beforeEach(() => {
    setOriginalFsImplementation()
  })
  afterEach(() => {
    setOriginalFsImplementation()
  })

  test('throws InvalidImageDataError when a .png is actually a JSON error body', async () => {
    installFakeFs({
      '/fake/home_3_0_after_restart.png': NOT_A_PNG_43_BYTES,
    })

    let caught: unknown
    try {
      await readImageWithTokenBudget('/fake/home_3_0_after_restart.png')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(InvalidImageDataError)
    const err = caught as InvalidImageDataError
    // Error message has to carry enough context that the model can correct
    // course on the next turn — path + size + first bytes hex.
    expect(err.message).toContain('home_3_0_after_restart.png')
    expect(err.message).toContain(String(NOT_A_PNG_43_BYTES.length))
    // First 4 bytes of `{"ok` in hex
    expect(err.message).toContain('7b226f6b')
    expect(err.filePath).toBe('/fake/home_3_0_after_restart.png')
    expect(err.actualSize).toBe(NOT_A_PNG_43_BYTES.length)
  })

  test('throws InvalidImageDataError when the file is too small to validate', async () => {
    installFakeFs({
      '/fake/tiny.png': Buffer.from([0x89, 0x50, 0x4e]), // 3 bytes — PNG header truncated
    })

    await expect(
      readImageWithTokenBudget('/fake/tiny.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('preserves existing empty-file error (regression)', async () => {
    installFakeFs({
      '/fake/empty.png': Buffer.alloc(0),
    })

    await expect(
      readImageWithTokenBudget('/fake/empty.png'),
    ).rejects.toThrow(/empty/i)
  })

  test('accepts a real PNG with valid magic bytes', async () => {
    installFakeFs({
      '/fake/real.png': TINY_PNG,
    })

    const result = await readImageWithTokenBudget('/fake/real.png')
    expect(result.type).toBe('image')
    expect(result.file.type).toMatch(/^image\/(png|jpeg|webp|gif)$/)
  })
})
