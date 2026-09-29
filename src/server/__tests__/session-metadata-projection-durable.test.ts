import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

/**
 * A fresh process used to rescan every transcript it touched to build the
 * metadata projection (measured 9.6 s on the first open of a 139 MB session).
 * The projection is a few KB of scalars, so it is kept on disk and reused when
 * its signature still matches.
 */
const SESSION_ID = '12870000-1111-2222-3333-444444444444'
let configDir: string
let cacheDir: string
let previousConfigDir: string | undefined
let previousCacheDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  previousCacheDir = process.env.CC_HAHA_TRANSCRIPT_METADATA_DIR
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-durable-'))
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-cache-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CC_HAHA_TRANSCRIPT_METADATA_DIR = cacheDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  if (previousCacheDir === undefined) delete process.env.CC_HAHA_TRANSCRIPT_METADATA_DIR
  else process.env.CC_HAHA_TRANSCRIPT_METADATA_DIR = previousCacheDir
  await fs.rm(configDir, { recursive: true, force: true })
  await fs.rm(cacheDir, { recursive: true, force: true })
})

async function seedSession() {
  const workDir = path.join(configDir, 'project')
  await fs.mkdir(workDir, { recursive: true })
  const directory = path.join(configDir, 'projects', sanitizePath(workDir))
  await fs.mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `${SESSION_ID}.jsonl`)
  await fs.writeFile(filePath, [
    { type: 'session-meta', workDir, permissionMode: 'plan' },
    { type: 'user', uuid: 'm1', timestamp: '2020-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'm2', timestamp: '2020-01-02T00:00:00.000Z', message: { role: 'assistant', content: 'reply' } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return { filePath, workDir }
}

function dropMemoryProjection(service: SessionService) {
  ;(service as unknown as { metadataProjectionCache: Map<string, unknown> }).metadataProjectionCache.clear()
}

describe('durable metadata projection', () => {
  it('serves a cold read from disk instead of rescanning the transcript', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // chmod cannot block root
    const { filePath } = await seedSession()

    const first = await new SessionService().getSessionSummary(SESSION_ID)
    expect(first?.messageCount).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 50)) // let the write settle

    // Prove the second read came from disk: with the transcript unreadable, a
    // rescan fails while a stored entry (stat still works) answers.
    await fs.chmod(filePath, 0o000)
    try {
      const service = new SessionService()
      dropMemoryProjection(service)
      const second = await service.getSessionSummary(SESSION_ID)
      expect(second?.messageCount).toBe(2)
      expect(second?.workDir).toBe(first?.workDir)
    } finally {
      await fs.chmod(filePath, 0o644)
    }
  })

  it('ignores a stored projection whose signature no longer matches', async () => {
    const { filePath } = await seedSession()
    await new SessionService().getSessionSummary(SESSION_ID)
    await new Promise(resolve => setTimeout(resolve, 50))

    // Same size, new mtime: the signature changes, so the stored entry is not
    // trusted and the transcript is scanned again.
    await fs.writeFile(filePath, (await fs.readFile(filePath, 'utf8'))
      .replace('"first"', '"other"'))
    const service = new SessionService()
    dropMemoryProjection(service)
    const summary = await service.getSessionSummary(SESSION_ID)
    expect(summary?.messageCount).toBe(2)
  })
})
