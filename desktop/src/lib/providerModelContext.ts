// desktop/src/lib/providerModelContext.ts

import type { Model1mSupport } from '../types/provider'

export const MODEL_SLOTS = ['main', 'fable', 'haiku', 'sonnet', 'opus'] as const
export type ModelSlot = typeof MODEL_SLOTS[number]
export type ModelContextInputs = Record<ModelSlot, string>

export const MODEL_CONTEXT_WINDOW_MIN = 16000
export const MODEL_CONTEXT_WINDOW_MAX = 10000000
export const MODEL_1M_CONTEXT_WINDOW = 1000000

export function parseAutoCompactWindowInput(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed)) return undefined
  if (parsed < MODEL_CONTEXT_WINDOW_MIN || parsed > MODEL_CONTEXT_WINDOW_MAX) return undefined
  return parsed
}

export function getAutoCompactWindowErrorKey(value: string): 'number' | 'range' | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed)) return 'number'
  if (parsed < MODEL_CONTEXT_WINDOW_MIN || parsed > MODEL_CONTEXT_WINDOW_MAX) return 'range'
  return null
}

export function parseModelContextWindowsInput(value: string): number | undefined {
  return parseAutoCompactWindowInput(value)
}

export function getModelContextWindowErrorKey(value: string): 'number' | 'range' | null {
  return getAutoCompactWindowErrorKey(value)
}

export function shouldFill1mContextWindow(value: string): boolean {
  const parsed = parseModelContextWindowsInput(value)
  return parsed === undefined || parsed < MODEL_1M_CONTEXT_WINDOW
}

/**
 * Keeps a slot's context-window field in sync with its 1M checkbox.
 *
 * Ticking the box fills in 1,000,000. Clearing it has to take that value back
 * out: a 256K endpoint left pinned at 1M never reaches the auto-compaction
 * threshold, so the conversation grows until the provider rejects it on its own
 * hard limit. Only the value we filled in is reverted — anything else in the
 * field was typed by the user and stays.
 *
 * `rollbackValue` is what the field falls back to, normally the preset's window
 * for that model and an empty string when the preset has none. Passing
 * `undefined` opts out of the revert, for callers that derived the field from
 * scratch and have nothing to undo.
 */
export function apply1mSupportToContextInput(
  inputs: ModelContextInputs,
  slot: ModelSlot,
  enabled: boolean,
  rollbackValue?: string,
): ModelContextInputs {
  const current = inputs[slot]

  if (enabled) {
    if (!shouldFill1mContextWindow(current)) return inputs
    return { ...inputs, [slot]: String(MODEL_1M_CONTEXT_WINDOW) }
  }

  if (rollbackValue === undefined) return inputs
  if (parseModelContextWindowsInput(current) !== MODEL_1M_CONTEXT_WINDOW) return inputs
  const next = rollbackValue.trim()
  if (next === current) return inputs
  return { ...inputs, [slot]: next }
}

export function apply1mSupportToContextInputs(
  inputs: ModelContextInputs,
  model1mSupport: Model1mSupport,
): ModelContextInputs {
  let nextInputs = inputs
  for (const slot of MODEL_SLOTS) {
    nextInputs = apply1mSupportToContextInput(nextInputs, slot, model1mSupport[slot])
  }
  return nextInputs
}
