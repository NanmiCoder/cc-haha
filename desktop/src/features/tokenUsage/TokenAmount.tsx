import type { Locale } from '../../i18n'
import { describeTokenAmount, formatTokenAmount } from './formatTokenUnits'

/** A token count with the exact value one hover away ("24.1B" → "24,100,000,000"). */
export function tokenAmountTitle(amount: number, locale: Locale): string {
  return describeTokenAmount(amount, locale).exact
}

export function TokenAmount({ amount, locale, className }: { amount: number; locale: Locale; className?: string }) {
  return (
    <span className={className} title={tokenAmountTitle(amount, locale)}>
      {formatTokenAmount(amount, locale).text}
    </span>
  )
}
