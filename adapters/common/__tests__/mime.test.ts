import { describe, expect, it } from 'bun:test'
import {
  attachmentKindForMime,
  imageExtensionForMime,
  inferMimeFromFileName,
} from '../attachment/mime.js'

describe('inferMimeFromFileName', () => {
  it('maps a known extension case-insensitively', () => {
    expect(inferMimeFromFileName('report.PDF')).toBe('application/pdf')
    expect(inferMimeFromFileName('photo.jpeg')).toBe('image/jpeg')
  })

  it('returns undefined rather than guessing for unknown or extensionless names', () => {
    expect(inferMimeFromFileName('archive.unknownext')).toBeUndefined()
    expect(inferMimeFromFileName('Makefile')).toBeUndefined()
    expect(inferMimeFromFileName(undefined)).toBeUndefined()
  })
})

describe('imageExtensionForMime', () => {
  it('maps image MIMEs to the extension the platform expects', () => {
    expect(imageExtensionForMime('image/jpeg')).toBe('jpg')
    expect(imageExtensionForMime('image/webp')).toBe('webp')
  })

  it('ignores charset parameters', () => {
    expect(imageExtensionForMime('image/png; charset=binary')).toBe('png')
  })

  it('falls back to png for anything unrecognised', () => {
    expect(imageExtensionForMime('application/pdf')).toBe('png')
    expect(imageExtensionForMime(undefined)).toBe('png')
  })
})

describe('attachmentKindForMime', () => {
  // The size limits and the wire representation differ between the two, so a
  // wrong answer here means either a rejected image or an oversized upload.
  it('classifies images and everything else', () => {
    expect(attachmentKindForMime('image/png')).toBe('image')
    expect(attachmentKindForMime('IMAGE/PNG')).toBe('image')
    expect(attachmentKindForMime('application/pdf')).toBe('file')
    expect(attachmentKindForMime(undefined)).toBe('file')
  })
})
