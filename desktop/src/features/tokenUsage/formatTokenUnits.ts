import type { Locale } from '../../i18n'

/**
 * Token amounts in the units each language actually counts in.
 *
 * English groups by thousands (k, M, B, T); Chinese, Japanese and Korean group
 * by ten-thousands (万, 亿, and 万亿 / 兆 / 조 at 10^12). "24.1B" means nothing
 * to a reader who counts in 亿, and "241亿" is what they would say out loud. The
 * chat UI's `formatTokenCount` stays on k / M / B: it sits next to CLI output
 * and durations, where one notation everywhere matters more than the language.
 */

type UnitStep = { factor: number; unit: string }

type UnitFamily = {
  steps: UnitStep[]
  /** Ratio at which a unit rolls over into the next (1,000 for k→M, 10,000 for 万→亿). */
  base: number
}

const WESTERN: UnitFamily = {
  base: 1000,
  steps: [
    { factor: 1e3, unit: 'k' },
    { factor: 1e6, unit: 'M' },
    { factor: 1e9, unit: 'B' },
    { factor: 1e12, unit: 'T' },
  ],
}

const EAST_ASIAN: Record<'zh' | 'zh-TW' | 'jp' | 'kr', UnitFamily> = {
  zh: { base: 10_000, steps: [{ factor: 1e4, unit: '万' }, { factor: 1e8, unit: '亿' }, { factor: 1e12, unit: '万亿' }] },
  'zh-TW': { base: 10_000, steps: [{ factor: 1e4, unit: '萬' }, { factor: 1e8, unit: '億' }, { factor: 1e12, unit: '萬億' }] },
  jp: { base: 10_000, steps: [{ factor: 1e4, unit: '万' }, { factor: 1e8, unit: '億' }, { factor: 1e12, unit: '兆' }] },
  kr: { base: 10_000, steps: [{ factor: 1e4, unit: '만' }, { factor: 1e8, unit: '억' }, { factor: 1e12, unit: '조' }] },
}

export type TokenAmount = {
  /** The number part, e.g. "241" or "24.1". */
  value: string
  /** The unit part, e.g. "亿" or "B". Empty below the first unit. */
  unit: string
  /** value + unit as one string, e.g. "241亿" or "24.1B". */
  text: string
}

const GROUPING = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function familyFor(locale: Locale): UnitFamily {
  return locale === 'en' ? WESTERN : EAST_ASIAN[locale]
}

/** 100 and above read as whole numbers; below, one decimal with a trailing ".0" dropped. */
function roundForDisplay(value: number): number {
  return value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
}

function displayNumber(rounded: number): string {
  return rounded >= 1000 ? GROUPING.format(rounded) : String(rounded)
}

function formatWithFamily(amount: number, family: UnitFamily): TokenAmount {
  if (!Number.isFinite(amount) || amount < 0) return { value: '--', unit: '', text: '--' }
  const first = family.steps[0]!
  if (amount < first.factor) {
    const whole = GROUPING.format(Math.round(amount))
    return { value: whole, unit: '', text: whole }
  }

  let index = family.steps.length - 1
  while (index > 0 && amount < family.steps[index]!.factor) index -= 1

  let rounded = roundForDisplay(amount / family.steps[index]!.factor)
  // 999,950 rounds to "1000k": say "1M" instead of a number that has outgrown its unit.
  const next = family.steps[index + 1]
  if (next && rounded >= family.base) {
    rounded = roundForDisplay(amount / next.factor)
    index += 1
  }

  const unit = family.steps[index]!.unit
  const value = displayNumber(rounded)
  return { value, unit, text: `${value}${unit}` }
}

export function formatTokenAmount(amount: number, locale: Locale): TokenAmount {
  return formatWithFamily(amount, familyFor(locale))
}

export function formatTokenAmountExact(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '--'
  return GROUPING.format(Math.round(amount))
}

/**
 * Hover text for a number: the exact value, plus the same amount in the other
 * family's notation ("24.1B" for a Chinese reader, "241亿" for an English one),
 * so "B = 10 亿" is something the page shows instead of something to remember.
 */
export function describeTokenAmount(amount: number, locale: Locale): { exact: string; alternate: string } {
  const otherFamily = locale === 'en' ? EAST_ASIAN.zh : WESTERN
  return {
    exact: formatTokenAmountExact(amount),
    alternate: formatWithFamily(amount, otherFamily).text,
  }
}
