/**
 * A scripted stand-in for a model, used by the mock-LLM agent lane.
 *
 * The lane runs the real server and the real CLI, and points the CLI at a local
 * Anthropic-compatible endpoint (`server.ts`) whose replies come from here. That is
 * the only fake in the chain, so everything a contributor can break between "the
 * user typed" and "the model's tool call landed on disk and its result went back
 * upstream" is exercised on every run, with no credentials and no network.
 *
 * It reacts to the same plain-language prompts the live lane sends to a real model
 * (`agent-flow/liveScenarios.ts`), so one scenario catalog serves both lanes: the
 * mock proves the plumbing deterministically, the live lane proves a real model
 * still lands on the same outcome.
 *
 * Pure module: the decision of what to reply is unit-testable without a socket.
 */

export type MockContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export type MockReply =
  | {
    kind: 'message'
    content: MockContentBlock[]
    stopReason: 'end_turn' | 'tool_use'
    /** Delay between streamed text chunks; only the interrupt scenario needs it. */
    chunkDelayMs?: number
  }
  | { kind: 'error'; status: number; errorType: string; message: string }

type RequestBlock = {
  type?: string
  text?: string
  content?: unknown
  is_error?: boolean
  tool_use_id?: string
}

type RequestMessage = { role?: string; content?: string | RequestBlock[] }

export type MockRequest = {
  model?: string
  system?: string | Array<{ type?: string; text?: string }>
  messages?: RequestMessage[]
  tools?: Array<{ name?: string }>
}

/** Prompt that makes the scripted model fail the request the way a provider would. */
export const UPSTREAM_ERROR_TRIGGER = 'MOCK_UPSTREAM_ERROR'
export const UPSTREAM_ERROR_MESSAGE = 'mock upstream rejected this request'

function blocksOf(message: RequestMessage | undefined): RequestBlock[] {
  if (!message) return []
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return Array.isArray(message.content) ? message.content : []
}

function textOf(blocks: RequestBlock[]) {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n')
}

function toolResultText(block: RequestBlock): string {
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) return textOf(block.content as RequestBlock[])
  return ''
}

function systemText(request: MockRequest) {
  if (typeof request.system === 'string') return request.system
  return (request.system ?? []).map((block) => block.text ?? '').join('\n')
}

/**
 * The CLI tells the model where it is in the system prompt. A real model uses that
 * to build absolute paths for its file tools, and so does this one.
 */
export function workingDirectoryOf(request: MockRequest): string | null {
  const match = /Primary working directory:\s*(\S+)/.exec(systemText(request))
  return match ? match[1]! : null
}

/**
 * The user text the model is answering: the last text block of the latest user
 * message. Two rules make that the right block:
 * - CLI-injected context (`<system-reminder>` blocks and the like) rides in the same
 *   message, so tagged blocks are stripped first.
 * - When a turn fails before the model answers, the CLI merges the next prompt into
 *   the same user message rather than sending two in a row. Only the newest block
 *   is what the user just asked.
 */
function latestUserPrompt(messages: RequestMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    const texts = blocksOf(message)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text!.replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, '').trim())
      .filter(Boolean)
    if (texts.length > 0) return texts[texts.length - 1]!
  }
  return ''
}

function hasTool(request: MockRequest, name: string) {
  return (request.tools ?? []).some((tool) => tool.name === name)
}

let toolUseCounter = 0
function nextToolUseId() {
  toolUseCounter += 1
  return `toolu_mock_${String(toolUseCounter).padStart(4, '0')}`
}

function text(textValue: string, chunkDelayMs?: number): MockReply {
  return {
    kind: 'message',
    content: [{ type: 'text', text: textValue }],
    stopReason: 'end_turn',
    ...(chunkDelayMs ? { chunkDelayMs } : {}),
  }
}

function toolUse(name: string, input: Record<string, unknown>): MockReply {
  return {
    kind: 'message',
    content: [{ type: 'tool_use', id: nextToolUseId(), name, input }],
    stopReason: 'tool_use',
  }
}

/**
 * Decides the reply. Requests without the agent's tools are the CLI's side calls
 * (titles, summaries); they get a short neutral answer so they never steer a turn.
 */
export function decideReply(request: MockRequest): MockReply {
  const messages = request.messages ?? []
  const last = messages[messages.length - 1]
  const prompt = latestUserPrompt(messages)

  if (prompt.includes(UPSTREAM_ERROR_TRIGGER)) {
    return { kind: 'error', status: 400, errorType: 'invalid_request_error', message: UPSTREAM_ERROR_MESSAGE }
  }

  const isAgentTurn = hasTool(request, 'Write') || hasTool(request, 'Bash')
  if (!isAgentTurn) return text('Mock title')

  // A tool just ran: report what came back, the way a model summarises a result.
  const results = blocksOf(last).filter((block) => block.type === 'tool_result')
  if (last?.role === 'user' && results.length > 0) {
    const result = results[results.length - 1]!
    const body = toolResultText(result).trim()
    return text(result.is_error ? `The tool failed: ${body}` : `Tool result: ${body}`)
  }

  const cwd = workingDirectoryOf(request)
  const write = /Create a file called (\S+?)\.?\s[\s\S]*?(?:single word|containing the word) (\w+)/i.exec(prompt)
  if (write && cwd && hasTool(request, 'Write')) {
    return toolUse('Write', { file_path: `${cwd.replace(/\/$/, '')}/${write[1]}`, content: `${write[2]}\n` })
  }

  const shell = /Run the shell command `([^`]+)`/i.exec(prompt)
  if (shell && hasTool(request, 'Bash')) {
    return toolUse('Bash', { command: shell[1], description: 'Run the requested command' })
  }

  const count = /Count from 1 to (\d+)/i.exec(prompt)
  if (count) {
    const lines = Array.from({ length: Number(count[1]) }, (_, index) => String(index + 1))
    return text(lines.join('\n'), 40)
  }

  return text('Ready when you are.')
}
