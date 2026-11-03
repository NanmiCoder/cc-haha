import { afterEach, describe, expect, test } from 'bun:test'
import { getChicagoEnabled, shouldExposeComputerUseMcp } from './gates.js'

const ORIGINAL_ENABLED = process.env.CLAUDE_COMPUTER_USE_ENABLED

afterEach(() => {
  if (ORIGINAL_ENABLED === undefined) {
    delete process.env.CLAUDE_COMPUTER_USE_ENABLED
  } else {
    process.env.CLAUDE_COMPUTER_USE_ENABLED = ORIGINAL_ENABLED
  }
})

describe('getChicagoEnabled', () => {
  test('defaults Computer Use on', () => {
    delete process.env.CLAUDE_COMPUTER_USE_ENABLED
    expect(getChicagoEnabled()).toBe(true)
  })

  test('honors explicit falsy env values', () => {
    process.env.CLAUDE_COMPUTER_USE_ENABLED = '0'
    expect(getChicagoEnabled()).toBe(false)

    process.env.CLAUDE_COMPUTER_USE_ENABLED = 'false'
    expect(getChicagoEnabled()).toBe(false)
  })
})

describe('shouldExposeComputerUseMcp', () => {
  test('requires the canonical native helper on macOS', () => {
    expect(shouldExposeComputerUseMcp('darwin', true)).toBe(true)
    expect(shouldExposeComputerUseMcp('darwin', false)).toBe(false)
  })

  test('requires the packaged native runtime on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      expect(shouldExposeComputerUseMcp(platform, false, true)).toBe(true)
      expect(shouldExposeComputerUseMcp(platform, true, false)).toBe(false)
    }
    expect(shouldExposeComputerUseMcp('freebsd', true, true)).toBe(false)
  })
})
