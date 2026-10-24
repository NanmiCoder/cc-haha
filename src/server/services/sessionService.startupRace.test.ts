import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { prepareOfficialAgentSdkPlaceholder } from './officialAgentSdkPlaceholder.js'
import { SessionService } from './sessionService.js'

let directory: string
let canonical: string
let staged: string
let sessionId: string
let service: SessionService
let oldHome: string | undefined
let oldConfig: string | undefined
let contents: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-startup-race-'))
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
    expect(await readFile(canonical, 'utf8')).toBe(contents)
  } finally {
    finishStartup()
    __resetWebSocketHandlerStateForTests()
  }
})
