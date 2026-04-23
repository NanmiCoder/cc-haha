const args = process.argv.slice(2)

function getArg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function emit(ws: WebSocket, payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload) + '\n')
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
let initSent = false

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
    sendInit()
  }
})

ws.addEventListener('message', (event) => {
  const payload = typeof event.data === 'string' ? event.data : String(event.data)
  const lines = payload.split('\n').map(line => line.trim()).filter(Boolean)

  for (const line of lines) {
    const parsed = JSON.parse(line)

    if (parsed.type === 'user') {
      sendInit()
      const text = extractUserText(parsed)
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
      emit(ws, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `Echo: ${text}` },
        },
        session_id: sessionId,
      })
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
  }
})

ws.addEventListener('close', () => {
  process.exit(0)
})
