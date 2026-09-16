/**
 * Anthropic Messages compatibility transform for third-party endpoints that
 * drop media nested inside `tool_result`.
 *
 * Only used when a provider explicitly configures
 * `supportsNestedToolResultMedia: false`. The transform keeps every
 * `tool_result` contiguous (Anthropic requires tool results to precede other
 * content in a user turn) and lifts the images/documents out of each
 * `tool_result`, placing them right after the last `tool_result` and before
 * any trailing user text, so media stays ahead of the text that follows it.
 * Each group is preceded by a marker naming the owning tool call, and groups
 * keep their original order. Nested text stays in the `tool_result`.
 *
 * Note: media interleaved between text blocks inside one `tool_result` cannot
 * keep its exact position in the Anthropic wire shape after lifting — this is
 * inherent to the compatibility mode the provider opted into.
 */

import type {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicDocumentContentTextBlock,
  AnthropicDocumentSource,
} from './types.js'

/**
 * Server-executed tools appear in the transcript as `server_tool_use` blocks
 * (built-in tools such as web_search) and `mcp_tool_use` blocks (the MCP
 * connector), which share the same continuation semantics. Their results
 * arrive as a `<tool>_tool_result` block (for example `web_search_tool_result`
 * or `mcp_tool_result`) paired by `tool_use_id`. The API attaches it to the
 * same assistant turn when the tool ran directly, or to the following
 * assistant response when the call was mixed with client tools — never as a
 * client `tool_result` in a user message.
 */
function isServerLikeToolUse(
  block: AnthropicContentBlock,
): block is AnthropicContentBlock & { id: string } {
  const candidate = block as { type?: unknown; id?: unknown }
  return typeof candidate.id === 'string'
    && (candidate.type === 'server_tool_use' || candidate.type === 'mcp_tool_use')
}

function isServerToolResultBlock(
  block: AnthropicContentBlock,
): block is AnthropicContentBlock & { tool_use_id: string } {
  const candidate = block as { type?: unknown; tool_use_id?: unknown }
  return typeof candidate.tool_use_id === 'string'
    && typeof candidate.type === 'string'
    && candidate.type.endsWith('_tool_result')
}

/**
 * True when an assistant turn contains a server-executed tool call (`server_tool_use`
 * or `mcp_tool_use`) whose result has not arrived in the same turn. The user
 * message that continues such a turn may only contain tool_result blocks, so
 * media lifting would produce an invalid request. A deferred server tool that
 * ran after the client returned its own tool_results arrives in the next
 * assistant response and is not repeated, so the turn that follows it carries
 * no pending server call at all and lifts normally.
 */
function isUnresolvedServerToolTurn(msg: AnthropicMessage): boolean {
  if (typeof msg.content === 'string') return false
  const serverIds = msg.content.filter(isServerLikeToolUse).map(block => block.id)
  if (serverIds.length === 0) return false
  const resolved = new Set(
    msg.content.filter(isServerToolResultBlock).map(block => block.tool_use_id),
  )
  return serverIds.some(id => !resolved.has(id))
}

