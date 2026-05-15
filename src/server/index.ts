/**
 * Claude Code Desktop App — HTTP + WebSocket Server
 *
 * 为桌面端 UI 提供 REST API 和 WebSocket 实时通信。
 * 读写与 CLI 完全相同的文件系统，确保 CLI/UI 数据互通。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { configureWorkspaceRoot } from './services/workspaceRootInstance.js'
import { handleApiRequest } from './router.js'
import { handleWebSocket, type WebSocketData } from './ws/handler.js'
import { teamWatcher } from './services/teamWatcher.js'
import { cronScheduler } from './services/cronScheduler.js'
import { handleProxyRequest } from './proxy/handler.js'
import { ProviderService } from './services/providerService.js'
import { ensureDesktopCliLauncherInstalled } from './services/desktopCliLauncherService.js'
import { enableConfigs } from '../utils/config.js'
import { diagnosticsService } from './services/diagnosticsService.js'
import { ensurePersistentStorageUpgraded } from './services/persistentStorageMigrations.js'
import { handleStaticH5Request } from './staticH5.js'

function readArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

function hasArgFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag)
}

function resolveServerOptions() {
  const portArg = readArgValue('--port')
  const port = Number.parseInt(portArg || process.env.SERVER_PORT || '3456', 10)
  const host = readArgValue('--host') || process.env.SERVER_HOST || '127.0.0.1'
  const cliPath = readArgValue('--cli-path')
  const authRequired = hasArgFlag('--auth-required')

  if (cliPath) {
    process.env.CLAUDE_CLI_PATH = cliPath
  }

  return { port, host, authRequired }
}

const SERVER_OPTIONS = resolveServerOptions()
const PORT = SERVER_OPTIONS.port
const HOST = SERVER_OPTIONS.host

export function startServer(port = PORT, host = HOST) {
  enableConfigs()
  const workspacesDir =
    process.env.CC_HAHA_WORKSPACES_ROOT ||
    path.resolve(process.cwd(), 'workspaces')
  const workspaceRoot = configureWorkspaceRoot(workspacesDir)
  fs.mkdirSync(workspaceRoot.getRoot(), { recursive: true })
  console.log(`[Server] Workspace root: ${workspaceRoot.getRoot()}`)
  diagnosticsService.installConsoleCapture()
  diagnosticsService.installProcessCapture()
  ProviderService.setServerPort(port)
  const localConnectHost =
    host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost'
      ? '127.0.0.1'
      : host

  const server = Bun.serve<WebSocketData>({
    port,
    hostname: host,
    idleTimeout: 60,

    async fetch(req, server) {
      await ensurePersistentStorageUpgraded()
      const url = new URL(req.url)

      // Handle CORS preflight (permissive)
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': req.headers.get('Origin') ?? '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
          },
        })
      }

      // WebSocket upgrade for client connections
      if (url.pathname.startsWith('/ws/')) {
        const sessionId = url.pathname.split('/').pop() || ''
        if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
          return new Response('Invalid session ID', { status: 400 })
        }
        const upgraded = server.upgrade(req, {
          data: {
            sessionId,
            connectedAt: Date.now(),
            channel: 'client',
            sdkToken: null,
            serverPort: port,
            serverHost: localConnectHost,
          },
        })
        if (upgraded) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // Internal SDK WebSocket used by the spawned Claude CLI.
      if (url.pathname.startsWith('/sdk/')) {
        const sessionId = url.pathname.split('/').pop() || ''
        if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
          return new Response('Invalid session ID', { status: 400 })
        }
        const upgraded = server.upgrade(req, {
          data: {
            sessionId,
            connectedAt: Date.now(),
            channel: 'sdk',
            sdkToken: url.searchParams.get('token'),
            serverPort: port,
            serverHost: localConnectHost,
          },
        })
        if (upgraded) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // REST API
      if (url.pathname.startsWith('/api/')) {
        try {
          const response = await handleApiRequest(req, url)
          return response
        } catch (error) {
          void diagnosticsService.recordEvent({
            type: 'api_request_failed',
            severity: 'error',
            summary: error instanceof Error ? error.message : String(error),
            details: { path: url.pathname, method: req.method, error },
          })
          console.error('[Server] API error:', error)
          return Response.json(
            { error: 'Internal server error' },
            { status: 500 },
          )
        }
      }

      // Proxy — protocol-translating reverse proxy for OpenAI-compatible APIs
      if (url.pathname.startsWith('/proxy/')) {
        try {
          const response = await handleProxyRequest(req, url)
          return response
        } catch (error) {
          void diagnosticsService.recordEvent({
            type: 'proxy_request_failed',
            severity: 'error',
            summary: error instanceof Error ? error.message : String(error),
            details: { path: url.pathname, method: req.method, error },
          })
          console.error('[Server] Proxy error:', error)
          return Response.json(
            { type: 'error', error: { type: 'api_error', message: 'Internal proxy error' } },
            { status: 500 },
          )
        }
      }

      // Health check
      if (url.pathname === '/health') {
        return Response.json(
          { status: 'ok', timestamp: new Date().toISOString() },
        )
      }

      // Static H5 shell/assets are non-secret bootstrap content and must load
      // before the browser can read the QR token; API/proxy/ws stay protected above.
      const staticResponse = await handleStaticH5Request(req, url)
      if (staticResponse) {
        return staticResponse
      }

      return new Response('Not Found', { status: 404 })
    },

    websocket: handleWebSocket,
  })

  // Start watching ~/.claude/teams/ for real-time WebSocket push
  teamWatcher.start()

  // Start the cron scheduler to execute scheduled tasks
  cronScheduler.start()

  void ensureDesktopCliLauncherInstalled().catch((error) => {
    console.error(
      '[desktop-cli-launcher] failed to install bundled launcher:',
      error instanceof Error ? error.message : error,
    )
  })

  console.log(`[Server] Claude Code API server running at http://${host}:${port}`)
  return server
}

// ─── Graceful shutdown: kill all CLI subprocesses on exit ────────────────────
import { conversationService } from './services/conversationService.js'

function cleanupAllSessions() {
  const active = conversationService.getActiveSessions()
  if (active.length > 0) {
    console.log(`[Server] Shutting down — killing ${active.length} CLI subprocess(es)`)
    for (const sessionId of active) {
      conversationService.stopSession(sessionId)
    }
  }
}

process.on('SIGTERM', () => {
  console.log('[Server] Received SIGTERM')
  cleanupAllSessions()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[Server] Received SIGINT')
  cleanupAllSessions()
  process.exit(0)
})

process.on('exit', () => {
  cleanupAllSessions()
})

// Direct execution
if (import.meta.main) {
  startServer()
}
