const args = process.argv.slice(2)

function getArg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function emit(ws: WebSocket, payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload) + '\n')
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractUserText(message: any): string {
  const content = message?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join(' ')
}

const sdkUrl = getArg('--sdk-url')
const sessionId = getArg('--session-id') || crypto.randomUUID()
const initMode = process.env.MOCK_SDK_INIT_MODE || 'on_open'
const initDelayMs = Number(process.env.MOCK_SDK_INIT_DELAY_MS || '0')
const streamDelayMs = Number(process.env.MOCK_SDK_STREAM_DELAY_MS || '0')
const exitAfterOpenMs = Number(process.env.MOCK_SDK_EXIT_AFTER_OPEN_MS || '0')
const exitAfterFirstUserMs = Number(process.env.MOCK_SDK_EXIT_AFTER_FIRST_USER_MS || '0')
const mcpStatusDelayMs = Number(process.env.MOCK_SDK_MCP_STATUS_DELAY_MS || '0')
const permissionModeBehavior = process.env.MOCK_SDK_PERMISSION_MODE_BEHAVIOR || 'confirm'
let initSent = false
let firstUserExitScheduled = false

if (!sdkUrl) {
  console.error('Missing --sdk-url')
  process.exit(1)
}

const ws = new WebSocket(sdkUrl)

function sendInit() {
  if (initSent) return
  initSent = true
  emit(ws, {
    type: 'system',
    subtype: 'init',
    model: 'mock-opus',
    slash_commands: [{ name: 'help', description: 'Show help' }],
    session_id: sessionId,
  })
}

ws.addEventListener('open', () => {
  if (initMode !== 'on_first_user') {
    if (initDelayMs > 0) {
      setTimeout(sendInit, initDelayMs)
    } else {
      sendInit()
    }
  }
  if (exitAfterOpenMs > 0) {
    setTimeout(() => process.exit(1), exitAfterOpenMs)
  }
})

