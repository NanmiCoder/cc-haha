import { describe, expect, test } from 'bun:test'
import { parseShardArg, selectShard } from './test-shard'

describe('test shards', () => {
  test('runs the whole check when no shard is requested', () => {
    expect(parseShardArg([])).toBeNull()
    expect(parseShardArg(['--other'])).toBeNull()
    expect(selectShard(['a', 'b'], null)).toEqual(['a', 'b'])
  })

  test('reads a 1-based shard', () => {
    expect(parseShardArg(['--shard=2/3'])).toEqual({ index: 2, total: 3 })
    expect(parseShardArg(['--shard=1/1'])).toEqual({ index: 1, total: 1 })
  })

  test.each([
    ['--shard'],
    ['--shard='],
    ['--shard=0/3'],
    ['--shard=4/3'],
    ['--shard=1/0'],
    ['--shard=1-3'],
    ['--shard=a/3'],
  ])('fails closed on a malformed shard instead of running nothing: %s', (arg) => {
    expect(() => parseShardArg([arg])).toThrow()
  })

  test('refuses two shard flags rather than picking one', () => {
    expect(() => parseShardArg(['--shard=1/3', '--shard=2/3'])).toThrow()
  })

  test.each([1, 2, 3, 5, 9])('%i shards cover every file exactly once', (total) => {
    const files = Array.from({ length: 23 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.test.ts`)
    const shards = Array.from({ length: total }, (_, index) => selectShard(files, { index: index + 1, total }))
    const seen = shards.flat()

    expect(seen.length).toBe(files.length)
    expect(new Set(seen)).toEqual(new Set(files))
    // Round-robin keeps shard sizes within one file of each other.
    const sizes = shards.map((shard) => shard.length)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
  })

  test('gives the same files to the same shard on every run', () => {
    const files = ['a', 'b', 'c', 'd', 'e']
    expect(selectShard(files, { index: 2, total: 2 })).toEqual(['b', 'd'])
    expect(selectShard(files, { index: 2, total: 2 })).toEqual(['b', 'd'])
  })
})
