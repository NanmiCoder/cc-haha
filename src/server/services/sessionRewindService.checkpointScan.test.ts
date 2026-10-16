import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import * as filesystemAccessRoots from './filesystemAccessRoots.js'

const originalEnvironment = { ...process.env }
let sandbox: string
let configDir: string
let listSessionTurnCheckpoints: typeof import('./sessionRewindService.js').listSessionTurnCheckpoints
let canonicalize: ReturnType<typeof spyOn<typeof filesystemAccessRoots, 'canonicalizeFilesystemAccessPath'>>

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'checkpoint-scan-'))
  const environment = createSandboxedTestEnvironment(sandbox, {
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
  configDir = environment.CLAUDE_CONFIG_DIR!
  // Spy before the service links its import; a later spy is not seen there.
  canonicalize = spyOn(filesystemAccessRoots, 'canonicalizeFilesystemAccessPath')
  listSessionTurnCheckpoints = (await import('./sessionRewindService.js')).listSessionTurnCheckpoints
})

afterAll(async () => {
  canonicalize.mockRestore()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  await rm(sandbox, { recursive: true, force: true })
})

type Backup = { backupFileName: string | null; version: number; backupTime: string }

/**
 * Like the CLI, every snapshot carries all files tracked so far, while each turn
 * changes only `editedFileOfTurn(turn)`, through a recorded Edit call when
 * `recordEdits` is set.
 */
