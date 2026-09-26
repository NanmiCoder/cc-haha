/**
 * Persisted TPS calibration.
 *
 * The meter learns its tokens-per-unit coefficients from the real
 * `usage.output_tokens` each API call reports (see TpsMeter.endCall). A fresh
 * session would otherwise start from 1.0 and under-read until its first call
 * completes, so the coefficients are remembered per model and seeded back.
 *
 * Keyed by model id because the coefficients describe one model/engine pairing:
 * its tokens-per-frame batching and its tokenizer's text density. Switching
 * models therefore re-learns instead of inheriting someone else's numbers.
 */

import type { TpsCalibration } from './tpsMeter'

export const TPS_CALIBRATION_STORAGE_KEY = 'cc-haha.tpsCalibration'
export const TPS_CALIBRATION_VERSION = 1

/** Keep the store small; the least recently used models are dropped first. */
const MAX_MODELS = 32
const UNKNOWN_MODEL = '__default__'

type StoredModelCalibration = {
  kChunk: number
  kChar: number
  /** How many completed calls taught this entry (diagnostics). */
  n: number
  updatedAt: number
}

type StoredCalibration = {
  version: number
  models: Record<string, StoredModelCalibration>
}

function emptyStore(): StoredCalibration {
  return { version: TPS_CALIBRATION_VERSION, models: {} }
}

function modelKey(model: string | null | undefined): string {
  const trimmed = model?.trim()
  return trimmed ? trimmed : UNKNOWN_MODEL
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function readStore(): StoredCalibration {
  try {
    const raw = localStorage.getItem(TPS_CALIBRATION_STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<StoredCalibration> | null
    // A payload from a future build is not ours to interpret; start clean
    // rather than guess at its shape.
    if (!parsed || parsed.version !== TPS_CALIBRATION_VERSION || typeof parsed.models !== 'object') {
      return emptyStore()
    }
    return { version: TPS_CALIBRATION_VERSION, models: parsed.models as Record<string, StoredModelCalibration> }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: StoredCalibration): void {
  try {
    localStorage.setItem(TPS_CALIBRATION_STORAGE_KEY, JSON.stringify(store))
  } catch { /* localStorage unavailable — keep the in-memory value */ }
}

/** Learned coefficients for `model`, or null when nothing usable is stored. */
export function loadTpsCalibration(model: string | null | undefined): TpsCalibration | null {
  const entry = readStore().models[modelKey(model)]
  if (!entry || !isPositiveFinite(entry.kChunk) || !isPositiveFinite(entry.kChar)) return null
  return { kChunk: entry.kChunk, kChar: entry.kChar }
}

/** Record what this model's calls taught, replacing any earlier entry. */
export function saveTpsCalibration(
  model: string | null | undefined,
  calibration: TpsCalibration,
  calls = 0,
): void {
  if (!isPositiveFinite(calibration.kChunk) || !isPositiveFinite(calibration.kChar)) return
  const store = readStore()
  const key = modelKey(model)
  const previous = store.models[key]
  const previousCalls = previous && Number.isFinite(previous.n) ? previous.n : 0
  store.models[key] = {
    kChunk: calibration.kChunk,
    kChar: calibration.kChar,
    n: Math.max(0, calls) || previousCalls + 1,
    updatedAt: Date.now(),
  }
  const keys = Object.keys(store.models)
  if (keys.length > MAX_MODELS) {
    keys
      .sort((a, b) => (store.models[a]?.updatedAt ?? 0) - (store.models[b]?.updatedAt ?? 0))
      .slice(0, keys.length - MAX_MODELS)
      .forEach((stale) => { delete store.models[stale] })
  }
  writeStore(store)
}

/** Drop every remembered model (tests / troubleshooting). */
export function clearTpsCalibration(): void {
  try {
    localStorage.removeItem(TPS_CALIBRATION_STORAGE_KEY)
  } catch { /* localStorage unavailable */ }
}
