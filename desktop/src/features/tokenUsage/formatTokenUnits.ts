import type { Locale } from '../../i18n'

/**
 * Token amounts grouped by thousands (k, M, B, T). The chat UI's
 * `formatTokenCount` uses the same notation next to CLI output and durations.
 */

type UnitStep = { factor: number; unit: string }

type UnitFamily = {
  steps: UnitStep[]
  /** Ratio at which a unit rolls over into the next (1,000 for k→M). */
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


export type TokenAmount = {
  /** The number part, e.g. "24.1". */
  value: string
  /** The unit part, e.g. "B". Empty below the first unit. */
  unit: string
  /** value + unit as one string, e.g. "24.1B". */
  text: string
}

const GROUPING = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

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

export function formatTokenAmount(amount: number, _locale: Locale): TokenAmount {
  return formatWithFamily(amount, WESTERN)
}

export function formatTokenAmountExact(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '--'
  return GROUPING.format(Math.round(amount))
}

/** Hover text for a number: the exact value behind the abbreviated one. */
export function describeTokenAmount(amount: number, _locale: Locale): { exact: string } {
  return { exact: formatTokenAmountExact(amount) }
}
