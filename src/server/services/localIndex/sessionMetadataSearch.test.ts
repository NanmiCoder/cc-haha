import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openLocalIndexDatabase, type LocalIndexDatabase } from './database.js'
import { createSessionIndex, type SessionIndex } from './sessionIndex.js'

let directory: string
let database: LocalIndexDatabase
let index: SessionIndex

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'metadata-search-'))
  database = openLocalIndexDatabase({ scope: directory, path: join(directory, 'cc-haha/db/index-v1.sqlite') })
  index = createSessionIndex(database)
})

afterEach(async () => {
  database.close()
  await rm(directory, { recursive: true, force: true })
})

function seed(rows: Array<{ id: string; title: string; modified?: number; workDir?: string }>) {
  database.transaction(op => {
    for (const row of rows) {
      const path = `/fixture/${row.id}.jsonl`
      op.run("INSERT INTO source_files(path,kind,size_bytes,mtime_ms,prefix_hash,parser_version,state,updated_at_ms) VALUES (?,'transcript',0,0,'fixture',1,'ready',0)", path)
      op.run('INSERT INTO sessions(transcript_path,session_id,project_path,title,created_at,modified_at,modified_at_ms,message_count,work_dir) VALUES (?,?,?,?,?,?,?,?,?)',
        path, row.id, 'fixture-project', row.title, '2026-01-01',
        new Date(row.modified ?? 0).toISOString(), row.modified ?? 0, 1, row.workDir ?? '/fixture',
      )
    }
  })
}

test('Chinese exact title and id outrank thousands of recent fuzzy hits before LIMIT', () => {
  seed([
    ...Array.from({ length: 10000 }, (_, i) => ({ id: `recent-${i}`, title: `最近讨论设计文档 ${i}`, modified: i + 100 })),
    { id: 'old-title', title: '设计文档' },
    { id: '设计文档', title: '旧对话' },
  ])
  const started = performance.now()
  const result = index.searchSessionMetadata!('设计文档', { limit: 30 })!
  expect(result.total).toBe(10002)
  expect(result.sessions).toHaveLength(30)
  expect(result.sessions.slice(0, 2).map(row => row.id)).toEqual(['old-title', '设计文档'])
  const second = index.searchSessionMetadata!('设计文档', { limit: 30, offset: 30 })!
  expect(second.sessions.some(row => result.sessions.some(previous => previous.id === row.id))).toBe(false)
  console.info(`[metadata-search benchmark] 10002 rows, two bounded queries: ${(performance.now() - started).toFixed(1)}ms`)
})

test('wildcards are literal, path matches work, and metadata batches stay bounded', () => {
  seed([
    { id: 'literal', title: '100%_done' },
    { id: 'wildcard-lookalike', title: '100XXdone' },
    { id: 'path', title: 'other', workDir: '/项目/中文路径' },
    ...Array.from({ length: 150 }, (_, i) => ({ id: `batch-${i}`, title: 'batch' })),
  ])
  expect(index.searchSessionMetadata!('%_', { limit: 30 })!.sessions.map(row => row.id)).toEqual(['literal'])
  expect(index.searchSessionMetadata!('中文路径')!.sessions.map(row => row.id)).toEqual(['path'])
  expect(index.searchSessionMetadata!('FIXTURE-PROJECT')!.total).toBe(153)
  expect(index.getSessionSuggestionMetadata!(Array.from({ length: 150 }, (_, i) => `batch-${i}`))).toHaveLength(100)
  expect(index.getSessionSuggestionMetadata!([])).toEqual([])
})

test('empty query is recent metadata order even when an old title is empty', () => {
  seed([
    { id: 'old-empty', title: '', modified: 0 },
    { id: 'recent', title: 'recent', modified: 100 },
    { id: 'middle', title: 'middle', modified: 50 },
  ])
  expect(index.searchSessionMetadata!('', { limit: 2 })!.sessions.map(row => row.id)).toEqual(['recent', 'middle'])
})

test('Unicode title and path matches keep exact ranking, totals and deep pagination', () => {
  seed([
    ...Array.from({ length: 320 }, (_, i) => ({ id: `fuzzy-${i}`, title: `Discuss ÉCOLE ${i}`, modified: i + 10 })),
    { id: 'exact', title: 'ÉCOLE', modified: 1 },
    { id: 'path', title: 'unrelated', workDir: '/ÉCOLE' },
  ])
  const first = index.searchSessionMetadata!('école', { limit: 2 })!
  expect(first.total).toBe(322)
  expect(first.sessions.map(row => row.id)).toEqual(['exact', 'fuzzy-319'])
  expect(index.searchSessionMetadata!('ÉCOLE', { offset: 319, limit: 3 })!.sessions.map(row => row.id)).toEqual(['fuzzy-1', 'fuzzy-0', 'path'])
  expect(index.searchSessionMetadata!('école', { offset: 322 })!.sessions).toEqual([])
})

test('ASCII queries also match Unicode capitals that lowercase into ASCII sequences', () => {
  seed([{ id: 'a', title: 'KELVIN' }, { id: 'b', title: 'İSTANBUL' }])
  expect(index.searchSessionMetadata!('kelvin')!.sessions.map(row => row.id)).toEqual(['a'])
  expect(index.searchSessionMetadata!('KELVIN')!.sessions.map(row => row.id)).toEqual(['a'])
  expect(index.searchSessionMetadata!('i\u0307stanbul')!.sessions.map(row => row.id)).toEqual(['b'])
})
