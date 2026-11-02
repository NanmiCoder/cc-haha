import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OPENAI_CODEX_CLIENT_VERSION } from './client.js'
import {
  clearOpenAICodexClientVersionCache,
  OPENAI_CODEX_RELEASE_SOURCES,
  resolveOpenAICodexClientVersion,
} from './clientVersion.js'

const [NPM, MIRROR] = OPENAI_CODEX_RELEASE_SOURCES

/** A stable release `minors` minor versions after the pinned one. */
function releaseAfterPinned(minors: number): string {
  const [major, minor] = OPENAI_CODEX_CLIENT_VERSION.split('.').map(Number)
  return `${major}.${minor! + minors}.0`
}

/** Answers each release source from `answers`; a missing source is unreachable. */
function releaseRegistry(answers: Partial<Record<string, string>>) {
  const requested: string[] = []
  const fetchOverride = (async (input) => {
    const source = String(input)
    requested.push(source)
    const version = answers[source]
    if (version === undefined) throw new Error(`${source} is unreachable`)
    return Response.json({ name: '@openai/codex', version })
  }) as typeof fetch
  return { fetchOverride, requested }
}

describe('Codex client version for model listings', () => {
  beforeEach(() => clearOpenAICodexClientVersionCache())
  afterEach(() => clearOpenAICodexClientVersionCache())

  test('reports the highest stable release any source publishes', async () => {
    const { fetchOverride, requested } = releaseRegistry({
      [NPM]: releaseAfterPinned(2),
      [MIRROR]: releaseAfterPinned(1),
    })

    expect(await resolveOpenAICodexClientVersion({ fetchOverride })).toBe(releaseAfterPinned(2))
    expect(requested.sort()).toEqual([...OPENAI_CODEX_RELEASE_SOURCES].sort())
  })

  test('never reports a prerelease or anything below the pinned version', async () => {
    const [major, minor] = OPENAI_CODEX_CLIENT_VERSION.split('.').map(Number)
    const { fetchOverride } = releaseRegistry({
      [NPM]: `${releaseAfterPinned(3)}-alpha.1`,
      [MIRROR]: `${major}.${minor! - 1}.0`,
    })

    expect(await resolveOpenAICodexClientVersion({ fetchOverride })).toBe(OPENAI_CODEX_CLIENT_VERSION)
  })

  test('falls back to the pinned version when no source answers', async () => {
    const { fetchOverride, requested } = releaseRegistry({})

    expect(await resolveOpenAICodexClientVersion({ fetchOverride, forceRefresh: true }))
      .toBe(OPENAI_CODEX_CLIENT_VERSION)
    expect(requested).toHaveLength(OPENAI_CODEX_RELEASE_SOURCES.length)
  })

  test('reuses a lookup in the background and looks again on an explicit refresh', async () => {
    let published = releaseAfterPinned(1)
    let lookups = 0
    const fetchOverride = (async () => {
      lookups += 1
      return Response.json({ version: published })
    }) as typeof fetch

    expect(await resolveOpenAICodexClientVersion({ fetchOverride })).toBe(releaseAfterPinned(1))
    published = releaseAfterPinned(2)
    expect(await resolveOpenAICodexClientVersion({ fetchOverride })).toBe(releaseAfterPinned(1))
    expect(lookups).toBe(OPENAI_CODEX_RELEASE_SOURCES.length)

    expect(await resolveOpenAICodexClientVersion({ fetchOverride, forceRefresh: true }))
      .toBe(releaseAfterPinned(2))
    expect(lookups).toBe(OPENAI_CODEX_RELEASE_SOURCES.length * 2)
  })

  test('keeps the last published release when a later lookup fails', async () => {
    let reachable = true
    const fetchOverride = (async () => {
      if (!reachable) return new Response('unavailable', { status: 503 })
      return Response.json({ version: releaseAfterPinned(3) })
    }) as typeof fetch

    expect(await resolveOpenAICodexClientVersion({ fetchOverride, forceRefresh: true }))
      .toBe(releaseAfterPinned(3))
    reachable = false
    expect(await resolveOpenAICodexClientVersion({ fetchOverride, forceRefresh: true }))
      .toBe(releaseAfterPinned(3))
  })

  test('bounds each lookup and routes it through the configured proxy', async () => {
    const seen: RequestInit[] = []
    const fetchOverride = (async (_input, init) => {
      seen.push(init ?? {})
      return Response.json({ version: OPENAI_CODEX_CLIENT_VERSION })
    }) as typeof fetch

    await resolveOpenAICodexClientVersion({ fetchOverride, proxyUrl: 'http://127.0.0.1:7890' })

    expect(seen).toHaveLength(OPENAI_CODEX_RELEASE_SOURCES.length)
    for (const init of seen) {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect((init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:7890')
    }
  })
})
