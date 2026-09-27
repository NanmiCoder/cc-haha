import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import type { LocalIndexGateway, SessionEntryLocatorPage } from '../services/localIndex/sessionIndex.js'

function gateway(page: SessionEntryLocatorPage): LocalIndexGateway {
  return {
    async start() {},
    async stop() {},
    getMode: () => 'on',
    getPublicStatus: () => ({
      mode: 'on',
      state: 'ready',
      discovered: 1,
      indexed: 1,
      degradedSources: 0,
      databaseBytes: 1,
      walBytes: 0,
      lastUpdatedAt: '2026-01-01T00:00:00.000Z',
      lastErrorCode: null,
    }),
    isSessionScopeReady: () => true,
    listSessions: () => ({ sessions: [], total: 0 }),
    findSessionFiles: () => [],
    getSession: () => null,
    getSessionEntryLocators: () => page,
    async rebuild() { return this.getPublicStatus() },
  }
}

describe('SearchService session locator seam', () => {
  test('returns project/date candidates only from a complete ready index', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-index-candidates-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    const fileA = path.join(configDir, 'projects', 'project-a', 'session-a.jsonl')
    await fs.mkdir(path.dirname(fileA), { recursive: true })
    await fs.writeFile(fileA, '{}\n')
    const current = new Date('2026-06-01T00:00:00.000Z')
    await fs.utimes(fileA, current, current)
    const page: SessionEntryLocatorPage = {
      source: {
        path: fileA,
        size: 0,
        mtimeMs: 1,
        fileIdentity: null,
        fingerprint: 'fixture',
        indexedBytes: 0,
        parserVersion: 2,
        state: 'ready',
        lastErrorCode: null,
        updatedAtMs: 1,
      },
      entries: [],
    }
    const readyGateway = gateway(page)
    readyGateway.getPublicStatus = () => ({
      mode: 'on',
      state: 'ready',
      discovered: 2,
      indexed: 2,
      degradedSources: 0,
      databaseBytes: 1,
      walBytes: 0,
      lastUpdatedAt: '2026-01-01T00:00:00.000Z',
      lastErrorCode: null,
    })
    readyGateway.listSessions = () => {
      throw new Error('search candidates must not materialize the full session list')
    }
    const receivedFilters: Record<string, unknown>[] = []
    readyGateway.findSearchCandidates = (filters) => {
      receivedFilters.push(filters)
      return [{
        transcriptPath: fileA,
        id: 'session-a',
        title: 'A',
        modifiedAt: '2026-06-01T00:00:00.000Z',
        projectPath: 'project-a',
        workDir: null,
      }]
    }

    try {
      const service = new SessionService(readyGateway)
      expect(await service.getIndexedSessionSearchCandidates({
        modifiedAfter: '2026-01-01T00:00:00.000Z',
      })).toBeNull()
      expect(receivedFilters).toEqual([])

      const candidates = await service.getIndexedSessionSearchCandidates({
        project: 'project-a',
        modifiedAfter: '2026-01-01T00:00:00.000Z',
      })

      expect([...candidates!.keys()]).toEqual([fileA])
      expect(candidates!.get(fileA)?.sourceSnapshot).toMatchObject({
        size: 3,
        mtimeMs: current.getTime(),
      })
      expect(receivedFilters).toEqual([
        { project: 'project-a' },
        {
          project: 'project-a',
          modifiedAfterMs: Date.parse('2026-01-01T00:00:00.000Z'),
        },
      ])

      readyGateway.getPublicStatus = () => ({
        mode: 'on',
        state: 'degraded',
        discovered: 2,
        indexed: 1,
        degradedSources: 1,
        databaseBytes: 1,
        walBytes: 0,
        lastUpdatedAt: '2026-01-01T00:00:01.000Z',
        lastErrorCode: 'LOCAL_INDEX_SOURCE_CHANGED',
      })
      expect(await new SessionService(readyGateway)
        .getIndexedSessionSearchCandidates({ project: 'project-a' })).toBeNull()
    } finally {
      await fs.rm(configDir, { recursive: true, force: true })
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
  })

  test('rejects SQL prefilter candidates when the project directory is ahead of the index', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-index-race-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    const projectDir = path.join(configDir, 'projects', 'project-a')
    const indexedPath = path.join(projectDir, 'indexed.jsonl')
    const latePath = path.join(projectDir, 'late.jsonl')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(indexedPath, '{}\n')
    await fs.writeFile(latePath, '{}\n')
    const current = new Date('2026-06-01T00:00:00.000Z')
    await fs.utimes(indexedPath, current, current)
    await fs.utimes(latePath, current, current)
    const page: SessionEntryLocatorPage = {
      source: {
        path: indexedPath,
        size: 3,
        mtimeMs: current.getTime(),
        fileIdentity: null,
        fingerprint: 'fixture',
        indexedBytes: 3,
        parserVersion: 2,
        state: 'ready',
        lastErrorCode: null,
        updatedAtMs: 1,
      },
      entries: [],
    }
    const staleGateway = gateway(page)
    staleGateway.findSearchCandidates = () => [{
      transcriptPath: indexedPath,
      id: 'indexed',
      title: 'Indexed',
      modifiedAt: current.toISOString(),
      projectPath: 'project-a',
      workDir: null,
    }]

    try {
      const service = new SessionService(staleGateway)
      expect(await service.getIndexedSessionSearchCandidates({
        project: 'project-a',
        modifiedAfter: '2026-01-01T00:00:00.000Z',
      })).toBeNull()
    } finally {
      await fs.rm(configDir, { recursive: true, force: true })
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
  })

  test('rejects project/date SQL candidates when current file mtime crosses the index boundary', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-index-date-race-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    const projectDir = path.join(configDir, 'projects', 'project-a')
    const transcriptPath = path.join(projectDir, 'session-a.jsonl')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, '{}\n')
    const current = new Date('2026-06-01T00:00:00.000Z')
    await fs.utimes(transcriptPath, current, current)
    const page: SessionEntryLocatorPage = {
      source: {
        path: transcriptPath,
        size: 3,
        mtimeMs: current.getTime(),
        fileIdentity: null,
        fingerprint: 'fixture',
        indexedBytes: 3,
        parserVersion: 2,
        state: 'ready',
        lastErrorCode: null,
        updatedAtMs: 1,
      },
      entries: [],
    }
    const staleGateway = gateway(page)
    staleGateway.findSearchCandidates = filters => filters.modifiedAfterMs === undefined
      ? [{
          transcriptPath,
          id: 'session-a',
          title: 'Stale',
          modifiedAt: '2025-01-01T00:00:00.000Z',
          projectPath: 'project-a',
          workDir: null,
        }]
      : []

    try {
      const service = new SessionService(staleGateway)
      expect(await service.getIndexedSessionSearchCandidates({
        project: 'project-a',
        modifiedAfter: '2026-01-01T00:00:00.000Z',
      })).toBeNull()
    } finally {
      await fs.rm(configDir, { recursive: true, force: true })
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
  })

  test('maps physical rg lines to message locators and excludes covered non-message rows', async () => {
    const filePath = path.resolve('/tmp/projects/project-a/session.jsonl')
    const page: SessionEntryLocatorPage = {
      source: {
        path: filePath,
        size: 300,
        mtimeMs: 1,
        fileIdentity: null,
        fingerprint: 'fixture',
        indexedBytes: 300,
        parserVersion: 2,
        state: 'ready',
        lastErrorCode: null,
        updatedAtMs: 1,
      },
      entries: [
        { ordinal: 0, jsonlLine: 1, byteStart: 0, byteLength: 100, entryType: 'user', messageId: 'u1', role: 'user', timestamp: null, parentToolUseId: null },
        { ordinal: 1, jsonlLine: 2, byteStart: 100, byteLength: 100, entryType: 'file-history-snapshot', messageId: null, role: null, timestamp: null, parentToolUseId: null },
        { ordinal: 2, jsonlLine: 3, byteStart: 200, byteLength: 100, entryType: 'assistant', messageId: 'a1', role: 'assistant', timestamp: null, parentToolUseId: null },
      ],
    }
    let selectedLines: number[] = []
    const service = new SessionService(gateway(page), {
      targetedEntryReader: async (options) => {
        selectedLines = options.page.entries.map(locator => locator.jsonlLine)
        return {
          entries: options.page.entries.map(locator => ({
            type: locator.entryType,
            uuid: locator.messageId,
          })),
          bytesRead: 200,
          rangesRead: 2,
        }
      },
    })

    const result = await service.readSessionEntriesAtLines(
      filePath,
      new Set([1, 2, 3]),
      ['user', 'assistant'],
    )

    expect(selectedLines).toEqual([1, 3])
    expect(result).toEqual({
      entries: [
        { entry: { type: 'user', uuid: 'u1' }, lineNumber: 1 },
        { entry: { type: 'assistant', uuid: 'a1' }, lineNumber: 3 },
      ],
      bytesRead: 200,
      rangesRead: 2,
    })
  })

  test('returns null for an uncovered line or failed stale-range verification', async () => {
    const filePath = path.resolve('/tmp/projects/project-a/session.jsonl')
    const page: SessionEntryLocatorPage = {
      source: {
        path: filePath,
        size: 100,
        mtimeMs: 1,
        fileIdentity: null,
        fingerprint: 'fixture',
        indexedBytes: 100,
        parserVersion: 2,
        state: 'pending',
        lastErrorCode: null,
        updatedAtMs: 1,
      },
      entries: [{ ordinal: 0, jsonlLine: 1, byteStart: 0, byteLength: 100, entryType: 'user', messageId: 'u1', role: 'user', timestamp: null, parentToolUseId: null }],
    }
    const service = new SessionService(gateway(page), {
      targetedEntryReader: async () => null,
    })

    expect(await service.readSessionEntriesAtLines(filePath, new Set([2]), ['user'])).toBeNull()
    expect(await service.readSessionEntriesAtLines(filePath, new Set([1]), ['user'])).toBeNull()
  })
})
