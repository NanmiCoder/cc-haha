import type { BetaContentBlock, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import type { Tools, ToolPermissionContext } from 'src/Tool.js'
import { toolMatchesName } from 'src/Tool.js'
import { TOOL_SEARCH_TOOL_NAME } from 'src/tools/ToolSearchTool/prompt.js'
import { getUserAgent } from 'src/utils/http.js'
import { safeParseJSON } from 'src/utils/json.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { toolToAPISchema } from 'src/utils/api.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

const DEFAULT_API_VERSION = '2025-04-01-preview'

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

type OpenAIResponseOutputItem = {
  type?: string
  role?: string
  id?: string
  call_id?: string
  tool_call_id?: string
  name?: string
  arguments?: string
  function?: { name?: string; arguments?: string }
  content?: Array<{ type?: string; text?: string }>
  output?: string
}

type OpenAIResponse = {
  id?: string
  output?: OpenAIResponseOutputItem[]
  output_text?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
  }
}

export function resolveAzureOpenAIEndpoint(): string {
  const baseUrl =
    process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_ENDPOINT
  if (!baseUrl) {
    throw new Error(
      'Missing Azure OpenAI base URL. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_ENDPOINT.',
    )
  }

  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/$/, '')
  if (!/\/openai\//i.test(path)) {
    url.pathname = `${path}/openai/responses`
  }

  if (!url.searchParams.has('api-version') || process.env.AZURE_OPENAI_API_VERSION) {
    url.searchParams.set('api-version', apiVersion)
  }

  return url.toString()
}

function resolveCodexDeployment(model: string): string | null {
  const envDefault = process.env.AZURE_OPENAI_CODEX_DEPLOYMENT
  if (envDefault) {
    return envDefault
  }

  switch (model.toLowerCase()) {
    case 'gpt-5.2-codex':
      return getModelStrings().gpt52codex
    case 'gpt-5.3-codex':
      return getModelStrings().gpt53codex
    case 'gpt-5.4-codex':
      return getModelStrings().gpt54codex
    default:
      return null
  }
}

export function resolveAzureOpenAIDeployment(model: string): string {
  const trimmed = model.trim()
  const envDefault = process.env.AZURE_OPENAI_CODEX_DEPLOYMENT
  if (envDefault) {
    return envDefault
  }

  const codex = resolveCodexDeployment(trimmed)
  if (codex) {
    const codexLower = codex.toLowerCase()
    if (
      codex === trimmed ||
      codexLower === 'gpt-5.2-codex' ||
      codexLower === 'gpt-5.3-codex' ||
      codexLower === 'gpt-5.4-codex'
    ) {
      throw new Error(
        `Missing Azure OpenAI deployment mapping for ${trimmed}. Set AZURE_OPENAI_CODEX_DEPLOYMENT or settings.modelOverrides["${trimmed}"] to your deployment name.`,
      )
    }
    return codex
  }

  return trimmed
}

export function getAzureOpenAIHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
  }

  if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_AZURE_OPENAI_AUTH)) {
    const apiKey = process.env.AZURE_OPENAI_API_KEY
    if (!apiKey) {
      throw new Error(
        'Missing Azure OpenAI API key. Set AZURE_OPENAI_API_KEY or enable CLAUDE_CODE_SKIP_AZURE_OPENAI_AUTH for testing.',
      )
    }
    headers['api-key'] = apiKey
  }

  return headers
}

export async function buildAzureOpenAITools(params: {
  tools: Tools
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  model?: string
}): Promise<
  {
    type: 'function'
    name: string
    description: string
    parameters: object
  }[]
> {
  const toolSchemas = await Promise.all(
    params.tools
      .filter(t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME))
      .map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: params.getToolPermissionContext,
          tools: params.tools,
          agents: params.agents,
          allowedAgentTypes: params.allowedAgentTypes,
          model: params.model,
        }),
      ),
  )

  return toolSchemas.map(schema => ({
    type: 'function',
    name: schema.name,
    description: schema.description ?? '',
    parameters: schema.input_schema ?? {},
  }))
}

function contentBlocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (block && typeof block === 'object' && 'type' in block) {
        const typed = block as { type?: string; text?: string }
        if (typed.type === 'text' && typeof typed.text === 'string') {
          return typed.text
        }
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function buildAzureOpenAIInput(messages: Array<{ type: string; message: { content: unknown } }>): OpenAIMessage[] {
  const inputs: OpenAIMessage[] = []

  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue

    const content = msg.message.content
    if (!Array.isArray(content)) {
      const text = contentBlocksToText(content)
      if (text.trim().length > 0) {
        inputs.push({ role: msg.type, content: text })
      }
      continue
    }

    const textParts: string[] = []
    const toolCalls: OpenAIToolCall[] = []

    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) continue
      const typed = block as {
        type?: string
        text?: string
        id?: string
        name?: string
        input?: unknown
        tool_use_id?: string
        content?: unknown
      }

      if (typed.type === 'text' && typeof typed.text === 'string') {
        textParts.push(typed.text)
      }

      if (typed.type === 'tool_use' && typed.name) {
        const args =
          typeof typed.input === 'string'
            ? typed.input
            : JSON.stringify(typed.input ?? {})
        toolCalls.push({
          id: typed.id ?? randomUUID(),
          type: 'function',
          function: {
            name: typed.name,
            arguments: args,
          },
        })
      }

      if (typed.type === 'tool_result' && msg.type === 'user') {
        const resultText = contentBlocksToText(typed.content)
        inputs.push({
          role: 'tool',
          tool_call_id: typed.tool_use_id ?? randomUUID(),
          content: resultText,
        })
      }
    }

    if (msg.type === 'assistant') {
      const contentText = textParts.join('\n')
      if (contentText || toolCalls.length > 0) {
        inputs.push({
          role: 'assistant',
          content: contentText.length > 0 ? contentText : null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        })
      }
      continue
    }

    if (msg.type === 'user') {
      const contentText = textParts.join('\n')
      if (contentText.length > 0) {
        inputs.push({ role: 'user', content: contentText })
      }
    }
  }

  return inputs
}

function mapOutputItemToBlocks(item: OpenAIResponseOutputItem): BetaContentBlock[] {
  const blocks: BetaContentBlock[] = []
  if (!item) return blocks

  if (item.type === 'message' && Array.isArray(item.content)) {
    for (const content of item.content) {
      if (!content || typeof content !== 'object') continue
      if (content.type === 'output_text' || content.type === 'text') {
        const text = content.text ?? ''
        blocks.push({ type: 'text', text })
      }
    }
  }

  if (item.type === 'tool_call' || item.type === 'function_call') {
    const name = item.name ?? item.function?.name
    if (name) {
      const rawArgs = item.arguments ?? item.function?.arguments ?? '{}'
      const parsed =
        typeof rawArgs === 'string' ? safeParseJSON(rawArgs) : rawArgs
      blocks.push({
        type: 'tool_use',
        id: item.id ?? item.call_id ?? item.tool_call_id ?? randomUUID(),
        name,
        input: parsed ?? {},
      } as BetaContentBlock)
    }
  }

  return blocks
}

export function parseAzureOpenAIResponse(response: OpenAIResponse): {
  content: BetaContentBlock[]
  usage: BetaUsage
  responseId?: string
} {
  const contentBlocks: BetaContentBlock[] = []

  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      contentBlocks.push(...mapOutputItemToBlocks(item))
    }
  }

  if (contentBlocks.length === 0 && response.output_text) {
    contentBlocks.push({ type: 'text', text: response.output_text })
  }

  const usage: BetaUsage = {
    input_tokens: response.usage?.input_tokens ?? response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? response.usage?.completion_tokens ?? 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  } as BetaUsage

  return { content: contentBlocks, usage, responseId: response.id }
}

export async function requestAzureOpenAI(params: {
  model: string
  systemPrompt: string
  messages: Array<{ type: string; message: { content: unknown } }>
  tools: Tools
  toolChoice?: { type?: string; name?: string }
  maxOutputTokens: number
  temperature?: number
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  signal: AbortSignal
}): Promise<{ content: BetaContentBlock[]; usage: BetaUsage; responseId?: string }>{
  const deployment = resolveAzureOpenAIDeployment(params.model)
  const endpoint = resolveAzureOpenAIEndpoint()
  const headers = getAzureOpenAIHeaders()

  const tools = await buildAzureOpenAITools({
    tools: params.tools,
    getToolPermissionContext: params.getToolPermissionContext,
    agents: params.agents,
    allowedAgentTypes: params.allowedAgentTypes,
    model: params.model,
  })

  const input = buildAzureOpenAIInput(params.messages)

  const body: Record<string, unknown> = {
    model: deployment,
    input,
    instructions: params.systemPrompt,
    max_output_tokens: params.maxOutputTokens,
  }

  if (tools.length > 0) {
    body.tools = tools
  }

  if (params.toolChoice?.type === 'tool' && params.toolChoice.name) {
    body.tool_choice = {
      type: 'function',
      name: params.toolChoice.name,
    }
  } else if (tools.length > 0) {
    body.tool_choice = 'auto'
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature
  }

  logForDebugging(
    `[AzureOpenAI] POST ${endpoint} model=${deployment} tools=${tools.length}`,
  )

  const fetchOptions = getProxyFetchOptions()
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: params.signal,
    ...fetchOptions,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `Azure OpenAI request failed (${response.status}): ${errorBody}`,
    )
  }

  const data = (await response.json()) as OpenAIResponse
  return parseAzureOpenAIResponse(data)
}
