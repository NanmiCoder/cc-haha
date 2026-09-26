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

  test('keeps Windows and Linux compatibility independent and rejects other platforms', () => {
    expect(shouldExposeComputerUseMcp('win32', false)).toBe(true)
    expect(shouldExposeComputerUseMcp('linux', false)).toBe(true)
    expect(shouldExposeComputerUseMcp('freebsd', true)).toBe(false)
  })
})
