import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSearchContentDatabase } from './searchContentDatabase.js'
import {
  createSearchContentIndex,
  normalizeSearchContent,
  type SearchContentSourceWrite,
} from './searchContentIndex.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-index-'))
  tempDirs.push(root)
  const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
  const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
  return { database, index }
}

function source(overrides: Partial<SearchContentSourceWrite> = {}): SearchContentSourceWrite {
  return {
    path: '/projects/-repo/session.jsonl',
    projectPath: '-repo',
    ownerSessionId: 'session',
    ownerTranscriptPath: '/projects/-repo/session.jsonl',
    modifiedAtMs: 200,
    sizeBytes: 300,
    mtimeMs: 200,
    fileIdentity: '1:2',
    fingerprint: 'fingerprint',
    indexedBytes: 300,
    indexedLines: 3,
    parserVersion: 1,
    state: 'ready',
    lastErrorCode: null,
    updatedAtMs: 200,
    ...overrides,
  }
}

describe('search content index', () => {
  it('returns null until the global projection is completely ready', async () => {
    const { database, index } = await setup()
    try {
      index.replaceSource(source(), [{
        jsonlLine: 1,
        byteStart: 0,
        byteLength: 100,
        segmentIndex: 0,
        role: 'user',
        messageId: 'u1',
        timestamp: null,
        body: '全文搜索 ready needle',
        normalizedBody: normalizeSearchContent('全文搜索 ready needle'),
      }])
      expect(index.query('needle')).toBeNull()

      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('needle')?.sessions).toHaveLength(1)

      index.setReadiness({
        state: 'degraded',
        discovered: 1,
        indexed: 0,
        degraded: 1,
        lastErrorCode: 'WATCHER_UNHEALTHY',
      })
      expect(index.query('needle')).toBeNull()
    } finally {
      database.close()
    }
  })

  it('throws runtime database failures so the coordinator can degrade explicitly', async () => {
    const { database, index } = await setup()
    index.setReadiness({ state: 'ready', discovered: 0, indexed: 0 })
    database.close()

    expect(() => index.query('needle')).toThrow('closed')
  })

  it('uses trigram for long queries, instr for short Chinese queries, and preserves original body', async () => {
    const { database, index } = await setup()
    try {
      index.replaceSource(source(), [
        {
          jsonlLine: 1,
          byteStart: 0,
          byteLength: 100,
          segmentIndex: 0,
          role: 'user',
          messageId: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          body: '请检查 SQLite 全文搜索',
          normalizedBody: normalizeSearchContent('请检查 SQLite 全文搜索'),
        },
        {
          jsonlLine: 2,
          byteStart: 100,
          byteLength: 100,
          segmentIndex: 0,
          role: 'assistant',
          messageId: 'a1',
          timestamp: null,
          body: 'literal .* [needle] and A"B marker',
          normalizedBody: normalizeSearchContent('literal .* [needle] and A"B marker'),
        },
      ])
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })

      expect(index.query('SQLite')?.sessions[0]?.matches[0]).toMatchObject({
        sourcePath: source().path,
        ownerSessionId: 'session',
        ownerTranscriptPath: source().ownerTranscriptPath,
        projectPath: '-repo',
        lineNumber: 1,
        role: 'user',
        messageId: 'u1',
        body: '请检查 SQLite 全文搜索',
        byteStart: 0,
        byteLength: 100,
        sourceSizeBytes: 300,
        sourceMtimeMs: 200,
        sourceFileIdentity: '1:2',
        sourceFingerprint: 'fingerprint',
        sourceIndexedBytes: 300,
        sourceParserVersion: 1,
      })
      expect(index.query('搜索')?.sessions[0]?.matches[0].lineNumber).toBe(1)
      expect(index.query('sqlite')?.sessions).toHaveLength(1)
      expect(index.query('sqlite', { caseSensitive: true })?.sessions).toEqual([])
      expect(index.query('SQLite', { caseSensitive: true })?.sessions).toHaveLength(1)
      expect(index.query('.* [needle]')?.sessions[0]?.matches[0].lineNumber).toBe(2)
      expect(index.query('A"B')?.sessions[0]?.matches[0].lineNumber).toBe(2)
      expect(index.query('missing')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })

  it('throws an FTS runtime failure instead of disguising it as not ready', async () => {
    const { database, index } = await setup()
    try {
      index.setReadiness({ state: 'ready', discovered: 0, indexed: 0 })
      database.write(writer => writer.exec('DROP TABLE search_documents_fts'))

      expect(() => index.query('long needle')).toThrow()
    } finally {
      database.close()
    }
  })

  it('filters and limits owners in SQL while returning bounded matches and counts', async () => {
    const { database, index } = await setup()
    try {
      for (let owner = 0; owner < 3; owner += 1) {
        const path = `/projects/-repo/session-${owner}.jsonl`
        index.replaceSource(source({
          path,
          ownerSessionId: `session-${owner}`,
          ownerTranscriptPath: path,
          modifiedAtMs: 100 + owner,
          mtimeMs: 100 + owner,
        }), Array.from({ length: 4 }, (_, line) => ({
          jsonlLine: line + 1,
          byteStart: line * 100,
          byteLength: 100,
          segmentIndex: 0,
          role: 'user' as const,
          messageId: null,
          timestamp: null,
          body: `shared needle owner ${owner} line ${line}`,
          normalizedBody: `shared needle owner ${owner} line ${line}`,
        })))
      }
      index.setReadiness({ state: 'ready', discovered: 3, indexed: 3 })

      expect(index.countSources()).toBe(3)
      expect(index.listSources().map(source => source.ownerSessionId)).toEqual([
        'session-0',
        'session-1',
        'session-2',
      ])

      const result = index.query('needle', {
        project: '-repo',
        modifiedAfterMs: 100,
        modifiedBeforeMs: 102,
        limit: 2,
        matchesPerSession: 2,
      })
      expect(result).not.toBeNull()
      expect(result?.truncated).toBe(true)
      expect(result?.sessions.map(session => session.ownerSessionId)).toEqual([
        'session-2',
        'session-1',
      ])
      expect(result?.sessions[0]).toMatchObject({ matchCount: 4 })
      expect(result?.sessions[0]?.matches).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it('rolls back source replacement if any document violates the schema', async () => {
    const { database, index } = await setup()
    try {
      index.replaceSource(source(), [{
        jsonlLine: 1,
        byteStart: 0,
        byteLength: 10,
        segmentIndex: 0,
        role: 'user',
        messageId: null,
        timestamp: null,
        body: 'old searchable body',
        normalizedBody: 'old searchable body',
      }])
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })

      expect(() => index.replaceSource(source(), [{
        jsonlLine: 2,
        byteStart: 10,
        byteLength: 10,
        segmentIndex: 0,
        role: 'invalid' as 'user',
        messageId: null,
        timestamp: null,
        body: 'new body',
        normalizedBody: 'new body',
      }])).toThrow()
      expect(index.query('old searchable')?.sessions).toHaveLength(1)
      expect(index.query('new body')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })
})

it('bounds Chinese broad-match suggestions to distinct owners without materializing transcript bodies', async () => {
  const { database, index } = await setup()
  try {
    const body = '修复中文协作问题 '.repeat(160)
    for (let owner = 0; owner < 120; owner++) {
      index.replaceSource(source({ path: `/fixture/${owner}.jsonl`, ownerSessionId: `owner-${owner}`,
        ownerTranscriptPath: `/fixture/${owner}.jsonl`, modifiedAtMs: owner }),
      Array.from({ length: 100 }, (_, line) => ({ jsonlLine: line + 1, byteStart: line * 100,
        byteLength: 100, segmentIndex: 0, role: 'user' as const, messageId: null,
        timestamp: null, body, normalizedBody: normalizeSearchContent(body) })))
    }
    index.replaceSource(source({ path: '/fixture/subagent.jsonl', ownerSessionId: 'owner-119',
      ownerTranscriptPath: '/fixture/119.jsonl', modifiedAtMs: 119 }), [{ jsonlLine: 1,
      byteStart: 0, byteLength: 100, segmentIndex: 0, role: 'assistant', messageId: null,
      timestamp: null, body, normalizedBody: normalizeSearchContent(body) }])
    expect(index.querySessionSuggestions('修复', 20)).toBeNull()
    index.setReadiness({ state: 'ready', discovered: 121, indexed: 121 })
    const start = performance.now()
    const result = index.querySessionSuggestions('修复', 20)!
    const elapsed = performance.now() - start
    console.log(`[suggestion benchmark] 12001 matching Chinese documents: ${elapsed.toFixed(1)}ms, ${JSON.stringify(result).length} response chars`)
    expect(result.sessions).toHaveLength(20)
    expect(result.truncated).toBe(true)
    expect(new Set(result.sessions.map(row => row.ownerSessionId)).size).toBe(20)
    expect(result.sessions[0]?.ownerSessionId).toBe('owner-119')
    expect(JSON.stringify(result)).not.toContain('修复')
    expect(elapsed).toBeLessThan(1000)
    expect(index.querySessionSuggestions('中文协作', 5)?.sessions).toHaveLength(5)
    expect(index.querySessionSuggestions('不存在', 5)?.sessions).toHaveLength(0)
  } finally { database.close() }
})

it('scans global FTS once for common and rare long queries across a thousand sources', async () => {
  const { database, index } = await setup()
  try {
    for (let owner = 0; owner < 1000; owner++) {
      const body = '修复一下这些中文协作问题 '.repeat(80) + (owner === 999 ? '稀有字符串专用' : '')
      index.replaceSource(source({ path: `/fixture/${owner}.jsonl`, ownerSessionId: `owner-${owner}`,
        ownerTranscriptPath: `/fixture/${owner}.jsonl`, modifiedAtMs: owner }),
      Array.from({ length: 10 }, (_, line) => ({ jsonlLine: line + 1, byteStart: line * 100,
        byteLength: 100, segmentIndex: 0, role: 'user' as const, messageId: null,
        timestamp: null, body, normalizedBody: normalizeSearchContent(body) })))
    }
    index.setReadiness({ state: 'ready', discovered: 1000, indexed: 1000 })
    const plans: string[][] = []
    const inspected = createSearchContentIndex({ ...database,
      read: operation => database.read(reader => operation({ ...reader,
        all: (sql, ...bindings) => {
          if (sql.includes('search_documents_fts MATCH')) {
            plans.push(reader.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...bindings).map(row => row.detail))
          }
          return reader.all(sql, ...bindings)
        },
      })),
    }, { scope: index.getReadiness()!.scope })
    for (const [query, count] of [['修复一下', 60], ['稀有字符串专用', 1]] as const) {
      const start = performance.now()
      const result = inspected.querySessionSuggestions(query, 60)!
      console.log(`[FTS suggestion benchmark] 1000 sources / 10000 documents, ${query}: ${(performance.now() - start).toFixed(1)}ms`)
      expect(result.sessions).toHaveLength(count)
      expect(result.sessions[0]?.ownerSessionId).toBe('owner-999')
      expect(result.truncated).toBe(count === 60)
      expect(new Set(result.sessions.map(item => item.ownerSessionId)).size).toBe(count)
    }
    expect(plans).toHaveLength(2)
    for (const plan of plans) {
      expect(plan.some(step => step.includes('CORRELATED'))).toBe(false)
      expect(plan.filter(step => step.includes('search_documents_fts'))).toHaveLength(1)
    }
  } finally { database.close() }
})
