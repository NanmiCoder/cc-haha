#!/usr/bin/env bun

import { join } from 'node:path'
import { parseShardArg, type TestShard } from './test-shard'

/**
 * `check:desktop` is lint, the Vitest suite, and the production build, in that
 * order. With --shard=<index>/<total> the first shard also lints, the last also
 * builds, and Vitest splits its files across all of them, so the shards together
 * run exactly what one unsharded run does.
 */
export function desktopCheckSteps(shard: TestShard | null): string[][] {
  const steps: string[][] = []
  if (!shard || shard.index === 1) steps.push(['bun', 'run', 'lint'])
  steps.push(['bun', 'run', 'test', '--', '--run', ...(shard ? [`--shard=${shard.index}/${shard.total}`] : [])])
  if (!shard || shard.index === shard.total) steps.push(['bun', 'run', 'build'])
  return steps
}

if (import.meta.main) {
  const desktopDir = join(import.meta.dir, '..', '..', 'desktop')
  for (const command of desktopCheckSteps(parseShardArg(process.argv.slice(2)))) {
    console.log(`$ ${command.join(' ')}`)
    const proc = Bun.spawn(command, { cwd: desktopDir, stdio: ['inherit', 'inherit', 'inherit'] })
    const exitCode = await proc.exited
    if (exitCode !== 0) process.exit(exitCode)
  }
}
