#!/usr/bin/env node

/**
 * sce-editor-bridge MCP Server
 *
 * Bridges cc-haha's stdio MCP protocol to the SCE Editor's HTTP MCP endpoint.
 * Zero external dependencies — uses Node.js built-in fetch + raw JSON-RPC over stdio.
 *
 * Architecture:
 *   cc-haha (stdio JSON-RPC) → this bridge → SCE Editor HTTP MCP (127.0.0.1:port)
 *
 * All upstream tool names are prefixed with `spark2_` to avoid collisions.
 * Gracefully returns errors when the editor is not running.
 */

import { createInterface } from 'readline'
import { connect } from 'net'

// ─── Config ──────────────────────────────────────────────────────────────────

const SCE_MCP_PORT = parseInt(process.env.SCE_MCP_PORT || '8765', 10)
const SCE_RUNTIME_MCP_PORT = parseInt(process.env.SCE_RUNTIME_MCP_PORT || '18765', 10)
const SCE_PROJECT_DIR = process.env.SCE_PROJECT_DIR || ''
const TOOL_PREFIX = 'spark2_'
const TIMEOUT_MS = 30_000

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function editorBaseUrl() {
  return `http://127.0.0.1:${SCE_MCP_PORT}`
}

function editorNotRunningError() {
  return {
    content: [{
      type: 'text',
      text: `SCE 编辑器 MCP 未响应 (127.0.0.1:${SCE_MCP_PORT})。\n\n请确认：\n1. 已启动星火编辑器\n2. 已打开项目${SCE_PROJECT_DIR ? ` (${SCE_PROJECT_DIR})` : ''}\n3. 编辑器 MCP 端口为 ${SCE_MCP_PORT}\n\n如果使用 --mcp-port 启动编辑器，请在插件配置中设置对应端口。`,
    }],
    isError: true,
  }
}

// ─── Upstream tool discovery ─────────────────────────────────────────────────

let cachedTools = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 10_000

async function fetchUpstreamTools() {
  const now = Date.now()
  if (cachedTools && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedTools
  }

  try {
    const res = await fetchWithTimeout(editorBaseUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }, TIMEOUT_MS)

    if (!res.ok) {
      cachedTools = null
      return null
    }

    const data = await res.json()
    if (data.result?.tools) {
      cachedTools = data.result.tools
      cacheTimestamp = now
      return cachedTools
    }
    return null
  } catch {
    cachedTools = null
    return null
  }
}

function prefixTools(tools) {
  if (!tools) return []
  return tools.map(tool => ({
    ...tool,
    name: `${TOOL_PREFIX}${tool.name}`,
    description: tool.description ? `[SCE Editor] ${tool.description}` : tool.description,
  }))
}

// ─── Upstream tool call ──────────────────────────────────────────────────────

async function callUpstreamTool(toolName, args) {
  try {
    const res = await fetchWithTimeout(editorBaseUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    }, TIMEOUT_MS)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        content: [{ type: 'text', text: `SCE Editor HTTP ${res.status}: ${text.slice(0, 500)}` }],
        isError: true,
      }
    }

    const data = await res.json()
    if (data.error) {
      return {
        content: [{ type: 'text', text: `SCE MCP error: ${data.error.message || JSON.stringify(data.error)}` }],
        isError: true,
      }
    }

    return data.result || { content: [{ type: 'text', text: 'OK (no result body)' }], isError: false }
  } catch (err) {
    if (err.name === 'AbortError' || err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
      return editorNotRunningError()
    }
    return {
      content: [{ type: 'text', text: `Bridge error: ${err.message}` }],
      isError: true,
    }
  }
}

// ─── Runtime MCP passthrough ─────────────────────────────────────────────────

