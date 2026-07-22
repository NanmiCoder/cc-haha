/**
 * Unit tests for SearchService.searchSessions — global session full-text search.
 *
 * Builds throwaway ~/.claude/projects/<dir>/<uuid>.jsonl fixtures under a temp
 * CLAUDE_CONFIG_DIR and exercises the two-phase (ripgrep → parse/clean) engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SearchService } from '../services/searchService.js'
import { SessionService } from '../services/sessionService.js'
import type { LocalIndexGateway } from '../services/localIndex/sessionIndex.js'

let tmpDir: string
let service: SearchService

async function setupTmpConfigDir(): Promise<void> {
  tmpDir = path.join(
    os.tmpdir(),
    `cc-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

/** Write a JSONL session file. Entries may be objects (serialized) or raw strings (for malformed-line tests). */
async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Array<Record<string, unknown> | string>,
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content =
    entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

beforeEach(async () => {
  await setupTmpConfigDir()
  service = new SearchService()
})

afterEach(cleanupTmpDir)

describe('SearchService.searchSessions', () => {
  it('uses a JSON-escaped fixed-string path scan before bounded line-number extraction', async () => {
    const query = '他说 "SQLite\\路径"\n搜索'
    const entry = {
      type: 'user',
      uuid: 'escaped',
      message: { role: 'user', content: query },
    }
    const filePath = await writeSessionFile('proj-a', 'escaped-session', [entry])
    const expectedLiteral = JSON.stringify(query).slice(1, -1)
    const phaseAArgs: string[][] = []
    const phaseBArgs: string[][] = []
    const escapedService = new SearchService({
      readEntriesAtLines: async (_requestedPath, lineNumbers) => ({
        entries: [...lineNumbers].map(lineNumber => ({ entry, lineNumber })),
        bytesRead: Buffer.byteLength(JSON.stringify(entry)) + 1,
        rangesRead: 1,
      }),
    } as never)
    ;(escapedService as unknown as { commandExists: () => Promise<boolean> }).commandExists =
      async () => true
    ;(escapedService as unknown as {
      runCommand: (
        command: string,
        args: string[],
        signal?: AbortSignal,
        onRecord?: (record: string) => void,
      ) => Promise<string>
    }).runCommand = async (_command, args) => {
      phaseAArgs.push(args)
      return `${filePath}\n`
    }
    ;(escapedService as unknown as {
      runCommandRecords: (
        command: string,
        args: string[],
        signal: AbortSignal | undefined,
        onRecord: (record: string) => void,
      ) => Promise<void>
    }).runCommandRecords = async (_command, args, _signal, onRecord) => {
      phaseBArgs.push(args)
      onRecord(`${filePath}:1:`)
    }

    const { results } = await escapedService.searchSessions(query)

    expect(results.map(result => result.sessionId)).toEqual(['escaped-session'])
    expect(phaseAArgs).toHaveLength(1)
    expect(phaseAArgs[0]).toContain('-l')
    expect(phaseAArgs[0]).toContain('--fixed-strings')
    expect(phaseAArgs[0]).toContain('--ignore-case')
    expect(phaseAArgs[0]).not.toContain('--json')
    expect(phaseAArgs[0]).toContain(expectedLiteral)
    expect(phaseBArgs).toHaveLength(1)
    expect(phaseBArgs[0]).toContain('--only-matching')
    expect(phaseBArgs[0]).toContain('--replace')
    expect(phaseBArgs[0]).toContain('')
    expect(phaseBArgs[0]).not.toContain('--json')
  })

  it('caps and ranks candidate paths before asking ripgrep for matched line numbers', async () => {
    const entries = new Map<string, Record<string, unknown>>()
    const metadata = new Map<string, {
      title: string
      projectPath: string
      workDir: null
      modifiedAt: string
    }>()
    const paths: string[] = []
    for (let index = 0; index < 61; index += 1) {
      const entry = {
        type: 'user',
        uuid: `ranked-${index}`,
        message: { role: 'user', content: `rankcapneedle ${index}` },
      }
      const filePath = await writeSessionFile('proj-a', `ranked-${index}`, [entry])
      const modifiedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index))
      await fs.utimes(filePath, modifiedAt, modifiedAt)
      entries.set(path.resolve(filePath), entry)
      metadata.set(path.resolve(filePath), {
        title: path.basename(filePath, '.jsonl'),
        projectPath: 'proj-a',
        workDir: null,
        modifiedAt: modifiedAt.toISOString(),
      })
      paths.push(filePath)
    }
    const lineScanPaths: string[] = []
    const rankedService = new SearchService({
      getMetadataForPaths: async filePaths => new Map(filePaths.map(filePath => [
        path.resolve(filePath),
        metadata.get(path.resolve(filePath))!,
      ])),
      readEntriesAtLines: async (filePath, lineNumbers) => ({
        entries: [...lineNumbers].map(lineNumber => ({
          entry: entries.get(path.resolve(filePath))!,
          lineNumber,
        })),
        bytesRead: 100,
        rangesRead: 1,
      }),
    } as never)
    ;(rankedService as unknown as { commandExists: () => Promise<boolean> }).commandExists =
      async () => true
    ;(rankedService as unknown as {
      runCommand: (command: string, args: string[]) => Promise<string>
    }).runCommand = async () => `${paths.join('\n')}\n`
    ;(rankedService as unknown as {
      runCommandRecords: (
        command: string,
        args: string[],
        signal: AbortSignal | undefined,
        onRecord: (record: string) => void,
      ) => Promise<void>
    }).runCommandRecords = async (_command, args, _signal, onRecord) => {
      const separator = args.indexOf('--')
      for (const filePath of args.slice(separator + 2)) {
        lineScanPaths.push(filePath)
        onRecord(`${filePath}:1:`)
      }
    }

    const output = await rankedService.searchSessions('rankcapneedle', { limit: 100 })

    expect(output.truncated).toBe(true)
    expect(lineScanPaths).toHaveLength(60)
    expect(lineScanPaths).not.toContain(paths[0])
    expect(output.results).toHaveLength(60)
  })

  it('kills a streamed phase-B command when its AbortSignal is cancelled', async () => {
    const controller = new AbortController()
    const pending = (service as unknown as {
      runCommandRecords: (
        command: string,
        args: string[],
        signal: AbortSignal,
        onRecord: (record: string) => void,
      ) => Promise<void>
    }).runCommandRecords(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      controller.signal,
      () => {},
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an oversized streamed search record instead of buffering it', async () => {
    const pending = (service as unknown as {
      runCommandRecords: (
        command: string,
        args: string[],
        signal: AbortSignal | undefined,
        onRecord: (record: string) => void,
      ) => Promise<void>
    }).runCommandRecords(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(70 * 1024) + '\\n')"],
      undefined,
      () => {},
    )

    await expect(pending).rejects.toThrow('oversized search record')
  })

  it('routes phase-B physical rg lines through a bounded entry reader and records candidate bytes', async () => {
    const entries = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'boundedneedle result' } },
    ]
    const filePath = await writeSessionFile('proj-a', 'bounded-session', [
      { type: 'tool_result', content: 'x'.repeat(1024 * 1024) },
      ...entries,
    ])
    const targetedRead = async (requestedPath: string, lineNumbers: Set<number>) => ({
      entries: entries.map((entry) => ({ entry, lineNumber: 2 })),
      bytesRead: Buffer.byteLength(JSON.stringify(entries[0])) + 1,
      rangesRead: 1,
    })
    const targetedService = new SearchService({
      readEntriesAtLines: targetedRead,
    } as never)
    const metrics = {
      candidateFiles: 0,
      filesOpened: 0,
      bytesRead: 0,
      fallbackFiles: 0,
    }

    const result = await targetedService.searchSessions('boundedneedle', { metrics } as never)

    expect(result.results.map((item) => item.sessionId)).toEqual(['bounded-session'])
    expect(metrics).toEqual({
      candidateFiles: 1,
      filesOpened: 1,
      bytesRead: Buffer.byteLength(JSON.stringify(entries[0])) + 1,
      fallbackFiles: 0,
    })
    expect(metrics.bytesRead).toBeLessThan((await fs.stat(filePath)).size / 100)
  })

  it('passes ready-index project/date candidates to rg before content scanning', async () => {
    const included = await writeSessionFile('proj-a', 'included-session', [{
      type: 'user',
      uuid: 'included',
      message: { role: 'user', content: 'prefilterneedle included' },
    }])
    const excluded = await writeSessionFile('proj-a', 'excluded-session', [{
      type: 'user',
      uuid: 'excluded',
      message: { role: 'user', content: 'prefilterneedle excluded' },
    }])
    const metadata = new Map([[path.resolve(included), {
      title: 'Included',
      modifiedAt: '2026-06-01T00:00:00.000Z',
      workDir: null,
      projectPath: 'proj-a',
    }]])
    const indexed = new SearchService({
      getCandidatesForFilters: async () => metadata,
    } as never)
    ;(indexed as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(indexed as unknown as {
      runCommand: (command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      expect(args).toContain(included)
      expect(args).not.toContain(excluded)
      expect(args).not.toContain(path.dirname(included))
      return JSON.stringify({
        type: 'match',
        data: { path: { text: included }, line_number: 1 },
      })
    }

    const { results } = await indexed.searchSessions('prefilterneedle', {
      project: 'proj-a',
      modifiedAfter: '2026-01-01T00:00:00.000Z',
    })

    expect(results.map(result => result.sessionId)).toEqual(['included-session'])
  })

  it('uses current filesystem metadata for date filtering and canonical fallback metadata', async () => {
    const filePath = await writeSessionFile('proj-a', 'current-session', [{
      type: 'user',
      uuid: 'current',
      message: { role: 'user', content: 'currentmetadataneedle' },
    }])
    const current = new Date('2026-06-01T00:00:00.000Z')
    await fs.utimes(filePath, current, current)
    const staleMetadata = new Map([[path.resolve(filePath), {
      title: 'Stale indexed title',
      modifiedAt: '2025-01-01T00:00:00.000Z',
      workDir: '/stale/indexed/workdir',
      projectPath: 'proj-a',
    }]])
    const stale = new SearchService({
      readEntriesAtLines: async () => null,
      getCandidatesForFilters: async () => null,
      getMetadataForPaths: async () => staleMetadata,
    })
    ;(stale as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => false

    const { results } = await stale.searchSessions('currentmetadataneedle', {
      modifiedAfter: '2026-01-01T00:00:00.000Z',
    })

    expect(results.map(result => result.sessionId)).toEqual(['current-session'])
    expect(results[0]?.title).not.toBe('Stale indexed title')
    expect(results[0]?.workDir).not.toBe('/stale/indexed/workdir')
  })

  it('rejects project names that are not direct children of the projects root', async () => {
    for (const project of ['.', '..', 'nested/project', 'nested\\project']) {
      await expect(service.searchSessions('needle', { project })).rejects.toThrow(
        'Invalid project filter',
      )
    }
  })

  it('abandons exact indexed candidates when the project directory changes during phase A', async () => {
    const included = await writeSessionFile('proj-a', 'included-session', [{
      type: 'user',
      uuid: 'included',
      message: { role: 'user', content: 'directoryraceneedle included' },
    }])
    const metadata = new Map([[path.resolve(included), {
      title: 'Included',
      modifiedAt: '2026-06-01T00:00:00.000Z',
      workDir: null,
      projectPath: 'proj-a',
    }]])
    const indexed = new SearchService({
      getCandidatesForFilters: async () => metadata,
      getMetadataForPaths: async () => null,
    })
    let calls = 0
    ;(indexed as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(indexed as unknown as {
      runCommand: (_command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      calls += 1
      if (calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
        await writeSessionFile('proj-a', 'late-session', [{
          type: 'user',
          uuid: 'late',
          message: { role: 'user', content: 'directoryraceneedle late' },
        }])
        return JSON.stringify({
          type: 'match',
          data: { path: { text: included }, line_number: 1 },
        })
      }
      const projectRoot = path.dirname(included)
      expect(args.at(-1)).toBe(projectRoot)
      return [included, path.join(projectRoot, 'late-session.jsonl')]
        .map(filePath => JSON.stringify({
          type: 'match',
          data: { path: { text: filePath }, line_number: 1 },
        }))
        .join('\n')
    }

    const { results } = await indexed.searchSessions('directoryraceneedle', {
      project: 'proj-a',
    })

    expect(calls).toBe(2)
    expect(results.map(result => result.sessionId).sort()).toEqual([
      'included-session',
      'late-session',
    ])
  })

  it('abandons exact indexed candidates when an existing file enters the date range during phase A', async () => {
    const included = await writeSessionFile('proj-a', 'included-session', [{
      type: 'user',
      uuid: 'included',
      message: { role: 'user', content: 'mtimeenterraceneedle included' },
    }])
    const excluded = await writeSessionFile('proj-a', 'excluded-session', [{
      type: 'user',
      uuid: 'excluded',
      message: { role: 'user', content: 'mtimeenterraceneedle excluded' },
    }])
    const inRange = new Date('2026-06-01T00:00:00.000Z')
    const outOfRange = new Date('2025-06-01T00:00:00.000Z')
    await fs.utimes(included, inRange, inRange)
    await fs.utimes(excluded, outOfRange, outOfRange)
    const directoryBefore = await fs.stat(path.dirname(included))
    const metadataFor = (title: string) => ({
      title,
      modifiedAt: inRange.toISOString(),
      workDir: null,
      projectPath: 'proj-a',
    })
    let filterCalls = 0
    const indexed = new SearchService({
      getCandidatesForFilters: async () => {
        filterCalls += 1
        return filterCalls === 1
          ? new Map([[path.resolve(included), metadataFor('Included')]])
          : new Map([
              [path.resolve(included), metadataFor('Included')],
              [path.resolve(excluded), metadataFor('Excluded')],
            ])
      },
      getMetadataForPaths: async () => null,
    })
    let rgCalls = 0
    ;(indexed as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(indexed as unknown as {
      runCommand: (_command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      rgCalls += 1
      if (rgCalls === 1) {
        expect(args).toContain(included)
        expect(args).not.toContain(excluded)
        await fs.utimes(excluded, inRange, inRange)
        return JSON.stringify({
          type: 'match',
          data: { path: { text: included }, line_number: 1 },
        })
      }
      expect(args.at(-1)).toBe(path.dirname(included))
      return [included, excluded].map(filePath => JSON.stringify({
        type: 'match',
        data: { path: { text: filePath }, line_number: 1 },
      })).join('\n')
    }

    const { results } = await indexed.searchSessions('mtimeenterraceneedle', {
      project: 'proj-a',
      modifiedAfter: '2026-01-01T00:00:00.000Z',
    })
    const directoryAfter = await fs.stat(path.dirname(included))

    expect(directoryAfter.mtimeMs).toBe(directoryBefore.mtimeMs)
    expect(directoryAfter.ctimeMs).toBe(directoryBefore.ctimeMs)
    expect(filterCalls).toBe(2)
    expect(rgCalls).toBe(2)
    expect(results.map(result => result.sessionId).sort()).toEqual([
      'excluded-session',
      'included-session',
    ])
  })

  it('abandons exact indexed candidates when an existing file leaves the date range during phase A', async () => {
    const included = await writeSessionFile('proj-a', 'included-session', [{
      type: 'user',
      uuid: 'included',
      message: { role: 'user', content: 'mtimeleaveraceneedle included' },
    }])
    const leaving = await writeSessionFile('proj-a', 'leaving-session', [{
      type: 'user',
      uuid: 'leaving',
      message: { role: 'user', content: 'mtimeleaveraceneedle leaving' },
    }])
    const inRange = new Date('2026-06-01T00:00:00.000Z')
    const outOfRange = new Date('2025-06-01T00:00:00.000Z')
    await fs.utimes(included, inRange, inRange)
    await fs.utimes(leaving, inRange, inRange)
    const metadata = (filePath: string) => ({
      title: path.basename(filePath),
      modifiedAt: inRange.toISOString(),
      workDir: null,
      projectPath: 'proj-a',
    })
    let filterCalls = 0
    const indexed = new SearchService({
      getCandidatesForFilters: async () => {
        filterCalls += 1
        return filterCalls === 1
          ? new Map([
              [path.resolve(included), metadata(included)],
              [path.resolve(leaving), metadata(leaving)],
            ])
          : new Map([[path.resolve(included), metadata(included)]])
      },
      getMetadataForPaths: async () => null,
    })
    let rgCalls = 0
    ;(indexed as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(indexed as unknown as {
      runCommand: (_command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      rgCalls += 1
      if (rgCalls === 1) await fs.utimes(leaving, outOfRange, outOfRange)
      return [included, leaving]
        .filter(filePath => args.includes(filePath) || args.at(-1) === path.dirname(included))
        .map(filePath => JSON.stringify({
          type: 'match',
          data: { path: { text: filePath }, line_number: 1 },
        }))
        .join('\n')
    }

    const { results } = await indexed.searchSessions('mtimeleaveraceneedle', {
      project: 'proj-a',
      modifiedAfter: '2026-01-01T00:00:00.000Z',
    })

    expect(filterCalls).toBe(2)
    expect(rgCalls).toBe(2)
    expect(results.map(result => result.sessionId)).toEqual(['included-session'])
  })

  it('revalidates an empty indexed date candidate set before returning no results', async () => {
    const entering = await writeSessionFile('proj-a', 'entering-session', [{
      type: 'user',
      uuid: 'entering',
      message: { role: 'user', content: 'emptysetraceneedle entering' },
    }])
    const inRange = new Date('2026-06-01T00:00:00.000Z')
    const outOfRange = new Date('2025-06-01T00:00:00.000Z')
    await fs.utimes(entering, outOfRange, outOfRange)
    let filterCalls = 0
    const indexed = new SearchService({
      getCandidatesForFilters: async () => {
        filterCalls += 1
        if (filterCalls === 1) return new Map()
        await fs.utimes(entering, inRange, inRange)
        return new Map([[path.resolve(entering), {
          title: 'Entering',
          modifiedAt: inRange.toISOString(),
          workDir: null,
          projectPath: 'proj-a',
        }]])
      },
      getMetadataForPaths: async () => null,
    })
    let rgCalls = 0
    ;(indexed as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(indexed as unknown as {
      runCommand: (_command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      rgCalls += 1
      expect(args.at(-1)).toBe(path.dirname(entering))
      return JSON.stringify({
        type: 'match',
        data: { path: { text: entering }, line_number: 1 },
      })
    }

    const { results } = await indexed.searchSessions('emptysetraceneedle', {
      project: 'proj-a',
      modifiedAfter: '2026-01-01T00:00:00.000Z',
    })

    expect(filterCalls).toBe(2)
    expect(rgCalls).toBe(1)
    expect(results.map(result => result.sessionId)).toEqual(['entering-session'])
  })

  it('abandons exact candidates when a same-key transcript changes after phase A scans it', async () => {
    const query = 'contentsnapshotneedle'
    const transcriptPath = await writeSessionFile('proj-a', 'changed-session', [{
      type: 'user',
      uuid: 'changed',
      message: { role: 'user', content: 'x'.repeat(query.length) },
      timestamp: '2026-06-01T00:00:00.000Z',
    }])
    const sourceBefore = await fs.stat(transcriptPath)
    const directoryBefore = await fs.stat(path.dirname(transcriptPath))
    const sourceSnapshot = (snapshot: Awaited<ReturnType<typeof fs.stat>>) => ({
      dev: snapshot.dev,
      ino: snapshot.ino,
      size: snapshot.size,
      mtimeMs: snapshot.mtimeMs,
      ctimeMs: snapshot.ctimeMs,
    })
    let filterCalls = 0
    const indexed = new SearchService({
      getCandidatesForFilters: async () => {
        filterCalls += 1
        const snapshot = await fs.stat(transcriptPath)
        return new Map([[path.resolve(transcriptPath), {
          title: 'Changed',
          modifiedAt: '2026-06-01T00:00:00.000Z',
          workDir: null,
          projectPath: 'proj-a',
          sourceSnapshot: sourceSnapshot(snapshot),
        }]])
      },
      getMetadataForPaths: async () => null,
    } as never)
    let rgCalls = 0
    ;(indexed as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(indexed as unknown as {
      runCommand: (_command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      rgCalls += 1
      if (rgCalls === 1) {
        await new Promise(resolve => setTimeout(resolve, 8))
        await fs.writeFile(transcriptPath, `${JSON.stringify({
          type: 'user',
          uuid: 'changed',
          message: { role: 'user', content: query },
          timestamp: '2026-06-01T00:00:00.000Z',
        })}\n`)
        await fs.utimes(
          transcriptPath,
          sourceBefore.mtimeMs / 1000,
          sourceBefore.mtimeMs / 1000,
        )
        return ''
      }
      expect(args.at(-1)).toBe(path.dirname(transcriptPath))
      return JSON.stringify({
        type: 'match',
        data: { path: { text: transcriptPath }, line_number: 1 },
      })
    }

    const { results } = await indexed.searchSessions(query, { project: 'proj-a' })
    const directoryAfter = await fs.stat(path.dirname(transcriptPath))

    expect(directoryAfter.mtimeMs).toBe(directoryBefore.mtimeMs)
    expect(directoryAfter.ctimeMs).toBe(directoryBefore.ctimeMs)
    const restoredMtimeMs = (await fs.stat(transcriptPath)).mtimeMs
    expect(Math.abs(restoredMtimeMs - sourceBefore.mtimeMs)).toBeLessThan(1)
    expect(filterCalls).toBe(2)
    expect(rgCalls).toBe(2)
    expect(results.map(result => result.sessionId)).toEqual(['changed-session'])
  })

  it('batches large ready-index candidate sets into bounded rg argv', async () => {
    await fs.mkdir(path.join(tmpDir, 'projects', 'proj-a'), { recursive: true })
    const paths = Array.from({ length: 130 }, (_, index) =>
      path.join(tmpDir, 'projects', 'proj-a', `candidate-${index}.jsonl`))
    const metadata = new Map(paths.map((filePath, index) => [path.resolve(filePath), {
      title: `Candidate ${index}`,
      modifiedAt: '2026-06-01T00:00:00.000Z',
      workDir: null,
      projectPath: 'proj-a',
    }]))
    const indexed = new SearchService({
      getCandidatesForFilters: async () => metadata,
    } as never)
    const batches: string[][] = []
    ;(indexed as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(indexed as unknown as {
      runCommand: (_command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      const separator = args.indexOf('--')
      batches.push(args.slice(separator + 2))
      return ''
    }

    const output = await indexed.searchSessions('batchneedle', { project: 'proj-a' })

    expect(output.results).toEqual([])
    expect(batches).toHaveLength(2)
    expect(batches.every(batch => batch.length <= 128)).toBe(true)
    expect(batches.flat()).toEqual(paths)
  })

  it('falls back to the canonical project root when index candidates are unavailable', async () => {
    const filePath = await writeSessionFile('proj-a', 'fallback-candidate', [{
      type: 'user',
      uuid: 'fallback',
      message: { role: 'user', content: 'rootfallbackneedle' },
    }])
    const fallback = new SearchService({
      getCandidatesForFilters: async () => null,
    } as never)
    ;(fallback as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => true
    ;(fallback as unknown as {
      runCommand: (_command: string, args: string[]) => Promise<string>
    }).runCommand = async (_command, args) => {
      expect(args.at(-1)).toBe(path.dirname(filePath))
      return JSON.stringify({
        type: 'match',
        data: { path: { text: filePath }, line_number: 1 },
      })
    }

    const { results } = await fallback.searchSessions('rootfallbackneedle', {
      project: 'proj-a',
    })

    expect(results.map(result => result.sessionId)).toEqual(['fallback-candidate'])
  })

  it('keeps date-only nested subagent matches on the canonical recursive path', async () => {
    const subagentPath = path.join(
      tmpDir,
      'projects',
      'proj-a',
      'lead-session',
      'subagents',
      'agent-worker.jsonl',
    )
    await fs.mkdir(path.dirname(subagentPath), { recursive: true })
    await fs.writeFile(subagentPath, `${JSON.stringify({
      type: 'assistant',
      uuid: 'subagent-message',
      message: { role: 'assistant', content: 'nesteddateonlyneedle' },
      timestamp: '2026-06-01T00:00:00.000Z',
    })}\n`)
    const gateway: LocalIndexGateway = {
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
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      findSearchCandidates: () => {
        throw new Error('date-only search must preserve recursive canonical scope')
      },
      async rebuild() { return this.getPublicStatus() },
    }
    const indexedSessionService = new SessionService(gateway)
    const indexed = new SearchService({
      getCandidatesForFilters: filters =>
        indexedSessionService.getIndexedSessionSearchCandidates(filters),
      getMetadataForPaths: async () => null,
    })

    const { results } = await indexed.searchSessions('nesteddateonlyneedle', {
      modifiedAfter: '2026-01-01T00:00:00.000Z',
    })

    expect(results.map(result => result.sessionId)).toEqual(['agent-worker'])
  })

  it('keeps phase-B work proportional for 10 and 60 indexed candidates', async () => {
    for (const candidateCount of [10, 60]) {
      const query = `needle-${candidateCount}`
      const files = await Promise.all(Array.from({ length: candidateCount }, (_, index) =>
        writeSessionFile(`project-${candidateCount}`, `session-${candidateCount}-${index}`, [{
          type: 'user',
          uuid: `u-${index}`,
          message: { role: 'user', content: `${query} result ${index}` },
        }]),
      ))
      const metadata = new Map(files.map((filePath, index) => [path.resolve(filePath), {
        title: `Session ${index}`,
        modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        workDir: null,
        projectPath: `project-${candidateCount}`,
      }]))
      const metrics = { candidateFiles: 0, filesOpened: 0, bytesRead: 0, fallbackFiles: 0 }
      const targeted = new SearchService({
        readEntriesAtLines: async (filePath, lineNumbers) => ({
          entries: [{
            entry: {
              type: 'user',
              uuid: path.basename(filePath),
              message: { role: 'user', content: `${query} bounded` },
            },
            lineNumber: [...lineNumbers][0]!,
          }],
          bytesRead: 96,
          rangesRead: 1,
        }),
        getMetadataForPaths: async () => metadata,
      })

      await targeted.searchSessions(query, { metrics })

      expect(metrics).toEqual({
        candidateFiles: candidateCount,
        filesOpened: candidateCount,
        bytesRead: candidateCount * 96,
        fallbackFiles: 0,
      })
    }
  })

  it('matches user message text and returns role=user with correct highlights', async () => {
    await writeSessionFile('proj-a', 'session-1', [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-06-01T00:00:00.000Z',
        message: { role: 'user', content: 'please implement global search feature' },
      },
    ])

    const { results } = await service.searchSessions('global search')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('session-1')
    expect(results[0].projectPath).toBe('proj-a')

    const m = results[0].matches[0]
    expect(m.role).toBe('user')
    expect(m.messageId).toBe('u1')
    expect(m.lineNumber).toBe(1)
    expect(m.snippet.slice(m.highlights[0].start, m.highlights[0].end).toLowerCase()).toBe(
      'global search',
    )
  })

  it('matches assistant text blocks and returns role=assistant', async () => {
    await writeSessionFile('proj-a', 'session-2', [
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I recommend ripgrep for this' }] },
      },
    ])

    const { results } = await service.searchSessions('ripgrep')
    expect(results).toHaveLength(1)
    expect(results[0].matches[0].role).toBe('assistant')
  })

  it('matches Chinese content with correct highlight slicing', async () => {
    await writeSessionFile('proj-a', 'session-3', [
      { type: 'user', message: { role: 'user', content: '帮我做一个全文搜索功能' } },
    ])

    const { results } = await service.searchSessions('全文搜索')
    expect(results).toHaveLength(1)
    const m = results[0].matches[0]
    expect(m.snippet.slice(m.highlights[0].start, m.highlights[0].end)).toBe('全文搜索')
  })

  it('treats regex metacharacters, quotes, and backslashes as literal JSON text', async () => {
    const query = '[a.*]? "SQLite" \\路径 搜索'
    await writeSessionFile('proj-a', 'literal-specials', [{
      type: 'user',
      uuid: 'literal-specials-entry',
      message: { role: 'user', content: `前缀 ${query} 后缀` },
    }])

    const { results } = await service.searchSessions(query)

    expect(results.map(result => result.sessionId)).toEqual(['literal-specials'])
    expect(results[0]?.matches[0]?.snippet).toContain(query)
  })

  it('searches only user/assistant text, ignoring tool_use and tool_result blocks', async () => {
    await writeSessionFile('proj-a', 'session-4', [
      {
        type: 'assistant',
        uuid: 'a2',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'running the command now' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rg zzytoolmarker --json' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'zzytoolmarker found in 3 files' }],
        },
      },
    ])

    // 'zzytoolmarker' only lives in tool_use input + tool_result content → must NOT match.
    const tool = await service.searchSessions('zzytoolmarker')
    expect(tool.results).toHaveLength(0)

    // The assistant's natural-language text is searchable.
    const text = await service.searchSessions('running the command')
    expect(text.results).toHaveLength(1)
    expect(text.results[0].matches[0].role).toBe('assistant')
  })

  it('drops ripgrep false positives that only hit JSON structure (keys/uuids)', async () => {
    await writeSessionFile('proj-a', 'session-5', [
      { type: 'user', uuid: 'assistant-like-uuid', message: { role: 'user', content: 'hello world' } },
    ])

    // 'content' is a JSON key, never part of the readable text 'hello world'.
    const noise = await service.searchSessions('content')
    expect(noise.results).toHaveLength(0)

    const real = await service.searchSessions('hello world')
    expect(real.results).toHaveLength(1)
  })

  it('skips internal command breadcrumb entries', async () => {
    await writeSessionFile('proj-a', 'session-6', [
      { type: 'user', message: { role: 'user', content: '<command-name>deploy</command-name> magicword' } },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<command-message>agent</command-message> magicword' }],
        },
      },
    ])

    const { results } = await service.searchSessions('magicword')
    expect(results).toHaveLength(0)
  })

  it('indexes readable command metadata entries', async () => {
    await writeSessionFile('proj-a', 'session-7', [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            '<command-message>frontend-design</command-message>',
            '<command-name>/frontend-design</command-name>',
            '<command-args>redesign settings page</command-args>',
          ].join('\n'),
        },
      },
    ])

    const { results } = await service.searchSessions('redesign')
    expect(results).toHaveLength(1)
    expect(results[0]!.matches[0]!.snippet).toContain('/frontend-design redesign settings page')
  })

  it('resolves the real session title (custom-title wins) instead of the UUID', async () => {
    const entry = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'discuss searchword topic' } }
    const filePath = await writeSessionFile('proj-a', 'titled-session', [
      entry,
      { type: 'ai-title', aiTitle: 'AI Generated Title', sessionId: 'titled-session' },
      { type: 'custom-title', customTitle: 'My Custom Title', sessionId: 'titled-session' },
    ])
    const indexedTitleService = new SearchService({
      getMetadataForPaths: async () => new Map([[path.resolve(filePath), {
        title: 'My Custom Title',
        modifiedAt: '2026-07-16T00:00:00.000Z',
        workDir: null,
        projectPath: 'proj-a',
      }]]),
      readEntriesAtLines: async () => ({
        entries: [{ entry, lineNumber: 1 }],
        bytesRead: Buffer.byteLength(JSON.stringify(entry)) + 1,
        rangesRead: 1,
      }),
    })

    const { results } = await indexedTitleService.searchSessions('searchword')
    expect(results[0].title).toBe('My Custom Title')
    expect(results[0].title).not.toBe('titled-session')
  })

  it('falls back to the AI title when there is no custom title', async () => {
    const entry = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'another searchword here' } }
    const filePath = await writeSessionFile('proj-a', 'ai-titled', [
      entry,
      { type: 'ai-title', aiTitle: 'Smart Title', sessionId: 'ai-titled' },
    ])
    const indexedTitleService = new SearchService({
      getMetadataForPaths: async () => new Map([[path.resolve(filePath), {
        title: 'Smart Title',
        modifiedAt: '2026-07-16T00:00:00.000Z',
        workDir: null,
        projectPath: 'proj-a',
      }]]),
      readEntriesAtLines: async () => ({
        entries: [{ entry, lineNumber: 1 }],
        bytesRead: Buffer.byteLength(JSON.stringify(entry)) + 1,
        rangesRead: 1,
      }),
    })

    const { results } = await indexedTitleService.searchSessions('another searchword')
    expect(results[0].title).toBe('Smart Title')
  })

  it('windows snippets for very long lines', async () => {
    const filler = 'x'.repeat(50_000)
    await writeSessionFile('proj-a', 'session-8', [
      { type: 'user', message: { role: 'user', content: `${filler} NEEDLEWORD ${filler}` } },
    ])

    const { results } = await service.searchSessions('NEEDLEWORD')
    expect(results).toHaveLength(1)
    const m = results[0].matches[0]
    expect(m.snippet.length).toBeLessThan(600)
    expect(m.snippet).toContain('…')
    expect(m.snippet.slice(m.highlights[0].start, m.highlights[0].end)).toBe('NEEDLEWORD')
  })

  it('caps matches per session but reports the full matchCount', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      type: 'user',
      uuid: `u${i}`,
      message: { role: 'user', content: `repeatword occurrence number ${i}` },
    }))
    await writeSessionFile('proj-a', 'session-9', entries)

    const { results } = await service.searchSessions('repeatword', { matchesPerSession: 3 })
    expect(results[0].matchCount).toBe(8)
    expect(results[0].matches).toHaveLength(3)
  })

  it('orders sessions by most-recently modified first', async () => {
    const older = await writeSessionFile('proj-a', 'older', [
      { type: 'user', message: { role: 'user', content: 'sortword in older' } },
    ])
    await writeSessionFile('proj-b', 'newer', [
      { type: 'user', message: { role: 'user', content: 'sortword in newer' } },
    ])
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(older, past, past)

    const { results } = await service.searchSessions('sortword')
    expect(results.map((r) => r.sessionId)).toEqual(['newer', 'older'])
  })

  it('skips malformed/half-written lines without crashing', async () => {
    await writeSessionFile('proj-a', 'session-11', [
      { type: 'user', message: { role: 'user', content: 'valid brokenmarker line' } },
      '{ this is not valid json brokenmarker',
    ])

    const { results } = await service.searchSessions('brokenmarker')
    expect(results).toHaveLength(1)
    expect(results[0].matchCount).toBe(1)
  })

  it('throws on empty or whitespace-only query', async () => {
    await expect(service.searchSessions('')).rejects.toThrow()
    await expect(service.searchSessions('   ')).rejects.toThrow()
  })

  it('stops before scanning when the caller has already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      service.searchSessions('cancelled search', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('propagates cancellation into the active ripgrep scan', async () => {
    const controller = new AbortController()
    let commandSignal: AbortSignal | undefined
    ;(service as unknown as { commandExists: () => Promise<boolean> }).commandExists =
      async () => true
    ;(service as unknown as {
      runCommand: (
        command: string,
        args: string[],
        signal?: AbortSignal,
      ) => Promise<string>
    }).runCommand = async (_command, _args, signal) => {
      commandSignal = signal
      return await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      })
    }

    const pending = service.searchSessions('cancelled while running', {
      signal: controller.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(commandSignal).toBe(controller.signal)
    expect(commandSignal?.aborted).toBe(true)
  })

  it('falls back to a JS scan when ripgrep is unavailable', async () => {
    const filePath = await writeSessionFile('proj-a', 'session-13', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'fallbackword works fine' } },
    ])
    service = new SearchService({
      resolveRipgrepCommand: () => ({ rgPath: '', rgArgs: [] }),
    })
    const metrics = { candidateFiles: 0, filesOpened: 0, bytesRead: 0, fallbackFiles: 0 }

    const { results } = await service.searchSessions('fallbackword', { metrics })
    expect(results).toHaveLength(1)
    expect(results[0].matches[0].role).toBe('user')
    expect(results[0].matches[0].snippet).toContain('fallbackword')
    expect(metrics).toEqual({
      candidateFiles: 1,
      filesOpened: 1,
      bytesRead: (await fs.stat(filePath)).size,
      fallbackFiles: 1,
    })
  })

  it('uses the packaged ripgrep resolver without PATH lookup', async () => {
    const filePath = await writeSessionFile('proj-a', 'session-14', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'bundledword works' } },
    ])
    service = new SearchService({
      resolveRipgrepCommand: () => ({
        rgPath: '/packaged/rg',
        rgArgs: ['--no-config'],
        argv0: 'rg',
      }),
    })
    const invocations: Array<{
      command: string
      args: string[]
      argv0?: string
    }> = []
    ;(service as unknown as {
      runCommand: (
        command: string,
        args: string[],
        signal?: AbortSignal,
        onRecord?: (record: string) => void,
        spawnOptions?: { argv0?: string },
      ) => Promise<string>
    }).runCommand = async (command, args, _signal, onRecord, spawnOptions) => {
      invocations.push({ command, args, argv0: spawnOptions?.argv0 })
      if (args.includes('-l')) return `${filePath}\n`
      return ''
    }
    ;(service as unknown as {
      runCommandRecords: (
        command: string,
        args: string[],
        signal: AbortSignal | undefined,
        onRecord: (record: string) => void,
        spawnOptions?: { argv0?: string },
      ) => Promise<void>
    }).runCommandRecords = async (command, args, _signal, onRecord, spawnOptions) => {
      invocations.push({ command, args, argv0: spawnOptions?.argv0 })
      onRecord(`${filePath}:1:`)
    }

    const { results } = await service.searchSessions('bundledword')

    expect(invocations).toHaveLength(2)
    expect(invocations.every(call => call.command === '/packaged/rg')).toBe(true)
    expect(invocations.every(call => call.args[0] === '--no-config')).toBe(true)
    expect(invocations.every(call => call.argv0 === 'rg')).toBe(true)
    expect(results).toHaveLength(1)
  })

  it('returns empty when the projects dir does not exist', async () => {
    await fs.rm(path.join(tmpDir, 'projects'), { recursive: true, force: true })
    const { results, truncated } = await service.searchSessions('anything')
    expect(results).toEqual([])
    expect(truncated).toBe(false)
  })
})