ws.addEventListener('message', (event) => {
  const payload = typeof event.data === 'string' ? event.data : String(event.data)
  const lines = payload.split('\n').map(line => line.trim()).filter(Boolean)

  void (async () => {
    for (const line of lines) {
      const parsed = JSON.parse(line)

      if (parsed.type === 'user') {
        sendInit()
        if (exitAfterFirstUserMs > 0 && !firstUserExitScheduled) {
          firstUserExitScheduled = true
          setTimeout(() => process.exit(1), exitAfterFirstUserMs)
          continue
        }
        const text = extractUserText(parsed)
        const slashCommand = text.trim()
        if (slashCommand === '/cost') {
          emit(ws, {
            type: 'system',
            subtype: 'local_command_output',
            content: 'Total cost: $0.0000\nTotal duration: 0s',
            session_id: sessionId,
          })
          emit(ws, {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Total cost: $0.0000',
            usage: { input_tokens: 0, output_tokens: 0 },
            session_id: sessionId,
          })
          continue
        }
        if (slashCommand === '/context') {
          emit(ws, {
            type: 'system',
            subtype: 'local_command_output',
            content: '## Context Usage\n\n| Type | Tokens |\n| --- | ---: |\n| System prompt | 123 |',
            session_id: sessionId,
          })
          emit(ws, {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Context usage',
            usage: { input_tokens: 0, output_tokens: 0 },
            session_id: sessionId,
          })
          continue
        }
        if (text.includes('trigger api error')) {
          emit(ws, {
            type: 'assistant',
            error: 'invalid_request',
            isApiErrorMessage: true,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Prompt is too long' }],
            },
            session_id: sessionId,
          })
          if (text.includes('then exit')) {
            setTimeout(() => process.exit(1), 10)
            continue
          }
          emit(ws, {
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'Prompt is too long',
            usage: { input_tokens: 0, output_tokens: 0 },
            session_id: sessionId,
          })
          continue
        }
        emit(ws, {
          type: 'stream_event',
          event: { type: 'message_start' },
          session_id: sessionId,
        })
        emit(ws, {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          session_id: sessionId,
        })
        emit(ws, {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Mock thinking...' },
          },
          session_id: sessionId,
        })
        if (streamDelayMs > 0) await delay(streamDelayMs)
        emit(ws, {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `Echo: ${text}` },
          },
          session_id: sessionId,
        })
        if (streamDelayMs > 0) await delay(streamDelayMs)
        emit(ws, {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
          session_id: sessionId,
        })
        emit(ws, {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `Echo: ${text}`,
          usage: { input_tokens: 3, output_tokens: 2 },
          session_id: sessionId,
        })
      }

      if (parsed.type === 'control_request' && parsed.request?.subtype === 'interrupt') {
        emit(ws, {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Interrupted',
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: sessionId,
        })
      }

      if (parsed.type === 'control_request' && parsed.request?.subtype === 'set_permission_mode') {
        if (permissionModeBehavior === 'unavailable') {
          emit(ws, {
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: parsed.request_id,
              error:
                'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
            },
            session_id: sessionId,
          })
          continue
        }
        if (permissionModeBehavior === 'status-before-reject') {
          emit(ws, {
            type: 'system',
            subtype: 'status',
            status: null,
            permissionMode: parsed.request.mode,
            session_id: sessionId,
          })
          emit(ws, {
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: parsed.request_id,
              error: 'mock permission mode rejection',
            },
            session_id: sessionId,
          })
          continue
        }
        if (permissionModeBehavior === 'reject') {
          emit(ws, {
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: parsed.request_id,
              error: 'mock permission mode rejection',
            },
            session_id: sessionId,
          })
          continue
        }

        emit(ws, {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: parsed.request_id,
            response: { mode: parsed.request.mode },
          },
          session_id: sessionId,
        })
        if (permissionModeBehavior === 'confirm') {
          emit(ws, {
            type: 'system',
            subtype: 'status',
            status: null,
            permissionMode: parsed.request.mode,
            session_id: sessionId,
          })
        }
        continue
      }

      if (parsed.type === 'control_request' && parsed.request?.subtype === 'get_session_usage') {
        emit(ws, {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: parsed.request_id,
            response: {
              totalCostUSD: 0.1234,
              costDisplay: '$0.1234',
              hasUnknownModelCost: false,
              totalAPIDuration: 4,
              totalDuration: 43,
              totalLinesAdded: 0,
              totalLinesRemoved: 0,
              totalInputTokens: 27000,
              totalOutputTokens: 41,
              totalCacheReadInputTokens: 0,
              totalCacheCreationInputTokens: 0,
              totalWebSearchRequests: 0,
              models: [{
                model: 'mock-opus',
                displayName: 'mock-opus',
                inputTokens: 27000,
                outputTokens: 41,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                webSearchRequests: 0,
                costUSD: 0.1234,
                costDisplay: '$0.1234',
                contextWindow: 200000,
                maxOutputTokens: 8192,
              }],
            },
          },
          session_id: sessionId,
        })
      }

      if (parsed.type === 'control_request' && parsed.request?.subtype === 'get_context_usage') {
        emit(ws, {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: parsed.request_id,
            response: {
              categories: [
                { name: 'System prompt', tokens: 6800, color: '#8a8a8a' },
                { name: 'MCP tools', tokens: 5900, color: '#06b6d4' },
                { name: 'Messages', tokens: 2400, color: '#7c3aed' },
                { name: 'Free space', tokens: 132000, color: '#a1a1aa' },
              ],
              totalTokens: 27000,
              maxTokens: 200000,
              rawMaxTokens: 200000,
              percentage: 13,
              gridRows: Array.from({ length: 10 }, (_, row) =>
                Array.from({ length: 10 }, (_, col) => {
                  const index = row * 10 + col
                  return {
                    color: index < 13 ? '#06b6d4' : '#a1a1aa',
                    isFilled: index < 13,
                    categoryName: index < 13 ? 'Used' : 'Free space',
                    tokens: 2000,
                    percentage: 1,
                    squareFullness: index < 13 ? 1 : 0,
                  }
                }),
              ),
              model: 'mock-opus',
              estimateOnly: parsed.request.estimateOnly === true,
              memoryFiles: [],
              mcpTools: [{ name: 'mock_tool', serverName: 'mock', tokens: 144, isLoaded: true }],
              agents: [],
              skills: { totalSkills: 1, includedSkills: 1, tokens: 3000, skillFrontmatter: [] },
              isAutoCompactEnabled: true,
              apiUsage: null,
            },
          },
          session_id: sessionId,
        })
      }

      if (parsed.type === 'control_request' && parsed.request?.subtype === 'mcp_status') {
        if (mcpStatusDelayMs > 0) {
          await delay(mcpStatusDelayMs)
        }
        emit(ws, {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: parsed.request_id,
            response: {
              mcpServers: [{ name: 'mock', status: 'connected' }],
            },
          },
          session_id: sessionId,
        })
      }
    }
  })()
})

ws.addEventListener('close', () => {
  process.exit(0)
})