function isTextOnlyDocumentContent(
  source: Extract<AnthropicDocumentSource, { type: 'content' }>,
): source is Extract<AnthropicDocumentSource, { type: 'content' }> & {
  content: string | AnthropicDocumentContentTextBlock[]
} {
  return typeof source.content === 'string'
    || source.content.every((block): block is AnthropicDocumentContentTextBlock => block.type === 'text')
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

function mediaMarker(
  toolUseId: string,
  media: Extract<AnthropicContentBlock, { type: 'image' | 'document' }>[],
): AnthropicContentBlock {
  const images = media.filter(block => block.type === 'image').length
  const documents = media.length - images
  if (images > 0 && documents > 0) {
    const imageLabel = images === 1 ? 'image' : 'images'
    const documentLabel = documents === 1 ? 'document' : 'documents'
    return {
      type: 'text',
      text: `[Media content for tool call ${toolUseId}: ${images} ${imageLabel}, ${documents} ${documentLabel}]`,
    }
  }
  const label = images > 0 ? 'Image' : 'Document'
  const count = media.length > 1 ? ` (${media.length})` : ''
  return {
    type: 'text',
    text: `[${label} content for tool call ${toolUseId}${count}]`,
  }
}

export function hoistToolResultMediaForCompatibility(
  body: AnthropicRequest,
): AnthropicRequest {
  let changed = false
  const messages = body.messages.map((msg, index) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg

    // Anthropic requires a user message that continues an unresolved
    // server-executed tool (`server_tool_use` or `mcp_tool_use`) to contain
    // only tool_result blocks, so media lifting would risk a 400 for that one
    // message. Earlier turns that already completed are not restricted and
    // keep their media lifted. Merely declaring server-side tools in `tools`
    // does not trigger this.
    for (let i = index - 1; i >= 0; i--) {
      const prev = body.messages[i]
      if (prev.role !== 'assistant') continue
      if (isUnresolvedServerToolTurn(prev)) return msg
      break
    }

    let messageChanged = false
    const hoisted: AnthropicContentBlock[] = []
    const content = msg.content.map(block => {
      if (block.type !== 'tool_result') return block
      const inner = block.content
      if (typeof inner === 'string' || !Array.isArray(inner)) return block

      const media: Extract<AnthropicContentBlock, { type: 'image' | 'document' }>[] = []
      const retained: AnthropicContentBlock[] = []
      let degraded = false
      for (const part of inner) {
        if (part.type === 'image') {
          media.push(part)
        } else if (part.type === 'document' && part.source.type === 'text') {
          // Plain-text documents degrade to text inside the tool result,
          // keeping their provenance instead of lifting them as user-level
          // media. Title and context are model-visible metadata in the
          // Anthropic protocol, so they stay visible as a prefix without
          // altering the data; cache_control survives the degradation.
          const provenance = documentProvenanceText(part)
          const text = `${provenance}${part.source.data}`
          retained.push({ type: 'text', text, ...(part.cache_control !== undefined ? { cache_control: part.cache_control } : {}) })
          degraded = true
        } else if (part.type === 'document' && part.source.type === 'content' && isTextOnlyDocumentContent(part.source)) {
          // Text-only custom-content documents degrade to text inside the
          // tool result. The original text blocks keep their boundaries (no
          // injected separators) and their own cache_control/citations;
          // title/context become separate provenance blocks. The
          // document-level cache_control attaches to the last degraded block
          // — Anthropic prompt caching treats the marked block as the end of
          // the cached prefix, so the breakpoint must sit after the
          // document's content, not on the synthetic title — unless that
          // block already carries an inner marker, which is preserved.
          const degradedBlocks: AnthropicDocumentContentTextBlock[] = []
          if (part.title) degradedBlocks.push({ type: 'text', text: `[Document: ${part.title}]` })
          if (part.context) degradedBlocks.push({ type: 'text', text: `[Document context: ${part.context}]` })
          if (typeof part.source.content === 'string') {
            degradedBlocks.push({ type: 'text', text: part.source.content })
          } else {
            for (const block of part.source.content) {
              degradedBlocks.push({
                type: 'text',
                text: block.text,
                ...(block.cache_control !== undefined ? { cache_control: block.cache_control } : {}),
                ...(block.citations !== undefined ? { citations: block.citations } : {}),
              })
            }
          }
          if (part.cache_control !== undefined && degradedBlocks.length > 0) {
            const last = degradedBlocks.length - 1
            if (degradedBlocks[last].cache_control === undefined) {
              degradedBlocks[last] = { ...degradedBlocks[last], cache_control: part.cache_control }
            }
          }
          retained.push(...degradedBlocks)
          degraded = true
        } else if (part.type === 'document') {
          media.push(part)
        } else {
          retained.push(part)
        }
      }
      if (media.length === 0) {
        if (!degraded) return block
        messageChanged = true
        return { ...block, content: retained }
      }

      messageChanged = true
      hoisted.push(mediaMarker(block.tool_use_id, media), ...media)
      if (retained.length === 0) {
        retained.push({ type: 'text', text: 'Media result attached after this tool result.' })
      }
      return { ...block, content: retained }
    })

    if (!messageChanged) return msg
    changed = true

    // Insert the lifted media right after the last tool_result so it stays
    // ahead of trailing user text, matching the original content order.
    const lastToolResultIndex = content.findLastIndex(block => block.type === 'tool_result')
    const insertAt = lastToolResultIndex >= 0 ? lastToolResultIndex + 1 : content.length
    return {
      ...msg,
      content: [
        ...content.slice(0, insertAt),
        ...hoisted,
        ...content.slice(insertAt),
      ],
    }
  })

  if (!changed) return body
  return { ...body, messages }
}
