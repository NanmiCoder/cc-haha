import { expect, test, spyOn, mock } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, quiesceServerRuntimeForMigration, quiesceServerRuntimeForRecovery } from '../index.js'
import { migrationMaintenance } from '../migrationMaintenance.js'
import { conversationService } from '../services/conversationService.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { teamWatcher } from '../services/teamWatcher.js'
import { diagnosticsService } from '../services/diagnosticsService.js'
import { localIndexCoordinator } from '../services/localIndex/coordinator.js'
import { searchContentCoordinator } from '../services/localIndex/searchContentCoordinator.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { sessionService } from '../services/sessionService.js'

test('validation startup keeps business traffic and index writes disabled until activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-validation-'))
  const old = { root: process.env.CLAUDE_CONFIG_DIR, token: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN, validation: process.env.CC_HAHA_MIGRATION_VALIDATION }
  process.env.CLAUDE_CONFIG_DIR = root
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'isolated-token'
  process.env.CC_HAHA_MIGRATION_VALIDATION = '1'
  let server: ReturnType<typeof startServer> | undefined
  try {
    await mkdir(join(root, 'projects'))
    await writeFile(join(root, 'settings.json'), '{"unknownOwnerSetting":true}\n')
    await writeFile(join(root, '.config.json'), '{"unknownGlobalOwnerSetting":true}\n')
    getGlobalClaudeFile.cache.clear()
    const sessionId = 'e13ccaf8-c354-491d-a20e-7ce9f5802720'
    await mkdir(join(root, 'projects', 'saved-project'))
    await writeFile(join(root, 'projects', 'saved-project', `${sessionId}.jsonl`), JSON.stringify({ type: 'user', uuid: 'saved-message', sessionId, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Saved conversation' } }) + '\n')
    const readSession = spyOn(sessionService, 'getSessionHistoryPage')
    const indexStart = spyOn(localIndexCoordinator, 'start')
    const cronStart = spyOn(cronScheduler, 'start')
    server = startServer(0)
    const base = `http://127.0.0.1:${server.port}`
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/sessions`)).status).toBe(503)
    expect((await fetch(`${base}/proxy/anything`, { method: 'POST' })).status).toBe(503)
    expect((await fetch(`${base}/sdk/anything`)).status).toBe(503)
    expect((await fetch(`${base}/api/runtime/migration/validate`)).status).toBe(403)
    const response = await fetch(`${base}/api/runtime/migration/validate`, { headers: { Authorization: 'Bearer isolated-token' } })
    expect(await response.json()).toEqual({ valid: true })
    expect(readSession).toHaveBeenCalledWith(sessionId, { limit: 1, projectContext: false })
    expect(indexStart).not.toHaveBeenCalled()
    expect(cronStart).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('{"unknownOwnerSetting":true}\n')
    expect((await readdir(root)).sort()).toEqual(['.config.json', 'projects', 'settings.json'])
    await writeFile(join(root, '.config.json'), '{"invalidGlobalConfig":')
    expect((await fetch(`${base}/api/runtime/migration/validate`, { headers: { Authorization: 'Bearer isolated-token' } })).status).toBe(409)
    await rm(join(root, '.config.json'))
    await writeFile(join(root, '.claude.json'), '{"effectiveGlobalOwnerSetting":true}\n')
    getGlobalClaudeFile.cache.clear()
    expect((await fetch(`${base}/api/runtime/migration/validate`, { headers: { Authorization: 'Bearer isolated-token' } })).status).toBe(200)
  } finally {
    server?.stop(true)
    migrationMaintenance.resetForTests()
    mock.restore()
    getGlobalClaudeFile.cache.clear()
    for (const [key, value] of [['CLAUDE_CONFIG_DIR', old.root], ['CC_HAHA_LOCAL_ACCESS_TOKEN', old.token], ['CC_HAHA_MIGRATION_VALIDATION', old.validation]]) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('quiescence closes admission before graceful CLI drain and waits for disconnected handler writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-drain-'))
  const oldRoot = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const external = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  await mkdir(join(root, 'sessions'))
  await writeFile(join(root, 'sessions', `${external.pid}.json`), JSON.stringify({ pid: external.pid }))
  const calls: string[] = []
  let release!: () => void
  migrationMaintenance.track(new Promise<void>(resolve => { release = resolve }).then(() => { calls.push('pending-handler-saved') }))
  spyOn(conversationService, 'getProcessIds').mockReturnValue([])
  spyOn(cronScheduler, 'getProcessIds').mockReturnValue([])
  spyOn(cronScheduler, 'stopAndWait').mockResolvedValue()
  spyOn(teamWatcher, 'stopAndWait').mockResolvedValue()
  spyOn(conversationService, 'stopForMigration').mockImplementation(async () => {
    expect(migrationMaintenance.isActive).toBe(true)
    calls.push('cli-drain')
    release()
  })
  spyOn(localIndexCoordinator, 'stop').mockImplementation(async () => { calls.push('index-closed') })
  spyOn(searchContentCoordinator, 'stop').mockResolvedValue()
  spyOn(diagnosticsService, 'drainForMigration').mockImplementation(async () => { calls.push('diagnostics-drained') })
  try {
    await expect(quiesceServerRuntimeForMigration()).rejects.toThrow('Close external CLI')
    expect(calls).toEqual([])
    await quiesceServerRuntimeForRecovery()
    expect(calls).toEqual(['cli-drain', 'pending-handler-saved', 'index-closed', 'diagnostics-drained'])
    await expect(conversationService.startSession('blocked', root, 'ws://127.0.0.1')).rejects.toThrow('Data migration')
  } finally {
    external.kill()
    await external.exited
    mock.restore()
    migrationMaintenance.resetForTests()
    if (oldRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldRoot
    await rm(root, { recursive: true, force: true })
  }
})
