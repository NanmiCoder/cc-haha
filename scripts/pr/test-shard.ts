/**
 * Splits a long check across parallel CI runners. Shards are 1-based and
 * deterministic, and together cover every item exactly once: sharding is a
 * scheduling decision, never a reason for a test to stop running.
 */
export type TestShard = { index: number; total: number }

const SHARD_ARG = /^--shard=(\d+)\/(\d+)$/

/** Reads `--shard=<index>/<total>`. No flag means the whole check. */
export function parseShardArg(argv: readonly string[]): TestShard | null {
  const args = argv.filter((arg) => arg === '--shard' || arg.startsWith('--shard='))
  if (args.length === 0) return null
  if (args.length > 1) throw new Error(`Expected one --shard flag, got: ${args.join(' ')}`)

  const match = args[0]!.match(SHARD_ARG)
  const index = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || index < 1 || total < 1 || index > total) {
    throw new Error(`Invalid shard "${args[0]}": expected --shard=<index>/<total> with 1 <= index <= total`)
  }
  return { index, total }
}

/** Round-robin over a sorted list, so every shard gets a slice of every directory. */
export function selectShard<T>(items: readonly T[], shard: TestShard | null): T[] {
  if (!shard) return [...items]
  return items.filter((_, position) => position % shard.total === shard.index - 1)
}
