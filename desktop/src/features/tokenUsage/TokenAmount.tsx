import type { Locale } from '../../i18n'
import { describeTokenAmount, formatTokenAmount } from './formatTokenUnits'

/**
 * A token count in the reader's units, with the exact value and the other
 * notation one hover away ("241亿" → "24,100,000,000 · 24.1B").
 */
export function tokenAmountTitle(amount: number, locale: Locale): string {
  const { exact, alternate } = describeTokenAmount(amount, locale)
  return `${exact} · ${alternate}`
}

export function TokenAmount({ amount, locale, className }: { amount: number; locale: Locale; className?: string }) {
  return (
    <span className={className} title={tokenAmountTitle(amount, locale)}>
      {formatTokenAmount(amount, locale).text}
    </span>
  )
}
