import { describe, expect, it } from 'vitest'

import { fuzzyFilter, fuzzyScore } from './fuzzyScore'

describe('fuzzyScore', () => {
  it('returns 0 for an empty/blank query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('   ', 'anything')).toBe(0)
  })

  it('matches subsequences case-insensitively', () => {
    expect(fuzzyScore('mcr', 'MediaCrawler')).toBeGreaterThan(0)
    expect(fuzzyScore('CCH', 'claude-code-haha')).toBeGreaterThan(0)
  })

  it('returns -1 when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'MediaCrawler')).toBe(-1)
    expect(fuzzyScore('hahac', 'cc-haha')).toBe(-1) // 'c' after haha never appears
  })

  it('rewards boundary hits over mid-word scatter', () => {
    const boundary = fuzzyScore('haha', 'cc/haha')
    const midWord = fuzzyScore('haha', 'xhxaxhxa')
    expect(midWord).toBeGreaterThan(0)
    expect(boundary).toBeGreaterThan(midWord)
  })

  it('rewards consecutive runs over scattered matches', () => {
    const consecutive = fuzzyScore('media', 'xmediax')
    const scattered = fuzzyScore('media', 'mxexdxixa')
    expect(scattered).toBeGreaterThan(0)
    expect(consecutive).toBeGreaterThan(scattered)
  })

  it('rewards camelCase humps as boundaries', () => {
    const camel = fuzzyScore('crawler', 'MediaCrawler')
    const plain = fuzzyScore('crawler', 'mediacrawler')
    expect(camel).toBeGreaterThan(plain)
  })
})

describe('fuzzyFilter', () => {
  const projects = [
    { label: 'NanmiCoder/MediaCrawler', path: '/Users/nanmi/workspace/myself_code/MediaCrawler' },
    { label: 'cc-haha', path: '/Users/nanmi/workspace/myself_code/claude-code-haha' },
    { label: '399-Union-Alpha-新模型', path: '/Users/nanmi/个人自媒体/399-Union-Alpha-新模型' },
  ]
  const keys = (p: (typeof projects)[number]) => [p.label, p.path]

  it('returns the input unchanged (same reference order) for an empty query', () => {
    const result = fuzzyFilter(projects, '  ', keys)
    expect(result).toEqual(projects)
  })

  it('excludes non-matching items entirely', () => {
    const result = fuzzyFilter(projects, 'haha', keys)
    expect(result.map((p) => p.label)).toEqual(['cc-haha'])
  })

  it('ranks better matches first while keeping non-matches out', () => {
    const result = fuzzyFilter(projects, 'media', keys)
    expect(result.map((p) => p.label)).toEqual(['NanmiCoder/MediaCrawler'])
  })

  it('matches against any of the provided keys', () => {
    // 'myself_code' only appears in the path, not the label
    const result = fuzzyFilter(projects, 'myself_code', keys)
    expect(result).toHaveLength(2)
    expect(result.map((p) => p.label)).toContain('cc-haha')
  })

  it('keeps original relative order on equal scores', () => {
    const items = [
      { label: 'ab', path: '/x/ab' },
      { label: 'ab', path: '/y/ab' },
    ]
    const result = fuzzyFilter(items, 'ab', keys)
    expect(result[0]?.path).toBe('/x/ab')
    expect(result[1]?.path).toBe('/y/ab')
  })
})
