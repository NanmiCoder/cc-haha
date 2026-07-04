import { describe, expect, mock, test } from 'bun:test'

let sharpImportAttempted = false

mock.module('../../utils/bundledMode.js', () => ({
  isInBundledMode: () => true,
  isRunningWithBun: () => true,
}))

mock.module('image-processor-napi', () => {
  throw new Error('native module missing')
})

mock.module('sharp', () => {
  sharpImportAttempted = true
  return {
    default: () => ({
      metadata: async () => ({ width: 1, height: 1, format: 'png' }),
      resize() { return this },
      jpeg() { return this },
      png() { return this },
      webp() { return this },
      toBuffer: async () => Buffer.from('sharp'),
    }),
  }
})

const { getImageProcessor, resetImageProcessorForTests } = await import('./imageProcessor.js')

describe('getImageProcessor', () => {
  test('does not fall back to external sharp in bundled mode when native processor is unavailable', async () => {
    resetImageProcessorForTests()
    sharpImportAttempted = false

    await expect(getImageProcessor()).rejects.toThrow(
      'Native image processor module not available in bundled mode',
    )
    expect(sharpImportAttempted).toBe(false)
  })
})
