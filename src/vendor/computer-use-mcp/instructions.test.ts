import { describe, expect, test } from 'bun:test'
import { COMPUTER_USE_INSTRUCTIONS } from './instructions.js'

describe('macOS action and observation guidance', () => {
  test('uses persistent JS for known actions without demanding a model round trip per click', () => {
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('Do not force one model round trip per click')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('then observe at a decision point')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('Do not add a fixed sleep before observing')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('Use copied `gN:id` handles')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('new Promise(resolve => setTimeout(resolve, milliseconds))')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('Timers belong to the current cell and are cleared when it')
  })

  test('keeps standalone receipts and unknown paste results subject to observation', () => {
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('receiving a standalone dispatch receipt')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('Inspect a fresh observation')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('treat the result as unknown and call')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('stop and re-observe')
  })
})
