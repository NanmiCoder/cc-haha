import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanupOldFileHistoryBackups, cleanupOldSessionEnvDirs, cleanupOldSessionFiles } from './cleanup.js'
import { readSessionArchives, withSessionArchiveLock, writeSessionArchive } from './sessionArchiveStore.js'
import { getFsImplementation } from './fsOperations.js'

let configDir: string
let previousConfigDir: string | undefined
const archivedId = '00000000-aaaa-bbbb-cccc-dddddddddddd'
const ordinaryId = '00000001-aaaa-bbbb-cccc-dddddddddddd'
const oldDate = new Date('2000-01-01T00:00:00.000Z')

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'archive-cleanup-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

async function fixture(id: string) {
  const paths = [
    join(configDir, 'projects', 'old-project', `${id}.jsonl`),
    join(configDir, 'projects', 'old-project', `${id}.cast`),
    join(configDir, 'projects', 'old-project', id, 'subagents', 'agent.jsonl'),
    join(configDir, 'projects', 'old-project', id, 'tool-results', 'read.txt'),
    join(configDir, 'file-history', id, 'original.txt'),
    join(configDir, 'session-env', id, 'snapshot'),
  ]
  for (const file of paths) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'old preserved fixture\n')
    await utimes(file, oldDate, oldDate)
    await utimes(dirname(file), oldDate, oldDate)
  }
  return paths
}

describe('archived session retention', () => {
  it.each(['transcript', 'subagent', 'tool-result', 'file-history', 'session-env'] as const)('rechecks archive state after scanning a %s deletion candidate', async kind => {
    const files = await fixture(archivedId)
    for (const file of files) await utimes(file, new Date(), new Date())
    const candidate = kind === 'transcript' ? files[0]!
      : kind === 'subagent' ? files[2]!
        : kind === 'tool-result' ? files[3]!
          : dirname(files[kind === 'file-history' ? 4 : 5]!)
    await utimes(candidate, oldDate, oldDate)
    const fsImpl = getFsImplementation()
    const stat = fsImpl.stat.bind(fsImpl)
    let archivedDuringScan = false
    const probe = spyOn(fsImpl, 'stat').mockImplementation(async file => {
      const result = await stat(file)
      if (file === candidate && !archivedDuringScan) {
        archivedDuringScan = true
        await withSessionArchiveLock(configDir, async () => writeSessionArchive(configDir, archivedId, true))
      }
      return result
    })
    try {
      const result = kind === 'file-history' ? await cleanupOldFileHistoryBackups()
        : kind === 'session-env' ? await cleanupOldSessionEnvDirs()
          : await cleanupOldSessionFiles(new Date('2026-01-01T00:00:00.000Z'))
      expect(archivedDuringScan).toBe(true)
      expect(result).toEqual({ messages: 0, errors: 0 })
      for (const file of files) expect(await readFile(file, 'utf8')).toBe('old preserved fixture\n')
    } finally { probe.mockRestore() }
  })

  it('excludes old archived transcripts and backing files from preview and actual cleanup, then resumes cleanup after restore', async () => {
    const archived = await fixture(archivedId)
    const ordinary = await fixture(ordinaryId)
    const archivePath = join(configDir, 'cc-haha', 'session-archives.json')
    await mkdir(dirname(archivePath))
    // Old unversioned metadata is also a retention promise.
    await writeFile(archivePath, JSON.stringify({ sessions: { [archivedId]: { archived: true, extension: 'keep' } }, rootExtension: true }))
    const cutoff = new Date('2026-01-01T00:00:00.000Z')
    expect(await cleanupOldSessionFiles(cutoff, { dryRun: true })).toEqual({ messages: 4, errors: 0 })
    for (const file of [...archived, ...ordinary]) expect(await readFile(file, 'utf8')).toBe('old preserved fixture\n')
    expect(await cleanupOldSessionFiles(cutoff)).toEqual({ messages: 4, errors: 0 })
    expect(await cleanupOldFileHistoryBackups()).toEqual({ messages: 1, errors: 0 })
    expect(await cleanupOldSessionEnvDirs()).toEqual({ messages: 1, errors: 0 })
    for (const file of archived) expect(await readFile(file, 'utf8')).toBe('old preserved fixture\n')
    for (const file of ordinary) await expect(access(file)).rejects.toThrow()
    writeSessionArchive(configDir, archivedId, false)
    expect(readSessionArchives(configDir).state).toMatchObject({ schemaVersion: 1, rootExtension: true, sessions: { [archivedId]: { archived: false, extension: 'keep' } } })
    expect(await cleanupOldSessionFiles(cutoff)).toEqual({ messages: 4, errors: 0 })
    expect(await cleanupOldFileHistoryBackups()).toEqual({ messages: 1, errors: 0 })
    expect(await cleanupOldSessionEnvDirs()).toEqual({ messages: 1, errors: 0 })
    for (const file of archived) await expect(access(file)).rejects.toThrow()
  })

  it('stops destructive cleanup when archive metadata is unreadable', async () => {
    const archived = await fixture(archivedId)
    const archivePath = join(configDir, 'cc-haha', 'session-archives.json')
    await mkdir(dirname(archivePath))
    await writeFile(archivePath, '{broken')
    await expect(cleanupOldSessionFiles(new Date())).rejects.toThrow()
    await expect(cleanupOldFileHistoryBackups()).rejects.toThrow()
    await expect(cleanupOldSessionEnvDirs()).rejects.toThrow()
    for (const file of archived) expect(await readFile(file, 'utf8')).toBe('old preserved fixture\n')
    expect(await readFile(archivePath, 'utf8')).toBe('{broken')
  })
})
