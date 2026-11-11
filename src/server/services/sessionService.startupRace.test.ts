import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { DesktopUiPreferencesService } from './desktopUiPreferencesService.js'
import { prepareOfficialAgentSdkPlaceholder } from './officialAgentSdkPlaceholder.js'
import { SessionService } from './sessionService.js'

describe('Official Agent SDK transcript startup', () => {
  let directory: string
  let canonical: string
  let staged: string
  let sessionId: string
  let service: SessionService
  let oldHome: string | undefined
  let oldConfig: string | undefined
  let contents: string

  beforeEach(async () => {
    directory = await fs.realpath(await mkdtemp(join(tmpdir(), 'session-startup-race-')))
    oldHome = process.env.HOME
    oldConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = directory
    process.env.CLAUDE_CONFIG_DIR = directory
    resetSettingsCache()
    sessionId = crypto.randomUUID()
    canonical = join(directory, 'projects', sanitizePath(directory), `${sessionId}.jsonl`)
    staged = join(directory, 'projects', 'cc-haha-sdk-startup', `${sessionId}.jsonl`)
    await mkdir(join(directory, 'projects', sanitizePath(directory)), { recursive: true })
    contents = [
      { type: 'session-meta', workDir: directory, runtimeProviderId: 'fixture-provider', runtimeModelId: 'fixture-haiku', effortLevel: 'low', permissionMode: 'default', unknownField: { retained: true } },
      { type: 'custom-title', customTitle: 'Keep the original title' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n'
    await writeFile(canonical, contents)
    service = new SessionService()
  })

  afterEach(async () => {
    mock.restore()
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    resetSettingsCache()
    await rm(directory, { recursive: true, force: true })
  })

  function prepare() {
    return prepareOfficialAgentSdkPlaceholder({ configDir: directory, workDir: directory, sessionId })
  }

  /** Pause at the real lookup/read seam, not at a fabricated ENOENT exception. */
  function relocateAfterLookup(relocate: () => Promise<unknown>) {
    const original = service.findSessionFile.bind(service)
    let moved = false
    return spyOn(service, 'findSessionFile').mockImplementation(async id => {
      const found = await original(id)
      if (!moved && found) {
        moved = true
        await relocate()
      }
      return found
    })
  }

  const readers = [
    ['launch information', async () => {
      expect(await service.getSessionLaunchInfo(sessionId)).toMatchObject({
        workDir: directory, runtimeProviderId: 'fixture-provider',
        runtimeModelId: 'fixture-haiku', effortLevel: 'low',
        permissionMode: 'default', customTitle: 'Keep the original title',
        transcriptMessageCount: 0,
      })
    }],
    ['custom title', async () => {
      expect(await service.getCustomTitle(sessionId)).toBe('Keep the original title')
    }],
    ['working directory', async () => {
      expect(await service.getSessionWorkDir(sessionId)).toBe(directory)
    }],
  ] as const

  for (const [name, read] of readers) {
    test(`${name} follows the placeholder when SDK startup moves it after lookup`, async () => {
      const lookup = relocateAfterLookup(prepare)
      await read()
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(await readFile(staged, 'utf8')).toBe(contents)
      await expect(readFile(canonical)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    test(`${name} follows the placeholder when SDK initialization restores it after lookup`, async () => {
      const restore = await prepare()
      const lookup = relocateAfterLookup(restore)
      await read()
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(await readFile(canonical, 'utf8')).toBe(contents)
      await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  test('launch information follows both relocation phases and includes the native transcript', async () => {
    const original = service.findSessionFile.bind(service)
    let restore: (() => Promise<void>) | undefined
    let calls = 0
    spyOn(service, 'findSessionFile').mockImplementation(async id => {
      const found = await original(id)
      if (++calls === 1) {
        restore = await prepare()
      } else if (calls === 2) {
        await writeFile(canonical, JSON.stringify({
          type: 'user', uuid: 'native-user', message: { role: 'user', content: 'Native transcript' },
        }) + '\n')
        await restore!()
      }
      return found
    })
    expect(await service.getSessionLaunchInfo(sessionId)).toMatchObject({
      filePath: canonical, workDir: directory, runtimeModelId: 'fixture-haiku',
      customTitle: 'Keep the original title', transcriptMessageCount: 1,
    })
    expect(calls).toBe(3)
    expect(await readFile(canonical, 'utf8')).toContain('Native transcript')
  })

  test('a session deleted after lookup is absent and is never recreated', async () => {
    const lookup = relocateAfterLookup(() => unlink(canonical))
    expect(await service.getSessionLaunchInfo(sessionId)).toBeNull()
    expect(lookup).toHaveBeenCalledTimes(2)
    await expect(readFile(canonical)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('non-transient metadata failures are not suppressed or retried', async () => {
    const error = Object.assign(new Error('fixture access denied'), { code: 'EACCES' })
    const projection = spyOn(service as any, 'getMetadataProjection').mockRejectedValue(error)
    await expect(service.getSessionLaunchInfo(sessionId)).rejects.toBe(error)
    expect(projection).toHaveBeenCalledTimes(1)
  })

  test('persistent metadata churn remains an explicit bounded failure', async () => {
    const error = Object.assign(new Error('fixture keeps relocating'), { code: 'ENOENT' })
    const projection = spyOn(service as any, 'getMetadataProjection').mockRejectedValue(error)
    await expect(service.getSessionLaunchInfo(sessionId)).rejects.toBe(error)
    expect(projection).toHaveBeenCalledTimes(3)
  })

  test('the first long WebSocket prompt survives concurrent SDK startup and is delivered exactly once', async () => {
    const { sessionService } = await import('./sessionService.js')
    const { conversationService } = await import('./conversationService.js')
    const {
      handleWebSocket, __registerPendingSessionStartupForTests, __resetWebSocketHandlerStateForTests,
    } = await import('../ws/handler.js')
    const sent: any[] = []
    const socket = {
      data: { sessionId, connectedAt: Date.now(), channel: 'client', sdkToken: null, serverHost: '127.0.0.1', serverPort: 0 },
      send: (data: string) => { sent.push(JSON.parse(data)) },
      close() {},
    } as Parameters<typeof handleWebSocket.open>[0]
    const prompt = '保留我的完整提示词。\n'.repeat(1_000) + '最后一行：不要丢失。'
    let finishStartup!: () => void
    const startup = new Promise<void>(resolve => { finishStartup = resolve })
    let ready = false
    let restore: (() => Promise<void>) | undefined
    let finishMove!: () => void
    const moved = new Promise<void>(resolve => { finishMove = resolve })
    let finishDispatch!: () => void
    const dispatched = new Promise<void>(resolve => { finishDispatch = resolve })
    try {
      spyOn(sessionService, 'getCustomTitle').mockResolvedValue(null)
      spyOn(sessionService, 'getSessionLaunchInfo').mockImplementation(id => service.getSessionLaunchInfo(id))
      spyOn(conversationService, 'hasSession').mockImplementation(() => ready)
      spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
      spyOn(conversationService, 'onOutput').mockImplementation(() => {})
      spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
      const sendUser = spyOn(conversationService, 'sendMessage').mockImplementation(async (...args) => {
        args[3]?.onCommitted?.()
        finishDispatch()
        return true
      })
      relocateAfterLookup(async () => {
        restore = await prepare()
        finishMove()
      })
      handleWebSocket.open(socket)
      __registerPendingSessionStartupForTests(sessionId, startup)
      handleWebSocket.message(socket, JSON.stringify({ type: 'user_message', content: prompt }))
      await moved
      // Native initialization has not yet completed; dispatch must wait for the
      // existing startup even after the title metadata has followed the move.
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(sendUser).not.toHaveBeenCalled()
      await restore!()
      ready = true
      finishStartup()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          dispatched,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('First prompt was never dispatched')), 2_000)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      expect(sendUser).toHaveBeenCalledTimes(1)
      expect(sendUser.mock.calls[0]?.[1]).toBe(prompt)
      expect(sent.filter(message => message.type === 'error')).toEqual([])
      expect(await readFile(canonical, 'utf8')).toStartWith(contents)
      expect(await service.getCustomTitle(sessionId)).toBe('Keep the original title')
    } finally {
      finishStartup()
      __resetWebSocketHandlerStateForTests()
    }
  })
})

describe('Worktree startup metadata transfer', () => {
  let root: string
  let originalEnv: NodeJS.ProcessEnv
  beforeEach(async () => {
    originalEnv = { ...process.env }
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'session-worktree-race-')))
    const env = createSandboxedTestEnvironment(root)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, env)
    resetSettingsCache()
  })
  afterEach(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    resetSettingsCache()
    await fs.rm(root, { recursive: true, force: true })
  })

  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }

  test('worktree cleanup waits for an in-flight metadata transfer across service instances', async () => {
    const main = join(root, 'main')
    const worktree = join(main, '.claude/worktrees/fixture')
    const extra = join(root, 'extra 数据')
    await fs.mkdir(worktree, { recursive: true })
    await fs.mkdir(extra)
    await new DesktopUiPreferencesService().updateProjectDirectories({ workDir: main, additionalDirectories: [extra] })
    const setup = new SessionService()
    const created = await setup.createSession(main)
    await setup.appendSessionMetadata(created.sessionId, {
      workDir: main, customTitle: 'Keep this collaboration title',
      repository: { requestedWorkDir: main, repoRoot: main, branch: 'main', worktree: true, baseRef: 'main', worktreePath: worktree },
    })
    const placeholder = (await setup.getSessionLaunchInfo(created.sessionId))!.filePath
    const target = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(worktree), created.sessionId + '.jsonl')
    await fs.mkdir(join(target, '..'), { recursive: true })
    await fs.writeFile(target, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, sessionId: created.sessionId, cwd: worktree, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'persisted worktree turn' }] } }) + '\n')

    const startup = new SessionService() as any
    const entered = deferred()
    const release = deferred()
    const read = startup.getMetadataProjection
    let held = false
    startup.getMetadataProjection = async function (filePath: string, projectDir: string) {
      if (!held && filePath === placeholder) {
        held = true
        entered.resolve()
        await release.promise
      }
      return read.call(this, filePath, projectDir)
    }
    const write = startup.appendSessionMetadata(created.sessionId, { workDir: worktree })
    await entered.promise
    const readdir = fs.readdir
    let cleanupStarted = false
    const readdirSpy = spyOn(fs, 'readdir').mockImplementation(((...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === join(process.env.CLAUDE_CONFIG_DIR!, 'projects') && (args[1] as { withFileTypes?: boolean })?.withFileTypes) cleanupStarted = true
      return readdir(...args)
    }) as typeof fs.readdir)
    const cleanup = new SessionService().deletePlaceholderSessionFiles(created.sessionId, worktree)
    try {
      // Let an overlapping cleanup finish before resuming the metadata read.
      // A serialized cleanup may instead remain queued until the read is released.
      if (cleanupStarted) await cleanup
    } finally {
      release.resolve()
      startup.getMetadataProjection = read
      await Promise.allSettled([write, cleanup])
      readdirSpy.mockRestore()
    }
    await write
    expect(await cleanup).toBe(1)
    const launch = await new SessionService().getSessionLaunchInfo(created.sessionId)
    expect(launch).toMatchObject({ filePath: target, workDir: worktree, additionalDirectories: [extra], customTitle: 'Keep this collaboration title' })
    expect(await fs.stat(placeholder).then(() => true, () => false)).toBe(false)
    const projects = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
    const survivors = (await Promise.all((await fs.readdir(projects)).map(async project => {
      const candidate = join(projects, project, created.sessionId + '.jsonl')
      return await fs.stat(candidate).then(() => candidate, () => null)
    }))).filter(Boolean)
    expect(survivors).toEqual([target])
    const records = (await fs.readFile(target, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records).toContainEqual(expect.objectContaining({ type: 'session-meta', additionalDirectories: [extra] }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'custom-title', customTitle: 'Keep this collaboration title' }))
    expect(records).toContainEqual(expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [{ type: 'text', text: 'persisted worktree turn' }] }) }))
  })
})