async function createSession(options: {
  turns: number
  files: number
  editedFileOfTurn: (turn: number) => number | null
  recordEdits?: boolean
}) {
  const sessionId = crypto.randomUUID()
  const workDir = join(sandbox, `work-${sessionId}`)
  const historyDir = join(configDir, 'file-history', sessionId)
  await mkdir(join(workDir, 'src'), { recursive: true })
  await mkdir(historyDir, { recursive: true })
  const contents = Array.from({ length: options.files }, (_, file) => `export const value${file} = 0\n`)
  const backups: Record<string, Backup> = {}
  const versions = new Array<number>(options.files).fill(1)
  for (let file = 0; file < options.files; file++) {
    const backupFileName = `f${file}@v1`
    await writeFile(join(historyDir, backupFileName), contents[file]!)
    backups[`src/f${file}.ts`] = { backupFileName, version: 1, backupTime: '2026-10-14T00:00:00.000Z' }
  }

  const rows: unknown[] = [{ type: 'session-meta', isMeta: true, workDir, timestamp: '2026-10-14T00:00:00.000Z' }]
  for (let turn = 0; turn < options.turns; turn++) {
    const userId = crypto.randomUUID()
    rows.push({
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: { messageId: userId, trackedFileBackups: { ...backups }, timestamp: '2026-10-14T00:00:00.000Z' },
      isSnapshotUpdate: false,
    })
    rows.push({
      parentUuid: null, isSidechain: false, type: 'user', uuid: userId, cwd: workDir, sessionId,
      userType: 'external', timestamp: '2026-10-14T00:01:00.000Z',
      message: { role: 'user', content: `turn ${turn}` },
    })
    const edited = options.editedFileOfTurn(turn)
    const addedLine = `export const turn${turn} = ${turn}`
    if (edited !== null && options.recordEdits) {
      const lastLine = contents[edited]!.trimEnd().split('\n').at(-1)!
      const toolUseId = `toolu_edit_${turn}`
      rows.push({
        parentUuid: userId, isSidechain: false, type: 'assistant', uuid: crypto.randomUUID(), cwd: workDir,
        timestamp: '2026-10-14T00:01:30.000Z',
        message: { id: `msg_edit_${turn}`, type: 'message', role: 'assistant', content: [{
          type: 'tool_use', id: toolUseId, name: 'Edit',
          input: { file_path: join(workDir, 'src', `f${edited}.ts`), old_string: lastLine, new_string: `${lastLine}\n${addedLine}` },
        }] },
      })
      rows.push({
        parentUuid: null, isSidechain: false, type: 'user', uuid: crypto.randomUUID(), cwd: workDir,
        timestamp: '2026-10-14T00:01:40.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'The file has been updated.' }] },
      })
    }
    rows.push({
      parentUuid: userId, isSidechain: false, type: 'assistant', uuid: crypto.randomUUID(), cwd: workDir,
      timestamp: '2026-10-14T00:02:00.000Z',
      message: { id: `msg_${turn}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: `done ${turn}` }] },
    })

    if (edited === null) continue
    contents[edited] += `${addedLine}\n`
    versions[edited]! += 1
    const backupFileName = `f${edited}@v${versions[edited]}`
    await writeFile(join(historyDir, backupFileName), contents[edited]!)
    backups[`src/f${edited}.ts`] = { backupFileName, version: versions[edited]!, backupTime: '2026-10-14T00:00:00.000Z' }
  }
  for (let file = 0; file < options.files; file++) {
    await writeFile(join(workDir, 'src', `f${file}.ts`), contents[file]!)
  }

  const projectDir = join(configDir, 'projects', `-checkpoint-scan-${sessionId.slice(0, 8)}`)
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return { sessionId, workDir, historyDir }
}

test('keeps checkpoint path canonicalization linear in tracked files per turn', async () => {
  const turns = 8
  const files = 80
  const { sessionId, workDir } = await createSession({ turns, files, editedFileOfTurn: (turn) => turn })

  canonicalize.mockClear()
  const checkpoints = await listSessionTurnCheckpoints(sessionId)

  expect(checkpoints.map((checkpoint) => checkpoint.code.filesChanged)).toEqual(
    Array.from({ length: turns }, (_, turn) => [join(workDir, 'src', `f${turn}.ts`)]),
  )
  // Each call is a realpath syscall. Matching every tracked file against the
  // whole next snapshot needs turns × files² (44,800 here); an index needs a
  // few per file.
  expect(canonicalize.mock.calls.length).toBeGreaterThan(0)
  expect(canonicalize.mock.calls.length).toBeLessThan(turns * files * 8)
})

test('an unchanged carried-forward file still requires a readable backup to restore', async () => {
  // f1 is tracked but never edited, so both boundaries of every turn share f1@v1.
  const { sessionId, historyDir } = await createSession({
    turns: 3,
    files: 2,
    editedFileOfTurn: (turn) => turn === 2 ? null : 0,
  })

  const readable = await listSessionTurnCheckpoints(sessionId)
  expect(readable.map((checkpoint) => checkpoint.restoreAvailable)).toEqual([true, true, true])

  await rm(join(historyDir, 'f1@v1'))
  const missing = await listSessionTurnCheckpoints(sessionId)
  expect(missing.map((checkpoint) => checkpoint.restoreAvailable)).toEqual([false, false, false])
  // Losing the backup makes undo unsafe without turning the unchanged file into
  // a change, including on the latest turn whose after state is the disk.
  expect(missing.map((checkpoint) => checkpoint.code.filesChanged.length)).toEqual([1, 1, 0])
})

test('after file-history retention cleanup, turns fall back to recorded edits', async () => {
  // Transcripts outlive file-history backups (365 vs 30 days by default).
  const { sessionId, workDir, historyDir } = await createSession({
    turns: 3,
    files: 4,
    editedFileOfTurn: (turn) => turn,
    recordEdits: true,
  })
  await rm(historyDir, { recursive: true })

  const checkpoints = await listSessionTurnCheckpoints(sessionId)
  expect(checkpoints.map((checkpoint) => checkpoint.code.filesChanged)).toEqual(
    [0, 1, 2].map((file) => [join(workDir, 'src', `f${file}.ts`)]),
  )
  // Counted from each Edit's old/new strings, not a fabricated whole-file add.
  expect(checkpoints.map((checkpoint) => [checkpoint.code.insertions, checkpoint.code.deletions])).toEqual(
    [[2, 1], [2, 1], [2, 1]],
  )
  expect(checkpoints.map((checkpoint) => checkpoint.restoreAvailable)).toEqual([false, false, false])
})
