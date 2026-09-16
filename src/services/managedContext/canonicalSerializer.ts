/**
 * The single canonical serializer for managed-context bindings.
 *
 * Rules (design/linux-hosts-knowledge/02-functional-technical-design.md §8.1):
 * - object keys are sorted recursively by Unicode code point;
 * - arrays keep their given (selection) order;
 * - only JSON scalars/arrays/objects are allowed — `undefined`, non-finite
 *   numbers, `Date` and other class instances are rejected;
 * - the UTF-8 bytes are hashed with SHA-256 and rendered as lowercase hex.
 *
 * Bindings are binding/dedup aids, not secret authentication.
 */

import { createHash } from 'node:crypto'
import type { ConversationContextSelectionV2, SourceTag } from './types.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export class CanonicalSerializationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${message} at ${path}`)
    this.name = 'CanonicalSerializationError'
    this.path = path
  }
}

/** Unicode code-point order, not UTF-16 code-unit order. */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    const diff = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

function canonicalizeValue(value: unknown, path: string): JsonValue {
  if (value === null) return null

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalSerializationError(path, 'non-finite numbers are not serializable')
      }
      return value
    case 'undefined':
      throw new CanonicalSerializationError(path, 'undefined is not serializable')
    case 'bigint':
    case 'symbol':
    case 'function':
      throw new CanonicalSerializationError(path, `${typeof value} is not serializable`)
    default:
      break
  }

  if (value instanceof Date) {
    throw new CanonicalSerializationError(path, 'Date objects are not serializable')
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalizeValue(entry, `${path}[${index}]`))
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalSerializationError(path, 'only plain objects are serializable')
  }

  const record = value as Record<string, unknown>
  const result: Record<string, JsonValue> = {}
  for (const key of Object.keys(record).sort(compareCodePoints)) {
    result[key] = canonicalizeValue(record[key], `${path}.${key}`)
  }
  return result
}

/** Deterministic JSON text: recursively sorted keys, selection order preserved. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value, '$'))
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/**
 * contextBinding input (§8.1): the full selection v2 without each
 * `sourceTags[].labelAtSelection`, so renaming a tag does not invalidate the
 * binding while a changed membership does.
 */
export function contextBindingInput(
  selection: ConversationContextSelectionV2,
): JsonValue {
  return canonicalizeValue(
    {
      ...selection,
      sourceTags: selection.sourceTags.map((tag) => {
        const { labelAtSelection: _labelAtSelection, ...rest } = tag
        return rest as SourceTag
      }),
    },
    '$',
  )
}

export function contextBindingOf(selection: ConversationContextSelectionV2): string {
  return hashCanonical(contextBindingInput(selection))
}
