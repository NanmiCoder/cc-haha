import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Keep the shared mock SDK's permission/team behavior. Only this browser lane
// adds save-control receipts; this fixture does not emulate an MCP tool pool.
const NativeWebSocket = globalThis.WebSocket
class McpSaveSmokeWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols)
    this.addEventListener('message', (event) => {
      try {
        for (const line of String(event.data).split('\n').filter(Boolean)) {
          const message = JSON.parse(line)
          const name = message.request?.serverName
          if (message.type !== 'control_request' || message.request?.subtype !== 'mcp_reconnect' ||
            !['mcp_save_success', 'mcp_save_failure'].includes(name)) continue
          const auditPath = process.env.MOCK_SDK_MCP_SAVE_AUDIT
          if (!auditPath) throw new Error('MCP save smoke is missing its isolated audit path')
          const persisted = JSON.parse(readFileSync(join(process.cwd(), '.mcp.json'), 'utf8'))
          const failed = name === 'mcp_save_failure'
          appendFileSync(auditPath, JSON.stringify({
            name, requestId: message.request_id, cwd: process.cwd(),
            config: persisted.mcpServers?.[name], outcome: failed ? 'failed' : 'applied',
          }) + '\n')
          this.send(JSON.stringify({
            type: 'control_response',
            response: failed
              ? { subtype: 'error', request_id: message.request_id, error: 'MCP save smoke control rejection' }
              : { subtype: 'success', request_id: message.request_id, response: {} },
          }) + '\n')
        }
      } catch (error) {
        console.error('MCP save smoke child failed:', error)
        process.exit(1)
      }
    })
  }
}

globalThis.WebSocket = McpSaveSmokeWebSocket as typeof WebSocket
await import('../../../../src/server/__tests__/fixtures/mock-sdk-cli.ts')
