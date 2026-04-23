import { describe, expect, it } from 'bun:test'

import {
  getCliComputerUseCapabilities,
  isComputerUseSupportedPlatform,
} from './common.js'

describe('computer use platform helpers', () => {
  it('recognizes supported platforms', () => {
    expect(isComputerUseSupportedPlatform('darwin')).toBe(true)
    expect(isComputerUseSupportedPlatform('win32')).toBe(true)
    expect(isComputerUseSupportedPlatform('linux')).toBe(false)
  })

  it('returns macOS capabilities with native screenshot filtering', () => {
    expect(getCliComputerUseCapabilities('darwin')).toEqual({
      screenshotFiltering: 'native',
      platform: 'darwin',
    })
  })

  it('returns Windows capabilities with unfiltered screenshots', () => {
    expect(getCliComputerUseCapabilities('win32')).toEqual({
      screenshotFiltering: 'none',
      platform: 'win32',
    })
  })
})