async function callRuntimeTool(innerTool, innerArgs) {
  return new Promise((resolve) => {
    const socket = connect(SCE_RUNTIME_MCP_PORT, '127.0.0.1')
    let data = ''
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        socket.destroy()
        resolve({
          content: [{ type: 'text', text: `Runtime MCP 超时 (127.0.0.1:${SCE_RUNTIME_MCP_PORT})。请确认游戏正在调试运行中。` }],
          isError: true,
        })
      }
    }, TIMEOUT_MS)

    socket.on('connect', () => {
      const payload = JSON.stringify({ tool: innerTool, arguments: innerArgs })
      socket.write(payload + '|*|\n')
    })

    socket.on('data', (chunk) => {
      data += chunk.toString()
      const endIdx = data.indexOf('|*|\n')
      if (endIdx !== -1) {
        const msg = data.slice(0, endIdx)
        clearTimeout(timeout)
        resolved = true
        socket.destroy()
        try {
          const result = JSON.parse(msg)
          resolve({
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
            isError: false,
          })
        } catch {
          resolve({
            content: [{ type: 'text', text: msg }],
            isError: false,
          })
        }
      }
    })

    socket.on('error', (err) => {
      if (!resolved) {
        clearTimeout(timeout)
        resolved = true
        resolve({
          content: [{
            type: 'text',
            text: `Runtime MCP 连接失败 (127.0.0.1:${SCE_RUNTIME_MCP_PORT}): ${err.message}\n\n请确认游戏正在调试运行中，Runtime MCP 已启动。`,
          }],
          isError: true,
        })
      }
    })
  })
}

// ─── Built-in tools ──────────────────────────────────────────────────────────

const BUILTIN_TOOLS = [
  {
    name: `${TOOL_PREFIX}status`,
    description: '[SCE Bridge] 检查 SCE 编辑器 MCP 连接状态和可用工具数量',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: `${TOOL_PREFIX}runtime_call_tool`,
    description: '[SCE Bridge] 通过 Runtime MCP TCP 桥接调用运行时工具（需要游戏正在调试运行）',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '运行时工具名称（如 debug.capture_screenshot、ui.snapshot）' },
        arguments: { type: 'object', description: '工具参数', default: {} },
      },
      required: ['tool'],
    },
  },
]

async function handleBuiltinTool(name, args) {
  if (name === `${TOOL_PREFIX}status`) {
    const tools = await fetchUpstreamTools()
    if (tools) {
      return {
        content: [{
          type: 'text',
          text: `SCE 编辑器 MCP 已连接 (127.0.0.1:${SCE_MCP_PORT})\n可用工具: ${tools.length}\n项目目录: ${SCE_PROJECT_DIR || '(未配置)'}`,
        }],
        isError: false,
      }
    }
    return editorNotRunningError()
  }

  if (name === `${TOOL_PREFIX}runtime_call_tool`) {
    if (!args.tool) {
      return { content: [{ type: 'text', text: 'Error: tool 参数为必填' }], isError: true }
    }
    return callRuntimeTool(args.tool, args.arguments || {})
  }

  return null
}

// ─── Main tool handler ───────────────────────────────────────────────────────

async function handleToolCall(name, args) {
  // Built-in tools
  const builtinResult = await handleBuiltinTool(name, args)
  if (builtinResult) return builtinResult

  // Upstream proxy: strip prefix and forward
  if (!name.startsWith(TOOL_PREFIX)) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }

  const upstreamName = name.slice(TOOL_PREFIX.length)
  return callUpstreamTool(upstreamName, args)
}

// ─── Stdio JSON-RPC transport ────────────────────────────────────────────────

const MAX_BUFFER_SIZE = 1024 * 1024

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function handleMessage(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sce-editor-mcp', version: '1.0.0' },
      })
      break

    case 'notifications/initialized':
      break

    case 'tools/list': {
      const upstream = await fetchUpstreamTools()
      const tools = [...BUILTIN_TOOLS, ...prefixTools(upstream)]
      sendResponse(id, { tools })
      break
    }

    case 'tools/call': {
      try {
        const result = await handleToolCall(params.name, params.arguments || {})
        sendResponse(id, result)
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Bridge internal error: ${err.message}` }],
          isError: true,
        })
      }
      break
    }

    case 'ping':
      sendResponse(id, {})
      break

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`)
      }
      break
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const rl = createInterface({ input: process.stdin })

  let buffer = ''
  const pending = new Set()

  rl.on('line', (line) => {
    buffer += line
    if (buffer.length > MAX_BUFFER_SIZE) {
      console.error('[sce-editor-bridge] Buffer overflow (>1MB), resetting')
      buffer = ''
      return
    }
    try {
      const msg = JSON.parse(buffer)
      buffer = ''
      const p = handleMessage(msg).catch(err => {
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, `Internal error: ${err.message}`)
        }
      }).finally(() => pending.delete(p))
      pending.add(p)
    } catch {
      // Incomplete JSON, wait for more lines
    }
  })

  rl.on('close', async () => {
    if (pending.size > 0) {
      await Promise.allSettled([...pending])
    }
    process.exit(0)
  })

  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

main()
