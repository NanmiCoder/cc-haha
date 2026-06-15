/**
 * Claude Code CCH signing logic based on sub2api.
 * Reference: https://github.com/Wei-Shaw/sub2api
 * License: LGPL-3.0-or-later, Copyright (c) 2026 Wesley Liddick.
 */
import { CLAUDE_CODE_BILLING_HEADER_PREFIX } from '../constants/claudeCodeCompatibility.js'

const CCH_PLACEHOLDER = 'cch=00000;'
const CCH_PLACEHOLDER_RE = /\bcch=00000;/g
const CCH_SEED = 0x6E52736AC806831En
const MASK_64 = 0xffffffffffffffffn
const PRIME64_1 = 11400714785074694791n
const PRIME64_2 = 14029467366897019727n
const PRIME64_3 = 1609587929392839161n
const PRIME64_4 = 9650029242287828579n
const PRIME64_5 = 2870177450012600261n

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function signClaudeCodeCCHInString(body: string): string {
  if (!body.includes(CLAUDE_CODE_BILLING_HEADER_PREFIX) || !body.includes(CCH_PLACEHOLDER)) return body

  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return body
  }

  if (countCCHPlaceholders(body) !== 1) return body

  const billingFields = selectAnthropicBillingFields(parsed)
  const placeholderCount = billingFields.reduce((count, value) => count + countCCHPlaceholders(value), 0)
  if (placeholderCount !== 1) return body

  const billingField = billingFields.find(value => countCCHPlaceholders(value) === 1)
  if (!billingField) return body

  const fieldLiteral = JSON.stringify(billingField)
  if (countLiteralOccurrences(body, fieldLiteral) !== 1) return body

  const cch = computeClaudeCodeCCH(body)
  const signedField = billingField.replace(CCH_PLACEHOLDER_RE, `cch=${cch};`)
  return body.replace(fieldLiteral, JSON.stringify(signedField))
}

export function signClaudeCodeCCHBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body === 'string') {
    return signClaudeCodeCCHInString(body)
  }

  if (body instanceof Uint8Array) {
    const raw = decoder.decode(body)
    const signed = signClaudeCodeCCHInString(raw)
    return signed === raw ? body : encoder.encode(signed)
  }

  return body
}

function selectAnthropicBillingFields(parsed: unknown): string[] {
  if (!isRecord(parsed)) return []

  const { system } = parsed
  if (typeof system === 'string') {
    return isBillingHeader(system) ? [system] : []
  }
  if (!Array.isArray(system)) return []

  return system.flatMap(block => (
    isTextBlock(block) && isBillingHeader(block.text) ? [block.text] : []
  ))
}

function isBillingHeader(value: string): boolean {
  return value.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX)
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function countCCHPlaceholders(value: string): number {
  return value.match(CCH_PLACEHOLDER_RE)?.length ?? 0
}

function countLiteralOccurrences(body: string, literal: string): number {
  let count = 0
  let index = body.indexOf(literal)
  while (index !== -1) {
    count += 1
    index = body.indexOf(literal, index + literal.length)
  }
  return count
}

function computeClaudeCodeCCH(body: string): string {
  return (xxHash64Seeded(encoder.encode(body), CCH_SEED) & 0xfffffn)
    .toString(16)
    .padStart(5, '0')
}

export function xxHash64Seeded(data: Uint8Array, seed: bigint): bigint {
  let offset = 0
  let h64: bigint
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  if (data.length >= 32) {
    const limit = data.length - 32
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK_64
    let v2 = (seed + PRIME64_2) & MASK_64
    let v3 = seed & MASK_64
    let v4 = (seed - PRIME64_1) & MASK_64

    while (offset <= limit) {
      v1 = xxh64Round(v1, readU64(view, offset))
      offset += 8
      v2 = xxh64Round(v2, readU64(view, offset))
      offset += 8
      v3 = xxh64Round(v3, readU64(view, offset))
      offset += 8
      v4 = xxh64Round(v4, readU64(view, offset))
      offset += 8
    }

    h64 = (
      rotl64(v1, 1n) +
      rotl64(v2, 7n) +
      rotl64(v3, 12n) +
      rotl64(v4, 18n)
    ) & MASK_64
    h64 = xxh64MergeRound(h64, v1)
    h64 = xxh64MergeRound(h64, v2)
    h64 = xxh64MergeRound(h64, v3)
    h64 = xxh64MergeRound(h64, v4)
  } else {
    h64 = (seed + PRIME64_5) & MASK_64
  }

  h64 = (h64 + BigInt(data.length)) & MASK_64

  while (offset + 8 <= data.length) {
    const k1 = xxh64Round(0n, readU64(view, offset))
    h64 ^= k1
    h64 = (rotl64(h64, 27n) * PRIME64_1 + PRIME64_4) & MASK_64
    offset += 8
  }

  if (offset + 4 <= data.length) {
    h64 ^= (BigInt(readU32(view, offset)) * PRIME64_1) & MASK_64
    h64 = (rotl64(h64, 23n) * PRIME64_2 + PRIME64_3) & MASK_64
    offset += 4
  }

  while (offset < data.length) {
    h64 ^= (BigInt(data[offset]!) * PRIME64_5) & MASK_64
    h64 = (rotl64(h64, 11n) * PRIME64_1) & MASK_64
    offset += 1
  }

  h64 ^= h64 >> 33n
  h64 = (h64 * PRIME64_2) & MASK_64
  h64 ^= h64 >> 29n
  h64 = (h64 * PRIME64_3) & MASK_64
  h64 ^= h64 >> 32n
  return h64 & MASK_64
}

function xxh64Round(acc: bigint, input: bigint): bigint {
  return (rotl64((acc + input * PRIME64_2) & MASK_64, 31n) * PRIME64_1) & MASK_64
}

function xxh64MergeRound(acc: bigint, value: bigint): bigint {
  acc ^= xxh64Round(0n, value)
  return (acc * PRIME64_1 + PRIME64_4) & MASK_64
}

function rotl64(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK_64
}

function readU64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true)
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}
