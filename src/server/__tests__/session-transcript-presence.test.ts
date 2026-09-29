import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'

/**
 * The presence check answers "real transcript or placeholder?", which drives only
 * the ordering of several matches for one session id. It used to read and parse
 * the entire file for that answer — 4-6 s per `findSessionFile` on a 139 MB
 * session that also had a 184 MB copy under another root, and `findSessionFile`
 * sits on nearly every session endpoint. These tests pin the answer it must
 * still give, and the bound it now reads within.
 */
let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-presence-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

const PRESENCE_SCAN_BYTES = 8 * 1024 * 1024

function presenceCheck(sessionService: SessionService) {
  return (filePath: string): Promise<boolean> =>
    (sessionService as unknown as {
      hasConversationTranscriptInFile(p: string): Promise<boolean>
    }).hasConversationTranscriptInFile(filePath)
}

const line = (entry: Record<string, unknown>) => JSON.stringify(entry) + '\n'
const meta = () => line({ type: 'session-meta', workDir: '/tmp/x' })
const snapshot = () => line({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: {} } })
const userTurn = (uuid: string) =>
  line({ type: 'user', uuid, message: { role: 'user', content: 'hello' } })

/** Padding that is neither conversation nor tiny, used to push past the cap. */
function snapshotPadding(bytes: number): string {
  const unit = snapshot()
  return unit.repeat(Math.ceil(bytes / unit.length))
}

describe('transcript presence check', () => {
  it('finds a conversation at the head without needing the rest of the file', async () => {
    const file = path.join(configDir, 'head.jsonl')
    await fs.writeFile(file, meta() + userTurn('m1') + snapshotPadding(1024 * 1024))
    await expect(presenceCheck(new SessionService()).call(null, file)).resolves.toBe(true)
  })

  it('reports a metadata-only transcript as a placeholder', async () => {
    const file = path.join(configDir, 'placeholder.jsonl')
    await fs.writeFile(file, meta() + snapshot() + snapshot())
    await expect(presenceCheck(new SessionService()).call(null, file)).resolves.toBe(false)
  })

  it('stops at its cap, so a conversation past it is not found', async () => {
    // This is the deliberate limit of the bounded read: it is what makes the
    // common case cheap, and the flag only orders matches, so a transcript whose
    // first 8 MB carries no message is treated as a placeholder.
    const file = path.join(configDir, 'late.jsonl')
    await fs.writeFile(file, snapshotPadding(PRESENCE_SCAN_BYTES + 64 * 1024) + userTurn('m1'))
    await expect(presenceCheck(new SessionService()).call(null, file)).resolves.toBe(false)
  })

  it('returns false for a transcript that does not exist', async () => {
    const file = path.join(configDir, 'absent.jsonl')
    await expect(presenceCheck(new SessionService()).call(null, file)).resolves.toBe(false)
  })
})
