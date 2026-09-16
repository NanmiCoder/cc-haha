import type { BetaContentBlock, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
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

function requireAssociationId(id: string | undefined, field: string): string {
  if (!id) throw new Error(`${field} missing call_id`)
  return id
}

type OpenAIContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; file_url?: string; file_data?: string; filename?: string }

type OpenAIInputItem =
  | {
      type: 'message'
      role: 'user' | 'assistant'
      content: string | OpenAIContentPart[]
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | {
      type: 'function_call_output'
      call_id: string
      output: string | OpenAIContentPart[]
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
  status?: string
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
  if (/\/openai\/responses$/i.test(path)) {
    url.pathname = path
  } else if (/\/openai(?:\/.*)?$/i.test(path)) {
    url.pathname = path.replace(/\/openai(?:\/.*)?$/i, '/openai/responses')
  } else {
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

/**
 * Model-visible document metadata (title/context) as synthetic prefix text.
 * Both fields are visible to the model in the Anthropic protocol, so
 * degradation keeps them instead of dropping them silently. Returns an empty
 * string when neither is set, otherwise a newline-terminated prefix so the
 * document body follows on its own line.
 */
function documentProvenanceText(document: { title?: string; context?: string }): string {
  const lines = [
    ...(document.title ? [`[Document: ${document.title}]`] : []),
    ...(document.context ? [`[Document context: ${document.context}]`] : []),
  ]
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function contentBlocksToOpenAIContent(
  content: unknown,
): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: OpenAIContentPart[] = []
  // Only adjacent *text* blocks collapse into one string (joined without a
  // separator — the wire shape carries no newline between them). Anything
  // degraded from another block type keeps its array shape so block
  // boundaries stay visible.
  let allOriginalText = true
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue
    const typed = block as {
      type?: string
      text?: string
      source?: {
        type?: string
        media_type?: string
        data?: string
        url?: string
        file_id?: string
        content?: unknown
      }
      title?: string
      context?: string
      content?: unknown
    }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push({ type: 'input_text', text: typed.text })
    } else if (typed.type === 'search_result') {
      // `source` is a URL string per the official Anthropic schema.
      allOriginalText = false
      const contentText = Array.isArray(typed.content)
        ? typed.content
            .filter((part): part is { type: 'text'; text: string } =>
              typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
        : []
      const text = [
        typed.title,
        ...contentText,
        typeof typed.source === 'string' ? typed.source : undefined,
      ].filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' — ')
      if (text) parts.push({ type: 'input_text', text })
    } else if (typed.type === 'image' && typed.source) {
      allOriginalText = false
      const source = typed.source
      if (typeof source.url === 'string') {
        parts.push({ type: 'input_image', image_url: source.url })
      } else if (source.type === 'file') {
        parts.push({ type: 'input_text', text: '[Image omitted: file-based image source is not supported by this endpoint.]' })
      } else if (typeof source.media_type === 'string' && typeof source.data === 'string') {
        parts.push({
          type: 'input_image',
          image_url: `data:${source.media_type};base64,${source.data}`,
        })
      }
    } else if (typed.type === 'document' && typed.source) {
      allOriginalText = false
      const source = typed.source
      if (source.type === 'text' && typeof source.data === 'string') {
        // Anthropic text documents carry plain text in `data` — not base64.
        // Title/context are model-visible metadata, kept as a synthetic prefix.
        parts.push({ type: 'input_text', text: `${documentProvenanceText(typed)}${source.data}` })
      } else if (source.type === 'content') {
        // Custom-content documents carry inline text and image blocks
        // (citations/RAG). Keep both visible. Title/context are synthesized
        // metadata, so they may carry their own separator (unlike the
        // document's text blocks, which are never rewritten).
        const provenance = documentProvenanceText(typed)
        if (provenance) parts.push({ type: 'input_text', text: provenance })
        if (typeof source.content === 'string') {
          if (source.content) parts.push({ type: 'input_text', text: source.content })
        } else if (Array.isArray(source.content)) {
          for (const part of source.content) {
            const media = contentBlocksToOpenAIContent([part])
            if (Array.isArray(media)) parts.push(...media)
            else if (media) parts.push({ type: 'input_text', text: media })
          }
        }
      } else if (typeof source.media_type === 'string' && typeof source.data === 'string') {
        // The input_file carries the title as filename, so the synthetic
        // provenance prefix keeps the model-visible title/context text.
        const provenance = documentProvenanceText(typed)
        if (provenance) parts.push({ type: 'input_text', text: provenance })
        parts.push({
          type: 'input_file',
          file_data: `data:${source.media_type};base64,${source.data}`,
          ...(typed.title ? { filename: typed.title } : {}),
        })
      } else if (typeof source.url === 'string') {
        // Azure Responses (2025-04-01-preview) does not accept file_url the
        // way the OpenAI public API does. Keep the document visible with a
        // text reference instead of silently dropping it. The reference text
        // carries the title as its label, so only context needs a prefix.
        const contextPrefix = typed.context ? `[Document context: ${typed.context}]\n` : ''
        parts.push({
          type: 'input_text',
          text: `${contextPrefix}[Document: ${typed.title ?? source.url}](${source.url})`,
        })
      } else if (source.type === 'file') {
        const contextPrefix = typed.context ? `[Document context: ${typed.context}]\n` : ''
        parts.push({
          type: 'input_text',
          text: `${contextPrefix}[Document: ${typed.title ?? 'file'} omitted — file-based source]`,
        })
      }
    }
  }

  if (allOriginalText && parts.every(part => part.type === 'input_text')) {
    return parts.map(part => part.text).join('')
  }
  return parts
}

export function buildAzureOpenAIInput(
  messages: Array<{ type: string; message: { content: unknown } }>,
): OpenAIInputItem[] {
  const inputs: OpenAIInputItem[] = []

  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue

    const content = msg.message.content
    if (!Array.isArray(content)) {
      const text = contentBlocksToText(content)
      if (text.trim().length > 0) {
        inputs.push({ type: 'message', role: msg.type, content: text })
      }
      continue
    }

    const contentParts: OpenAIContentPart[] = []
    // Only messages made of adjacent text blocks collapse to a string; any
    // non-text block keeps the array shape so block boundaries stay visible.
    let hasNonTextBlock = false
    const flushMessage = (): void => {
      if (contentParts.length === 0) return
      const messageContent = !hasNonTextBlock && contentParts.every(
        part => part.type === 'input_text',
      )
        ? contentParts.map(part => part.text).join('')
        : [...contentParts]
      inputs.push({
        type: 'message',
        role: msg.type,
        content: messageContent,
      })
      contentParts.length = 0
      hasNonTextBlock = false
    }

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
        contentParts.push({ type: 'input_text', text: typed.text })
      } else if ((typed.type === 'image' || typed.type === 'document' || typed.type === 'search_result') && msg.type === 'user') {
        hasNonTextBlock = true
        const media = contentBlocksToOpenAIContent([typed])
        if (Array.isArray(media)) {
          contentParts.push(...media)
        } else if (media) {
          contentParts.push({ type: 'input_text', text: media })
        }
      } else if (typed.type === 'tool_use' && typed.name) {
        flushMessage()
        inputs.push({
          type: 'function_call',
          call_id: requireAssociationId(typed.id, 'tool_use'),
          name: typed.name,
          arguments:
            typeof typed.input === 'string'
              ? typed.input
              : JSON.stringify(typed.input ?? {}),
        })
      } else if (typed.type === 'tool_result' && msg.type === 'user') {
        flushMessage()
        inputs.push({
          type: 'function_call_output',
          call_id: requireAssociationId(typed.tool_use_id, 'tool_result'),
          output: contentBlocksToOpenAIContent(typed.content),
        })
      }
    }

    flushMessage()
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
        id: requireAssociationId(
          item.call_id ?? item.tool_call_id ?? (item.type === 'tool_call' ? item.id : undefined),
          'function_call',
        ),
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
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
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

  const stopReason =
    response.status === 'incomplete'
      ? 'max_tokens'
      : contentBlocks.some(block => block.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn'

  return { content: contentBlocks, usage, responseId: response.id, stopReason }
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
}): Promise<{ content: BetaContentBlock[]; usage: BetaUsage; responseId?: string; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }>{
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
