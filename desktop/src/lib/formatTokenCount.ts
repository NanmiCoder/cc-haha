/**
 * Compact token-count formatter shared by the chat UI (session header,
 * streaming indicator, compact summary, background agents) and trace views,
 * so every surface renders token usage with one notation.
 * "847" below 1000, "1.2k" up to 1M, "1.2m" beyond — trailing ".0" dropped
 * ("1k", not "1.0k") to match the CLI's formatTokens.
 */
export function formatTokenCount(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '--'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}
