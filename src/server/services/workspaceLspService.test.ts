import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LSPServerManager } from '../../services/lsp/LSPServerManager.js'
import type { LSPServerInstance } from '../../services/lsp/LSPServerInstance.js'
import type { ScopedLspServerConfig } from '../../services/lsp/types.js'
import {
  clearWorkspaceLspDiagnostics,
  publishWorkspaceLspDiagnostics,
  WorkspaceLspService,
} from './workspaceLspService.js'

type Notification = { method: string; params: unknown }

function createFakeManager(captured: { servers?: Record<string, ScopedLspServerConfig>; notifications: Notification[] }) {
  return (servers: Record<string, ScopedLspServerConfig>): LSPServerManager => {
    captured.servers = servers
    const handlers = new Map<string, (params: unknown) => void>()
    const openUris = new Set<string>()
    const instance: LSPServerInstance = {
      name: Object.keys(servers)[0] ?? 'fake',
      config: Object.values(servers)[0]!,
      state: 'running',
      startTime: new Date(),
      lastError: undefined,
      restartCount: 0,
      async start() {},
      async stop() {},
      async restart() {},
      isHealthy: () => true,
      async sendRequest() { return undefined as never },
      async sendNotification(method, params) {
        captured.notifications.push({ method, params })
      },
      onNotification(method, handler) {
        handlers.set(method, handler)
      },
      onRequest() {},
    }
    return {
      async initialize() {},
      async shutdown() {},
      getServerForFile: (filePath) => servers[Object.keys(servers).find((name) => servers[name]!.extensionToLanguage[path.extname(filePath)]) ?? ''] ? instance : undefined,
      ensureServerStarted: async () => instance,
      sendRequest: async () => undefined,
      getAllServers: () => new Map([[instance.name, instance]]),
      openFile: async (filePath, content) => {
        const uri = pathToFileURL(filePath).href
        if (openUris.has(uri)) return
        openUris.add(uri)
        await instance.sendNotification('textDocument/didOpen', { textDocument: { uri, version: 1, text: content } })
      },
      changeFile: async (filePath, content) => instance.sendNotification('textDocument/didChange', { textDocument: { uri: pathToFileURL(filePath).href, version: 2 }, contentChanges: [{ text: content }] }),
      saveFile: async (filePath) => instance.sendNotification('textDocument/didSave', { textDocument: { uri: pathToFileURL(filePath).href } }),
      closeFile: async () => {},
      isFileOpen: (filePath) => openUris.has(pathToFileURL(filePath).href),
    }
  }
}

describe('WorkspaceLspService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-lsp-'))
    await fs.mkdir(path.join(tmpDir, 'src'))
    await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'const x = 1\n')
    clearWorkspaceLspDiagnostics()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects paths outside the workspace', async () => {
    const captured = { notifications: [] as Notification[] }
    const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })
    await expect(service.getDiagnostics('s1', tmpDir, '../outside.ts')).rejects.toThrow(/outside workspace/)
  })

  it('supports custom absolute LSP path with args array and extension mapping', async () => {
    const customPath = path.join(tmpDir, 'my language server.cmd')
    await fs.writeFile(customPath, '')
    const captured = { notifications: [] as Notification[] }
    const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })
    await service.restart('s1', tmpDir, 'src/app.ts', {
      server: {
        path: customPath,
        args: ['--stdio'],
        extensionToLanguage: { '.ts': 'typescript' },
      },
    })
    const custom = captured.servers?.['custom:lsp']
    expect(custom?.command).toBe(customPath)
    expect(custom?.args).toEqual(['--stdio'])
    expect(custom?.extensionToLanguage['.ts']).toBe('typescript')
  })

  it('prefers custom LSP config over presets for overlapping extensions', async () => {
    const customPath = path.join(tmpDir, 'custom ts server.cmd')
    await fs.writeFile(customPath, '')
    const captured = { notifications: [] as Notification[] }
    const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })

    const state = await service.restart('s1', tmpDir, 'src/app.ts', {
      server: {
        name: 'custom:typescript',
        path: customPath,
        args: ['--stdio'],
        extensionToLanguage: { '.ts': 'typescript' },
      },
    })

    expect(state.serverName).toBe('custom:typescript')
    expect(state.command).toBe(customPath)
    expect(captured.servers?.['custom:typescript']?.extensionToLanguage['.ts']).toBe('typescript')
    expect(captured.servers?.['preset:typescript-language-server']).toBeDefined()
    expect(captured.servers?.['preset:typescript-language-server']?.extensionToLanguage['.ts']).toBeUndefined()
  })

  it('returns cached diagnostics published for the file URI', async () => {
    const captured = { notifications: [] as Notification[] }
    const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })
    const uri = pathToFileURL(path.join(tmpDir, 'src', 'app.ts')).href
    publishWorkspaceLspDiagnostics(uri, [{
      message: 'boom',
      severity: 'Error',
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
    }])
    const result = await service.getDiagnostics('s1', tmpDir, 'src/app.ts')
    expect(result.diagnostics).toMatchObject([{ path: 'src/app.ts', line: 1, column: 7, severity: 'error', message: 'boom' }])
  })

  it('syncs open/change/save without shell command strings', async () => {
    const captured = { notifications: [] as Notification[] }
    const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })
    await service.sync('s1', tmpDir, { path: 'src/app.ts', content: 'const x = 2\n', event: 'open' })
    await service.sync('s1', tmpDir, { path: 'src/app.ts', content: 'const x = 3\n', event: 'change' })
    await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'const x = 3\n')
    await service.sync('s1', tmpDir, { path: 'src/app.ts', event: 'save' })
    expect(captured.notifications.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange',
      'textDocument/didSave',
    ])
  })

  it('sends didChange when opening an already-open document', async () => {
    const captured = { notifications: [] as Notification[] }
    const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })

    await service.sync('s1', tmpDir, { path: 'src/app.ts', content: 'const x = 1\n', event: 'open' })
    await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'const x = 2\n')
    await service.sync('s1', tmpDir, { path: 'src/app.ts', event: 'open' })

    expect(captured.notifications.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
    ])
    expect(captured.notifications[1]?.params).toMatchObject({
      contentChanges: [{ text: 'const x = 2\n' }],
    })
  })

  it('sends didChange before didSave when save includes content', async () => {
    const captured = { notifications: [] as Notification[] }
    const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })

    await service.sync('s1', tmpDir, { path: 'src/app.ts', content: 'const x = 1\n', event: 'open' })
    await service.sync('s1', tmpDir, { path: 'src/app.ts', content: 'const saved = true\n', event: 'save' })

    expect(captured.notifications.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didSave',
    ])
    expect(captured.notifications[1]?.params).toMatchObject({
      contentChanges: [{ text: 'const saved = true\n' }],
    })
  })

  it('rejects symlink targets outside the workspace', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-lsp-outside-'))
    try {
      const linkPath = path.join(tmpDir, 'src', 'outside-link')
      await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

      const captured = { notifications: [] as Notification[] }
      const service = new WorkspaceLspService({ createManager: createFakeManager(captured), waitTimeoutMs: 1 })
      await expect(service.getDiagnostics('s1', tmpDir, 'src/outside-link')).rejects.toThrow(/outside workspace/)
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })
})
