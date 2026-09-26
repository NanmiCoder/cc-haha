import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOriginalCwd, switchSession } from '../bootstrap/state.js'
import type { SessionId } from '../types/ids.js'
import {
  flushLocalShellMetadataWritesForTesting,
  getProjectDir,
  listLocalShellMetadata,
  readLocalShellMetadata,
  resetProjectForTesting,
  writeLocalShellMetadata,
  type LocalShellMetadata,
} from './sessionStorage.js'

const sessionId = 'local-shell-metadata-test' as SessionId

function metadata(status: LocalShellMetadata['lastKnownStatus'], outcomeKnown: boolean): LocalShellMetadata {
  return {
    schemaVersion: 1,
    taskId: 'bmetadata-test',
    sessionId,
    shellType: 'bash',
    pid: 1234,
    startTime: 1,
    lastKnownStatus: status,
    lastObservedAt: status === 'running' ? 1 : 2,
    outcomeKnown,
    ...(outcomeKnown ? { exitCode: status === 'completed' ? 0 : 1 } : {}),
  }
}

describe('local shell metadata persistence', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  let configDir: string

  beforeEach(async () => {
    configDir = join(tmpdir(), `local-shell-metadata-${crypto.randomUUID()}`)
    await mkdir(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
    switchSession(sessionId)
  })

  afterEach(async () => {
    await flushLocalShellMetadataWritesForTesting()
    resetProjectForTesting()
    await rm(configDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
  })

  test('resets the memoized project directory when the config directory changes', () => {
    const cwd = getOriginalCwd()
    const initialProjectDir = getProjectDir(cwd)
    expect(initialProjectDir.startsWith(join(configDir, 'projects'))).toBe(true)

    const nextConfigDir = join(configDir, 'next-config')
    process.env.CLAUDE_CONFIG_DIR = nextConfigDir
    resetProjectForTesting()

    expect(getProjectDir(cwd)).toBe(join(nextConfigDir, 'projects', initialProjectDir.split(/[\\/]/).at(-1)!))
  })

  test('keeps an explicit null project snapshot on the original project after switching sessions', async () => {
    const originalProjectDir = getProjectDir(getOriginalCwd())
    const switchedProjectDir = join(configDir, 'switched-project')
    await mkdir(switchedProjectDir, { recursive: true })
    const taskId = 'bnull-project-snapshot'
    await writeLocalShellMetadata({
      ...metadata('running', false),
      taskId,
    }, null)

    switchSession(sessionId, switchedProjectDir)
    await writeLocalShellMetadata({
      ...metadata('completed', true),
      taskId,
    }, null)

    await expect(readLocalShellMetadata(taskId, sessionId, null)).resolves.toMatchObject({
      lastKnownStatus: 'completed',
      outcomeKnown: true,
    })
    await expect(readLocalShellMetadata(taskId, sessionId, switchedProjectDir)).resolves.toBeNull()
    expect(originalProjectDir).not.toBe(switchedProjectDir)
  })

  test('serializes concurrent writes and keeps terminal metadata last', async () => {
    await Promise.all([
      writeLocalShellMetadata(metadata('running', false)),
      writeLocalShellMetadata(metadata('completed', true)),
    ])

    await expect(readLocalShellMetadata('bmetadata-test', sessionId, null)).resolves.toMatchObject({
      lastKnownStatus: 'completed',
      outcomeKnown: true,
      error: '',
    })
  })

  test('does not let a queued stale unknown recovery overwrite a terminal write', async () => {
    await writeLocalShellMetadata(metadata('running', false))

    const terminalWrite = writeLocalShellMetadata(metadata('completed', true))
    const staleRecoveryWrite = writeLocalShellMetadata({
      ...metadata('unknown', false),
      terminalReason: 'process_state_unverified',
      error: 'Process state unknown.',
    })

    await Promise.all([terminalWrite, staleRecoveryWrite])

    const result = await readLocalShellMetadata('bmetadata-test', sessionId, null)
    expect(result).toMatchObject({
      lastKnownStatus: 'completed',
      outcomeKnown: true,
      exitCode: 0,
    })
    expect(result?.terminalReason).toBeUndefined()
  })

  test('continues queued writes after a failure and removes the abandoned temp file', async () => {
    const taskId = 'bfailure-rename'
    const projectDir = join(configDir, 'rename-failure')
    const originalRename = fs.rename
    let renameCalls = 0
    const renameSpy = spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[1]).includes(`local-shell-${taskId}.meta.json`)) {
        renameCalls++
        if (renameCalls === 1) throw new Error('rename failed')
      }
      await originalRename(...args)
    })
    try {
      const first = writeLocalShellMetadata({ ...metadata('running', false), taskId }, projectDir)
      const second = writeLocalShellMetadata({ ...metadata('completed', true), taskId }, projectDir)

      await expect(first).rejects.toThrow('rename failed')
      await expect(second).resolves.toBeUndefined()
      await expect(readLocalShellMetadata(taskId, sessionId, projectDir)).resolves.toMatchObject({
        lastKnownStatus: 'completed',
      })
      const files = await readdir(join(projectDir, sessionId, 'local-shells'))
      expect(files.some(file => file.endsWith('.tmp'))).toBe(false)
    } finally {
      renameSpy.mockRestore()
    }
  })

  test('does not allow a late running write to replace terminal metadata', async () => {
    await writeLocalShellMetadata(metadata('completed', true))
    await writeLocalShellMetadata(metadata('running', false))

    const result = await readLocalShellMetadata('bmetadata-test', sessionId, null)
    expect(result?.lastKnownStatus).toBe('completed')
    expect(result?.outcomeKnown).toBe(true)
  })

  test('preserves unknown fields while replacing fields owned by the current schema', async () => {
    const projectDir = join(configDir, 'future-field-fixture')
    const taskId = 'bfuture-field'
    const metadataDir = join(projectDir, sessionId, 'local-shells')
    const metaPath = join(metadataDir, `local-shell-${taskId}.meta.json`)
    await mkdir(metadataDir, { recursive: true })
    await writeFile(metaPath, JSON.stringify({
      ...metadata('completed', true),
      taskId,
      terminalReason: 'command_exited',
      futureField: { preserved: true },
    }))

    await writeLocalShellMetadata({
      ...metadata('killed', false),
      taskId,
    }, projectDir)

    const raw = JSON.parse(await readFile(metaPath, 'utf-8')) as Record<string, unknown>
    expect(raw).toMatchObject({
      taskId,
      lastKnownStatus: 'killed',
      outcomeKnown: false,
      futureField: { preserved: true },
    })
    expect(raw).not.toHaveProperty('exitCode')
    expect(raw).not.toHaveProperty('terminalReason')
  })

  test('does not allow late running metadata to replace unknown killed metadata', async () => {
    await writeLocalShellMetadata({
      ...metadata('killed', false),
      terminalReason: 'termination_confirmed',
    })
    await writeLocalShellMetadata(metadata('running', false))

    await expect(readLocalShellMetadata('bmetadata-test', sessionId, null)).resolves.toMatchObject({
      lastKnownStatus: 'killed',
      outcomeKnown: false,
      terminalReason: 'termination_confirmed',
    })
  })

  test('does not allow late running metadata to replace unknown failed metadata', async () => {
    await writeLocalShellMetadata({
      ...metadata('failed', false),
      terminalReason: 'process_disappeared',
    })
    await writeLocalShellMetadata(metadata('running', false))

    await expect(readLocalShellMetadata('bmetadata-test', sessionId, null)).resolves.toMatchObject({
      lastKnownStatus: 'failed',
      outcomeKnown: false,
      terminalReason: 'process_disappeared',
    })
  })

  test('rejects unsafe identifiers and malformed sidecars', async () => {
    await expect(writeLocalShellMetadata({
      ...metadata('running', false),
      taskId: '../escape',
    })).rejects.toThrow('Invalid local shell metadata')
    await expect(readLocalShellMetadata('../escape', sessionId, null)).resolves.toBeNull()
    await expect(listLocalShellMetadata('../escape', null)).resolves.toEqual([])
    await expect(writeLocalShellMetadata({
      ...metadata('running', false),
      pid: 0,
    })).rejects.toThrow('Invalid local shell metadata')
  })

  test('rejects contradictory outcome metadata', async () => {
    const projectDir = join(configDir, 'invariant-fixture')
    const metaPath = join(projectDir, sessionId, 'local-shells', 'local-shell-binvariant.meta.json')
    const base = {
      ...metadata('killed', false),
      taskId: 'binvariant',
    }
    await mkdir(join(projectDir, sessionId, 'local-shells'), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(metaPath, JSON.stringify({ ...base, exitCode: 137 }))
    await expect(readLocalShellMetadata('binvariant', sessionId, projectDir)).resolves.toBeNull()
    const terminalWithoutExitCode = { ...metadata('killed', true), taskId: 'binvariant' }
    delete terminalWithoutExitCode.exitCode
    await writeFile(metaPath, JSON.stringify(terminalWithoutExitCode))
    await expect(readLocalShellMetadata('binvariant', sessionId, projectDir)).resolves.toBeNull()
    await writeFile(metaPath, JSON.stringify({ ...metadata('running', true), taskId: 'binvariant', exitCode: 0 }))
    await expect(readLocalShellMetadata('binvariant', sessionId, projectDir)).resolves.toBeNull()
  })

  test('returns null for a truncated or corrupted metadata sidecar', async () => {
    const { writeFile } = await import('node:fs/promises')
    const projectDir = join(configDir, 'fixture-project')
    const valid = { ...metadata('completed', true), taskId: 'bcorrupted', sessionId }
    await writeLocalShellMetadata(valid, projectDir)
    const metaPath = join(projectDir, sessionId, 'local-shells', 'local-shell-bcorrupted.meta.json')
    await writeFile(metaPath, '{"schemaVersion":1,"taskId":"bcorrupted","sessionId":"bad",')
    await expect(readLocalShellMetadata('bcorrupted', sessionId, projectDir)).resolves.toBeNull()

    await writeFile(metaPath, 'not-json-at-all!!!!')
    await expect(readLocalShellMetadata('bcorrupted', sessionId, projectDir)).resolves.toBeNull()

    const listed = await listLocalShellMetadata(sessionId, projectDir)
    expect(listed.find(m => m.taskId === 'bcorrupted')).toBeUndefined()
  })

  test('lists only metadata from the requested session', async () => {
    await writeLocalShellMetadata(metadata('completed', true))
    const otherSession = 'local-shell-other-session' as SessionId
    await writeLocalShellMetadata({ ...metadata('failed', true), sessionId: otherSession })

    const current = await listLocalShellMetadata(sessionId, null)
    expect(current.map(entry => entry.taskId)).toEqual(['bmetadata-test'])
    expect(current).toHaveLength(1)
    expect(current[0]?.sessionId).toBe(sessionId)

    expect(current[0]?.taskId).toBe('bmetadata-test')
  })
})
