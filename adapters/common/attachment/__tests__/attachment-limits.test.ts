import { describe, it, expect } from 'bun:test'
import {
  checkAttachmentLimit,
  IMAGE_MAX_BYTES,
  FILE_MAX_BYTES,
  IMAGE_MIME_WHITELIST,
} from '../attachment-limits.js'

describe('checkAttachmentLimit', () => {
  it('accepts a 1 MB PNG image', () => {
    const result = checkAttachmentLimit('image', 1024 * 1024, 'image/png')
    expect(result.ok).toBe(true)
  })

  it('rejects an 11 MB image as too_large', () => {
    const result = checkAttachmentLimit('image', 11 * 1024 * 1024, 'image/png')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('too_large')
      expect(result.hint).toContain('10')
    }
  })

  it('rejects an unsupported image mime', () => {
    const result = checkAttachmentLimit('image', 500_000, 'image/svg+xml')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported_mime')
  })

  it('rejects image/heic (not supported by Claude API)', () => {
    const result = checkAttachmentLimit('image', 500_000, 'image/heic')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported_mime')
  })

  it('accepts a 10 MB PDF file', () => {
    const result = checkAttachmentLimit('file', 10 * 1024 * 1024, 'application/pdf')
    expect(result.ok).toBe(true)
  })

  it('rejects a 31 MB file as too_large', () => {
    const result = checkAttachmentLimit('file', 31 * 1024 * 1024, 'application/pdf')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too_large')
  })

  it('exposes the limits as exports', () => {
    expect(IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(FILE_MAX_BYTES).toBe(30 * 1024 * 1024)
    expect(IMAGE_MIME_WHITELIST).toContain('image/png')
  })
})
