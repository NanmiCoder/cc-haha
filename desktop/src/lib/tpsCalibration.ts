/**
 * Persisted TPS calibration.
 *
 * The meter learns its tokens-per-unit coefficients from the real
 * `usage.output_tokens` each API call reports (see TpsMeter.endCall). A fresh
 * session would otherwise start from the neutral 1.0 and mis-read until its
 * first call completes, so the coefficients are remembered per model.
 *
 * Keyed by model id because the coefficients describe one model's tokenizer
 * density — how many tokens a CJK character and a Latin/code character cost
 * it. Switching models therefore re-learns instead of inheriting the previous
 * model's numbers.
 *
 * Version 2 replaced the previous shape (kChunk/kChar, learned against a
 * per-frame unit). Those numbers were learned from a unit whose token density
 * varies by ~40x between content classes and went badly wrong on tool-input
 * traffic, so a stored v1 payload is discarded rather than reinterpreted.
 */

import type { TpsCalibration } from './tpsMeter'

export const TPS_CALIBRATION_STORAGE_KEY = 'cc-haha.tpsCalibration'
// v5: v4 entries may have been learned while the text estimator counted
// whitespace and used a lower CJK coefficient — both of which were wrong for
// this engine (measured: 1.003 tokens per Chinese character, whitespace free).
// Those coefficients would keep every reading about a third low, so they are
// discarded and re-learned.
// v4: v3 entries may have been seeded into subagent run meters, which then
// read the team speed about a third low. Nothing reads them that way any more,
// but purging keeps a stale value from surprising a future consumer.
// v3: v2 entries could have been written by a mid-run learning hook that paired
// a per-boundary token delta against every character since the meter was
// created, which understated the density and halved the displayed speed. The
// version check drops those entries so the coefficients are re-learned from
// matched spans only.
export const TPS_CALIBRATION_VERSION = 5

/** Keep the store small; the least recently used models are dropped first. */
const MAX_MODELS = 32
const UNKNOWN_MODEL = '__default__'

type StoredModelCalibration = {
  kCjk: number
  kAscii: number
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
  if (!entry || !isPositiveFinite(entry.kCjk) || !isPositiveFinite(entry.kAscii)) return null
  return { kCjk: entry.kCjk, kAscii: entry.kAscii }
}

/** Record what this model's calls taught, replacing any earlier entry. */
export function saveTpsCalibration(
  model: string | null | undefined,
  calibration: TpsCalibration,
  calls = 0,
): void {
  if (!isPositiveFinite(calibration.kCjk) || !isPositiveFinite(calibration.kAscii)) return
  const store = readStore()
  const key = modelKey(model)
  const previous = store.models[key]
  const previousCalls = previous && Number.isFinite(previous.n) ? previous.n : 0
  store.models[key] = {
    kCjk: calibration.kCjk,
    kAscii: calibration.kAscii,
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
