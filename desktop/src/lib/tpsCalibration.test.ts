import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TPS_CALIBRATION_STORAGE_KEY,
  TPS_CALIBRATION_VERSION,
  clearTpsCalibration,
  loadTpsCalibration,
  saveTpsCalibration,
} from './tpsCalibration'

describe('tpsCalibration', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('round-trips the learned coefficients for a model', () => {
    expect(loadTpsCalibration('qwen3-coder')).toBeNull()
    saveTpsCalibration('qwen3-coder', { kCjk: 2.5, kAscii: 1.18 })
    expect(loadTpsCalibration('qwen3-coder')).toEqual({ kCjk: 2.5, kAscii: 1.18 })
  })

  it('keeps models apart so switching re-learns instead of inheriting', () => {
    saveTpsCalibration('model-a', { kCjk: 3, kAscii: 1.2 })
    saveTpsCalibration('model-b', { kCjk: 1, kAscii: 1.05 })
    expect(loadTpsCalibration('model-a')?.kCjk).toBe(3)
    expect(loadTpsCalibration('model-b')?.kCjk).toBe(1)
    expect(loadTpsCalibration('model-c')).toBeNull()
  })

  it('falls back to a shared bucket when the session has no model yet', () => {
    saveTpsCalibration(undefined, { kCjk: 4, kAscii: 1.1 })
    expect(loadTpsCalibration(null)).toEqual({ kCjk: 4, kAscii: 1.1 })
    expect(loadTpsCalibration('  ')).toEqual({ kCjk: 4, kAscii: 1.1 })
  })

  it('discards a payload written by another version instead of trusting it', () => {
    localStorage.setItem(TPS_CALIBRATION_STORAGE_KEY, JSON.stringify({
      version: TPS_CALIBRATION_VERSION + 1,
      models: { 'qwen3-coder': { kCjk: 9, kAscii: 9, n: 1, updatedAt: 1 } },
    }))
    expect(loadTpsCalibration('qwen3-coder')).toBeNull()
  })

  it('ignores a corrupt or non-numeric payload', () => {
    localStorage.setItem(TPS_CALIBRATION_STORAGE_KEY, '{not json')
    expect(loadTpsCalibration('qwen3-coder')).toBeNull()

    localStorage.setItem(TPS_CALIBRATION_STORAGE_KEY, JSON.stringify({
      version: TPS_CALIBRATION_VERSION,
      models: { 'qwen3-coder': { kCjk: 'x', kAscii: 1, n: 1, updatedAt: 1 } },
    }))
    expect(loadTpsCalibration('qwen3-coder')).toBeNull()
  })

  it('never stores a non-positive coefficient and survives a failing storage', () => {
    saveTpsCalibration('qwen3-coder', { kCjk: 0, kAscii: 1 })
    expect(loadTpsCalibration('qwen3-coder')).toBeNull()

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => saveTpsCalibration('qwen3-coder', { kCjk: 2, kAscii: 1 })).not.toThrow()
  })

  it('caps how many models it remembers, dropping the stalest', () => {
    const saving = vi.spyOn(Date, 'now')
    for (let i = 0; i < 40; i++) {
      saving.mockReturnValue(1_000 + i)
      saveTpsCalibration(`model-${i}`, { kCjk: 1 + i / 100, kAscii: 1 })
    }
    // The earliest models are gone; the most recent survive.
    expect(loadTpsCalibration('model-0')).toBeNull()
    expect(loadTpsCalibration('model-39')).not.toBeNull()
  })

  it('clears every remembered model', () => {
    saveTpsCalibration('model-a', { kCjk: 2, kAscii: 1 })
    clearTpsCalibration()
    expect(loadTpsCalibration('model-a')).toBeNull()
  })
})
