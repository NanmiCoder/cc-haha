/**
 * U06 seam — the composer's slash parser hands `/hh` `/ce` `/db` `/rd` to the
 * managed-resources picker and leaves every other command to the original
 * parser in `components/chat/composerUtils.ts`.
 *
 * This module is pure: no React, no store, no host. `composerUtils` re-exports
 * `classifyContextSlash` as `findContextSlash`, and the picker integration
 * consumes that, so there is exactly one parser and no second one to drift.
 */
import {
  checkSlashAvailability,
  findContextSlashTrigger,
  type ContextSlashTrigger,
  type ContextTriggerOptions,
  type SlashCommand,
} from '../composer/contextPicker.js'

export type { ContextSlashTrigger, ContextTriggerOptions } from '../composer/contextPicker.js'

/** Which resource surface a trigger opens. `/db` `/rd` are gated and have none. */
export type ContextPickerKind = 'host' | 'concept' | 'database' | 'redis'

export type ContextSlashClassification =
  | { type: 'none' }
  | {
      type: 'context-picker'
      command: SlashCommand
      kind: ContextPickerKind
      filter: string
      slashPos: number
    }
  | {
      type: 'unavailable'
      command: 'db' | 'rd'
      filter: string
      slashPos: number
    }

export function contextPickerKindFor(command: SlashCommand): ContextPickerKind {
  if (command === 'hh') return 'host'
  if (command === 'ce') return 'concept'
  if (command === 'db') return 'database'
  return 'redis'
}

/**
 * Classify the text at the caret.
 *
 * `{ type: 'none' }` means "not mine": the caller must run its original slash
 * handling untouched. `/db` and `/rd` are classified as `unavailable` — the
 * M9 gate in `contextPicker.checkSlashAvailability` stays the single source of
 * truth for that decision, and the UI renders a local empty state instead of
 * touching a database or Redis.
 */
export function classifyContextSlash(
  value: string,
  cursorPos: number,
  options: ContextTriggerOptions = {},
): ContextSlashClassification {
  const trigger: ContextSlashTrigger | null = findContextSlashTrigger(value, cursorPos, options)
  if (!trigger) return { type: 'none' }

  if (!checkSlashAvailability(trigger.command).available) return { type: 'none' }
  const kind = contextPickerKindFor(trigger.command)

  return {
    type: 'context-picker',
    command: trigger.command,
    kind,
    filter: trigger.filter,
    slashPos: trigger.slashPos,
  }
}

/**
 * The same classification, or `null` when the text carries no context trigger.
 * Callers that already branch on "is this mine?" use this shape.
 */
export function resolveContextSlash(
  value: string,
  cursorPos: number,
  options: ContextTriggerOptions = {},
): Exclude<ContextSlashClassification, { type: 'none' }> | null {
  const classification = classifyContextSlash(value, cursorPos, options)
  return classification.type === 'none' ? null : classification
}
