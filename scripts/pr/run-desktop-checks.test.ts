import { describe, expect, test } from 'bun:test'
import { desktopCheckSteps } from './run-desktop-checks'

const LINT = 'bun run lint'
const BUILD = 'bun run build'

function commands(index: number | null, total = 1) {
  return desktopCheckSteps(index === null ? null : { index, total }).map((step) => step.join(' '))
}

describe('desktop checks', () => {
  test('runs lint, the whole Vitest suite, then the build when not sharded', () => {
    expect(commands(null)).toEqual([LINT, 'bun run test -- --run', BUILD])
  })

  test.each([1, 2, 3])('%i shards together lint once, build once, and split every Vitest file', (total) => {
    const shards = Array.from({ length: total }, (_, index) => commands(index + 1, total))
    const all = shards.flat()

    expect(all.filter((command) => command === LINT)).toHaveLength(1)
    expect(all.filter((command) => command === BUILD)).toHaveLength(1)
    expect(shards[0]![0]).toBe(LINT)
    expect(shards.at(-1)!.at(-1)).toBe(BUILD)
    expect(all.filter((command) => command.startsWith('bun run test'))).toEqual(
      Array.from({ length: total }, (_, index) => `bun run test -- --run --shard=${index + 1}/${total}`),
    )
  })
})
