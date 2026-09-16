/**
 * Unit tests for proxy protocol transformation
 */

import { describe, test, expect } from 'bun:test'
import { anthropicToOpenaiChat } from '../proxy/transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from '../proxy/transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from '../proxy/transform/openaiResponsesToAnthropic.js'
import { stripLeadingBillingHeader } from '../proxy/transform/billingHeader.js'
import { openaiUsageToAnthropic } from '../proxy/transform/usage.js'
import { resolvePromptCacheKey } from '../proxy/promptCacheKey.js'
import { buildComputerUseTools } from '../../vendor/computer-use-mcp/tools.js'
import type { AnthropicRequest, OpenAIChatResponse, OpenAIResponsesResponse } from '../proxy/transform/types.js'

const BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.220.693; cc_entrypoint=cli; cch=00000;'

// ─── anthropicToOpenaiChat ──────────────────────────────────────

describe('anthropicToOpenaiChat', () => {
  test('basic text message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.model).toBe('gpt-4')
    expect(result.max_tokens).toBe(1024)
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }])
  })

  test('system prompt string', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful' })
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  test('system prompt array', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'Part 1\nPart 2' })
  })

  test('stop_sequences → stop', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      stop_sequences: ['END', 'STOP'],
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.stop).toEqual(['END', 'STOP'])
  })

  test('omits Anthropic sampling params by default for OpenAI-compatible providers', () => {
    const req: AnthropicRequest = {
      model: 'glm-5.2',
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const result = anthropicToOpenaiChat(req)
    expect(result.temperature).toBeUndefined()
    expect(result.top_p).toBeUndefined()
  })

  test('can explicitly pass sampling params for chat providers that accept them', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const result = anthropicToOpenaiChat(req, { passSamplingParams: true })
    expect(result.temperature).toBe(0.7)
    expect(result.top_p).toBe(0.9)
  })

  test('tools conversion', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].type).toBe('function')
    expect(result.tools![0].function.name).toBe('get_weather')
    expect(result.tools![0].function.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } })
  })

  test('filters BatchTool', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'BatchTool', input_schema: {} },
        { name: 'real_tool', input_schema: {} },
      ],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.name).toBe('real_tool')
  })

  test('tool_choice conversion', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tool_choice).toBe('required')
  })

  test('tool_choice type=tool', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
  })

  test('thinking budget → reasoning_effort', () => {
    const lowReq: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 512 },
    }
    expect(anthropicToOpenaiChat(lowReq).reasoning_effort).toBe('low')

    const medReq: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 4096 },
    }
    expect(anthropicToOpenaiChat(medReq).reasoning_effort).toBe('medium')

    const highReq: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 16000 },
    }
    expect(anthropicToOpenaiChat(highReq).reasoning_effort).toBe('high')
  })

  test('passes explicit thinking toggle for DeepSeek-compatible chat proxies', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-flash',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'disabled' },
    }

    expect(anthropicToOpenaiChat(req).thinking).toBeUndefined()
    expect(anthropicToOpenaiChat(req, { passThinkingToggle: true }).thinking).toEqual({ type: 'disabled' })
  })

  test('maps output_config effort to reasoning_effort for OpenAI-compatible chat providers', () => {
    const req: AnthropicRequest = {
      model: 'longcat',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    }

    const result = anthropicToOpenaiChat(req)
    expect(result.reasoning_effort).toBe('high')
  })

  test('preserves provider-specific effort values for the upstream compatibility layer', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'medium' },
    }

    expect(anthropicToOpenaiChat(req).reasoning_effort).toBe('medium')
  })

  test('preserves xhigh output_config effort for OpenAI-compatible chat providers', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.6-luna',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'xhigh' },
    }

    const result = anthropicToOpenaiChat(req)
    expect(result.reasoning_effort).toBe('xhigh')
  })

  test('preserves max output_config effort for OpenAI-compatible chat providers', () => {
    const req: AnthropicRequest = {
      model: 'longcat',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'max' },
    }

    const result = anthropicToOpenaiChat(req)
    expect(result.reasoning_effort).toBe('max')
  })

  test('assistant message with tool_use', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'tc_1', name: 'get_weather', input: { city: 'NYC' } },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req)
    const msg = result.messages[0]
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('Let me check')
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.tool_calls![0].id).toBe('tc_1')
    expect(msg.tool_calls![0].function.name).toBe('get_weather')
    expect(msg.tool_calls![0].function.arguments).toBe('{"city":"NYC"}')
  })

  test('round-trips assistant thinking as reasoning_content for DeepSeek tool-call history', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need the date first. ' },
          { type: 'thinking', thinking: 'Then call weather.' },
          { type: 'text', text: 'Let me check that.' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'Hangzhou' } },
        ],
      }],
    }

    const defaultResult = anthropicToOpenaiChat(req)
    expect(defaultResult.messages[0].reasoning_content).toBeUndefined()

    const result = anthropicToOpenaiChat(req, { roundTripReasoningContent: true })
    const msg = result.messages[0]
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('Let me check that.')
    expect(msg.reasoning_content).toBe('Need the date first. Then call weather.')
    expect(msg.tool_calls?.[0].id).toBe('call_1')
  })

  test('user message with tool_result', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: 'Sunny, 72°F' },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0].role).toBe('tool')
    expect(result.messages[0].tool_call_id).toBe('tc_1')
    expect(result.messages[0].content).toBe('Sunny, 72°F')
  })

  test('lifts tool_result images into a user message after the tool message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_image',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
          }],
        }],
      }],
    }

    const result = anthropicToOpenaiChat(req)

    expect(result.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'tc_image',
        content: 'Media result attached after this tool result.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Media content for tool call tc_image]' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc123' },
          },
        ],
      },
    ])
  })

  test('keeps tool messages text-only and groups lifted media per tool call', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: [
            { type: 'text', text: 'first' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
            { type: 'text', text: 'last' },
          ] },
          { type: 'tool_result', tool_use_id: 'tc_2', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'def' } },
          ] },
        ],
      }],
    }

    const result = anthropicToOpenaiChat(req)

    expect(result.messages).toEqual([
      // Adjacent text blocks are joined without a separator — the wire shape
      // carries no newline between them.
      { role: 'tool', tool_call_id: 'tc_1', content: 'firstlast' },
      { role: 'tool', tool_call_id: 'tc_2', content: 'Media result attached after this tool result.' },
      { role: 'user', content: [
        { type: 'text', text: '[Media content for tool call tc_1]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'text', text: '[Media content for tool call tc_2]' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,def' } },
      ] },
    ])
  })

  test('collapses pure-text user messages to a plain string content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      }],
    }

    // OpenAI-compatible endpoints that only implement string `content` keep
    // working; the multipart array form is reserved for media messages.
    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'user', content: 'hello' },
    ])
  })

  test('collapses multiple text-only blocks to a plain string', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'user', content: 'hello world' },
    ])
  })

  test('keeps ordinary mixed user content in one message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: 'after' },
        ],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'text', text: 'after' },
      ],
    }])
  })

  test('keeps tool-result media ahead of trailing user text', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tc_1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
          },
          { type: 'text', text: 'Please look at the top-left corner of the image' },
        ],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_1', content: 'Media result attached after this tool result.' },
      { role: 'user', content: [
        { type: 'text', text: '[Media content for tool call tc_1]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ] },
      { role: 'user', content: 'Please look at the top-left corner of the image' },
    ])
  })

  test('keeps image URL sources in lifted tool-result media', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_url',
          content: [{
            type: 'image',
            source: { type: 'url', url: 'https://example.test/shot.png' },
          }],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_url', content: 'Media result attached after this tool result.' },
      { role: 'user', content: [
        { type: 'text', text: '[Media content for tool call tc_url]' },
        { type: 'image_url', image_url: { url: 'https://example.test/shot.png' } },
      ] },
    ])
  })

  test('keeps tool-result documents visible as text references in the tool message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_doc',
          content: [
            { type: 'document', title: 'report.pdf', source: { type: 'url', url: 'https://example.test/report.pdf' } },
            { type: 'document', title: 'notes.txt', source: { type: 'base64', media_type: 'text/plain', data: 'aGVsbG8=' } },
            { type: 'document', title: 'readme', source: { type: 'text', media_type: 'text/plain', data: 'hello world' } },
            { type: 'document', title: 'secret.pdf', source: { type: 'file', file_id: 'file_123' } },
          ],
        }],
      }],
    }

    // Textual document representations stay inside the tool message (external
    // tool output belongs behind the tool role); only real media lifts.
    expect(anthropicToOpenaiChat(req).messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'tc_doc',
        content: '[Document: report.pdf](https://example.test/report.pdf)\n[Document: notes.txt]\nhello\n[Document: readme]\nhello world\n[Document: secret.pdf omitted — file-based source]',
      },
    ])
  })

  test('keeps tool-result search results as text', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_search',
          content: [
            {
              type: 'search_result',
              title: 'Result title',
              content: [{ type: 'text', text: 'Snippet body' }],
              source: 'https://example.test/result',
            },
          ],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_search', content: 'Result title — Snippet body — https://example.test/result' },
    ])
  })

  test('degrades file-based image sources to a visible text notice', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_file',
          content: [
            { type: 'image', source: { type: 'file', file_id: 'file-123' } },
          ],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_file', content: '\n[Image omitted: file-based image source is not supported by this endpoint.]\n' },
    ])
  })

  test('keeps top-level user search results as text', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'search_result',
            title: 'Top result',
            content: [{ type: 'text', text: 'Top snippet' }],
            source: 'https://example.test/top',
          },
        ],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'user', content: 'Top result — Top snippet — https://example.test/top' },
    ])
  })

  test('flattens custom-content documents as text', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_cdoc',
          content: [
            {
              type: 'document',
              title: 'cited doc',
              source: {
                type: 'content',
                content: [{ type: 'text', text: 'quoted passage' }],
              },
            },
          ],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_cdoc', content: '[Document: cited doc]\nquoted passage' },
    ])
  })

  test('keeps inline images of custom-content documents in tool-result documents', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_cdoc',
          content: [{
            type: 'document',
            title: 'cited',
            source: {
              type: 'content',
              content: [
                { type: 'text', text: 'before' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
                { type: 'text', text: 'after' },
              ],
            },
          }],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      // The document's text blocks keep their boundaries without a separator;
      // the synthetic title prefix carries its own newline.
      { role: 'tool', tool_call_id: 'tc_cdoc', content: '[Document: cited]\nbeforeafter' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Media content for tool call tc_cdoc]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
    ])
  })

  test('keeps model-visible title and context when degrading documents', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_prov',
          content: [
            {
              type: 'document',
              title: 'Auth specification',
              context: 'The examples use production credentials',
              source: { type: 'text', media_type: 'text/plain', data: 'Bearer abc123' },
            },
            {
              type: 'document',
              title: 'Policy',
              context: 'Applies to tenant A',
              source: { type: 'content', content: [{ type: 'text', text: 'quoted' }] },
            },
          ],
        }],
      }],
    }

    const result = anthropicToOpenaiChat(req)

    expect(result.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'tc_prov',
        content: '[Document: Auth specification]\n[Document context: The examples use production credentials]\nBearer abc123\n[Document: Policy]\n[Document context: Applies to tenant A]\nquoted',
      },
    ])
  })

  test('keeps model-visible title and context for top-level user documents', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            title: 'Auth specification',
            context: 'The examples use production credentials',
            source: { type: 'text', media_type: 'text/plain', data: 'Bearer abc123' },
          },
          {
            type: 'document',
            title: 'Contract',
            context: 'Applies to tenant A',
            source: { type: 'url', url: 'https://example.test/contract.pdf' },
          },
        ],
      }],
    }

    const result = anthropicToOpenaiChat(req)

    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Document: Auth specification]\n[Document context: The examples use production credentials]\nBearer abc123' },
          // The URL reference already carries the title as its label, so only
          // the context gets a synthetic prefix.
          { type: 'text', text: '[Document context: Applies to tenant A]\n[Document: Contract](https://example.test/contract.pdf)' },
        ],
      },
    ])
  })

  test('keeps inline images of custom-content documents in top-level user content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          title: 'cited',
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', source: { type: 'url', url: 'https://example.test/img.png' } },
            ],
          },
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Document: cited]\n' },
          { type: 'text', text: 'before' },
          { type: 'image_url', image_url: { url: 'https://example.test/img.png' } },
        ],
      },
    ])
  })

  test('keeps the interleaved text/image order of custom-content documents', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          title: 'cited',
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
              { type: 'text', text: 'after' },
            ],
          },
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Document: cited]\n' },
          { type: 'text', text: 'before' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,a' } },
          { type: 'text', text: 'after' },
        ],
      },
    ])
  })

  test('degrades top-level file-based user images to a visible text notice', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'file', file_id: 'file-9' } },
        ],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'user', content: [
        { type: 'text', text: 'look at this' },
        { type: 'text', text: '\n[Image omitted: file-based image source is not supported by this endpoint.]\n' },
      ] },
    ])
  })

  test('keeps user text after tool results after tool messages', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'tool_result', tool_use_id: 'tc_1', content: 'result' },
          { type: 'text', text: 'after' },
        ],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'user', content: 'before' },
      { role: 'tool', tool_call_id: 'tc_1', content: 'result' },
      { role: 'user', content: 'after' },
    ])
  })
  test('image content conversion', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req)
    const content = result.messages[0].content as Array<{ type: string; image_url?: { url: string } }>
    expect(content[0].type).toBe('image_url')
    expect(content[0].image_url!.url).toBe('data:image/png;base64,abc123')
  })

  test('text-only chat endpoints omit image payloads instead of emitting image_url parts', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this screenshot?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req, { imageContentMode: 'text_only' })
    expect(result.messages[0].content).toBe(
      'What is in this screenshot?\n[Image omitted: this OpenAI-compatible chat endpoint only supports text content.]\n',
    )
    expect(JSON.stringify(result)).not.toContain('image_url')
    expect(JSON.stringify(result)).not.toContain('abc123')
  })

  test('text-only mode emits one omission notice per image-only tool result', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_img',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
          }],
        }],
      }],
    }
    const result = anthropicToOpenaiChat(req, { imageContentMode: 'text_only' })
    expect(result.messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_img', content: '\n[Image omitted: this OpenAI-compatible chat endpoint only supports text content.]\n' },
    ])
    expect(JSON.stringify(result)).not.toContain('image_url')
    expect(JSON.stringify(result)).not.toContain('abc123')
  })

  test('text-only mode keeps plain-text documents instead of omitting them', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_doc',
          content: [
            { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'actual tool result' } },
            {
              type: 'document',
              title: 'cited',
              source: { type: 'content', content: [{ type: 'text', text: 'quoted passage' }] },
            },
          ],
        }],
      }],
    }
    const result = anthropicToOpenaiChat(req, { imageContentMode: 'text_only' })
    expect(result.messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_doc', content: '[Document: notes.txt]\nactual tool result\n[Document: cited]\nquoted passage' },
    ])
    expect(JSON.stringify(result)).not.toContain('image_url')
  })

  test('text-only mode degrades inline document images to a text notice', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          title: 'cited',
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
              { type: 'text', text: 'after' },
            ],
          },
        }],
      }],
    }
    const result = anthropicToOpenaiChat(req, { imageContentMode: 'text_only' })
    expect(result.messages).toEqual([
      {
        role: 'user',
        content: '[Document: cited]\nbefore\n[Image omitted: this OpenAI-compatible chat endpoint only supports text content.]\nafter',
      },
    ])
    expect(JSON.stringify(result)).not.toContain('image_url')
    expect(JSON.stringify(result)).not.toContain('abc123')
  })

  test('text-only mode keeps explicit boundaries around top-level documents', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'document', title: 'spec', source: { type: 'text', media_type: 'text/plain', data: 'DOC' } },
          { type: 'text', text: 'after' },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req, { imageContentMode: 'text_only' })
    // Raw text blocks keep their exact bytes, but a document is a discrete
    // block: its degraded text must not glue itself to the surrounding text.
    expect(result.messages).toEqual([
      { role: 'user', content: 'before\n[Document: spec]\nDOC\nafter' },
    ])
  })

  test('text-only mode keeps explicit boundaries around top-level search results', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          {
            type: 'search_result',
            title: 'Result title',
            content: [{ type: 'text', text: 'Snippet body' }],
            source: 'https://example.test/result',
          },
          { type: 'text', text: 'after' },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req, { imageContentMode: 'text_only' })
    expect(result.messages).toEqual([
      { role: 'user', content: 'before\nResult title — Snippet body — https://example.test/result\nafter' },
    ])
  })

  test('keeps tool-result search results separate from adjacent text', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_search',
          content: [
            { type: 'text', text: 'before' },
            {
              type: 'search_result',
              title: 'Result title',
              content: [{ type: 'text', text: 'Snippet body' }],
              source: 'https://example.test/result',
            },
            { type: 'text', text: 'after' },
          ],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_search', content: 'before\nResult title — Snippet body — https://example.test/result\nafter' },
    ])
  })

  test('text-only mode does not duplicate line boundaries the text already provides', () => {
    const req: AnthropicRequest = {
      model: 'deepseek-v4-pro',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before\n' },
          { type: 'document', title: 'spec', source: { type: 'text', media_type: 'text/plain', data: 'DOC' } },
          { type: 'text', text: '\nafter' },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req, { imageContentMode: 'text_only' })
    // The serializer must not rewrite bytes the prompt already carries: a
    // single boundary newline, no extra blank line.
    expect(result.messages).toEqual([
      { role: 'user', content: 'before\n[Document: spec]\nDOC\nafter' },
    ])
  })

  test('does not duplicate line boundaries after tool-result documents', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_doc',
          content: [
            { type: 'document', title: 'spec', source: { type: 'text', media_type: 'text/plain', data: 'DOC' } },
            { type: 'text', text: '\nafter' },
          ],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_doc', content: '[Document: spec]\nDOC\nafter' },
    ])
  })

  test('does not duplicate line boundaries after tool-result search results', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_search',
          content: [
            {
              type: 'search_result',
              title: 'Result title',
              content: [{ type: 'text', text: 'Snippet body' }],
              source: 'https://example.test/result',
            },
            { type: 'text', text: '\nafter' },
          ],
        }],
      }],
    }

    expect(anthropicToOpenaiChat(req).messages).toEqual([
      { role: 'tool', tool_call_id: 'tc_search', content: 'Result title — Snippet body — https://example.test/result\nafter' },
    ])
  })
})

// ─── openaiChatToAnthropic ──────────────────────────────────────

describe('openaiChatToAnthropic', () => {
  test('basic text response', () => {
    const res: OpenAIChatResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test('tool_calls response', () => {
    const res: OpenAIChatResponse = {
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].id).toBe('call_1')
      expect(result.content[0].name).toBe('get_weather')
      expect(result.content[0].input).toEqual({ city: 'NYC' })
    }
  })

  test('tool_calls response preserves object arguments from local proxies', () => {
    const res: OpenAIChatResponse = {
      id: 'chatcmpl-write',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_write',
            type: 'function',
            function: {
              name: 'Write',
              arguments: { file_path: '/tmp/issue-288.txt', content: 'ok' },
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }

    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].name).toBe('Write')
      expect(result.content[0].input).toEqual({
        file_path: '/tmp/issue-288.txt',
        content: 'ok',
      })
    }
  })

  test('finish_reason mapping', () => {
    const make = (reason: string) => ({
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: reason }],
    } as OpenAIChatResponse)

    expect(openaiChatToAnthropic(make('stop'), 'gpt-4').stop_reason).toBe('end_turn')
    expect(openaiChatToAnthropic(make('length'), 'gpt-4').stop_reason).toBe('max_tokens')
    expect(() => openaiChatToAnthropic(make('tool_calls'), 'gpt-4')).toThrow('no tool calls')
    expect(openaiChatToAnthropic(make('content_filter'), 'gpt-4').stop_reason).toBe('end_turn')
  })

  test('empty choices cannot become a successful response', () => {
    const res: OpenAIChatResponse = {
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4',
      choices: [],
    }
    expect(() => openaiChatToAnthropic(res, 'gpt-4')).toThrow('no message choice')
  })

  test('cached tokens mapping', () => {
    const res: OpenAIChatResponse = {
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.usage.cache_read_input_tokens).toBe(80)
  })
})

// ─── anthropicToOpenaiResponses ─────────────────────────────────

describe('anthropicToOpenaiResponses', () => {
  test('keeps Computer Use optional fields optional on the Responses wire', () => {
    const tools = buildComputerUseTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
    const original = structuredClone(tools)
    const wire = JSON.parse(JSON.stringify(anthropicToOpenaiResponses({
      model: 'gpt-6-astra',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Read the Blender window' }],
      tools,
    })))

    // Omitting strict lets Responses normalize every property to required.
    // That made both non-nullable diff aliases mandatory while the executor
    // correctly rejected their simultaneous presence (Blender regression).
    for (const tool of wire.tools) {
      expect(tool.strict).toBe(false)
      expect(tool.parameters).toEqual(original.find(t => t.name === tool.name)!.input_schema)
    }
    const state = wire.tools.find((tool: { name: string }) => tool.name === 'get_app_state')
    expect(state.parameters.required).toEqual(['app'])
    expect(state.parameters.properties.disableDiff.type).toBe('boolean')
    expect(state.parameters.properties.disable_diff.type).toBe('boolean')
    const click = wire.tools.find((tool: { name: string }) => tool.name === 'click')
    expect(click.parameters.required).toEqual(['app'])
    expect(tools).toEqual(original)
  })

  test('basic message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 1024,
      system: 'Be helpful',
      messages: [{ role: 'user', content: 'Hello' }],
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.model).toBe('gpt-4o')
    expect(result.instructions).toBe('Be helpful')
    expect(result.store).toBe(false)
    expect(result.tools).toBeUndefined()
    expect(result.max_output_tokens).toBe(1024)
    expect(result.input).toEqual([{ type: 'message', role: 'user', content: 'Hello' }])
  })

  test('omits Anthropic sampling params by default for Responses-compatible providers', () => {
    const req: AnthropicRequest = {
      model: 'glm-5.2',
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const result = anthropicToOpenaiResponses(req)
    expect(result.temperature).toBeUndefined()
    expect(result.top_p).toBeUndefined()
  })

  test('can explicitly pass sampling params for Responses providers that accept them', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const result = anthropicToOpenaiResponses(req, { passSamplingParams: true })
    expect(result.temperature).toBe(0.7)
    expect(result.top_p).toBe(0.9)
  })

  test('tools conversion uses top-level name', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0]).toEqual({
      type: 'function',
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      strict: false,
    })
  })

  test('tool_use lifted to function_call', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc_1', name: 'search', input: { q: 'test' } },
        ],
      }],
    }
    const result = anthropicToOpenaiResponses(req)
    const fc = result.input.find((i) => i.type === 'function_call')
    expect(fc).toBeDefined()
    if (fc && fc.type === 'function_call') {
      expect(fc.call_id).toBe('tc_1')
      expect(fc.name).toBe('search')
      expect(fc.arguments).toBe('{"q":"test"}')
    }
  })

  test('tool_result lifted to function_call_output', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: 'found it' },
        ],
      }],
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'tc_1',
      output: 'found it',
    }])
  })

  test('normalizes empty tool_result arrays to an empty string', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc_empty', content: [] }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'tc_empty',
      output: '',
    }])
  })

  test('preserves text-only tool_result arrays as strings', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc_2',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'tc_2',
      // Adjacent text blocks are joined without a separator — the wire shape
      // carries no newline between them.
      output: 'firstsecond',
    }])
  })

  test('preserves image-only tool_result content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_1',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAECAwQ=' },
          }],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_1',
      output: [{
        type: 'input_image',
        image_url: 'data:image/png;base64,AAECAwQ=',
      }],
    }])
  })

  test('preserves mixed tool_result content in order', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_2',
          content: [
            { type: 'text', text: 'before' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AA==' },
            },
            { type: 'text', text: 'after' },
          ],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_2',
      output: [
        { type: 'input_text', text: 'before' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AA==' },
        { type: 'input_text', text: 'after' },
      ],
    }])
  })

  test('preserves image URL sources in tool_result content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_url',
          content: [{
            type: 'image',
            source: { type: 'url', url: 'https://example.test/shot.png' },
          }],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_url',
      output: [{
        type: 'input_image',
        image_url: 'https://example.test/shot.png',
      }],
    }])
  })

  test('maps document blocks to input_file in tool_result content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_doc',
          content: [
            {
              type: 'document',
              title: 'report.pdf',
              source: { type: 'base64', media_type: 'application/pdf', data: 'pdf-data' },
            },
            {
              type: 'document',
              source: { type: 'url', url: 'https://example.test/report.pdf' },
            },
          ],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_doc',
      output: [
        // The titled base64 document keeps its model-visible title as a
        // synthetic prefix ahead of the input_file part.
        { type: 'input_text', text: '[Document: report.pdf]\n' },
        { type: 'input_file', file_data: 'data:application/pdf;base64,pdf-data', filename: 'report.pdf' },
        { type: 'input_file', file_url: 'https://example.test/report.pdf' },
      ],
    }])
  })

  test('maps search_result blocks to input_text in tool_result content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_search',
          content: [
            {
              type: 'search_result',
              title: 'Result title',
              content: [{ type: 'text', text: 'Snippet body' }],
              source: 'https://example.test/result',
            },
          ],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_search',
      // A search_result is not a text block: the output keeps its array shape
      // instead of flattening into a joined string.
      output: [{ type: 'input_text', text: 'Result title — Snippet body — https://example.test/result' }],
    }])
  })

  test('keeps text documents as input_text instead of base64 in tool_result content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_textdoc',
          content: [
            { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'hello world' } },
          ],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_textdoc',
      // A document is not a text block: the output keeps its array shape
      // instead of flattening into a joined string. The model-visible title
      // stays as a synthetic prefix.
      output: [{ type: 'input_text', text: '[Document: notes.txt]\nhello world' }],
    }])
  })

  test('keeps inline images of custom-content documents in tool_result content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_cdoc',
          content: [{
            type: 'document',
            title: 'cited',
            source: {
              type: 'content',
              content: [
                { type: 'text', text: 'before' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
                { type: 'text', text: 'after' },
              ],
            },
          }],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_cdoc',
      output: [
        { type: 'input_text', text: '[Document: cited]\n' },
        { type: 'input_text', text: 'before' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc' },
        { type: 'input_text', text: 'after' },
      ],
    }])
  })

  test('degrades file-based image sources to a visible text notice', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read_file',
          content: [
            { type: 'image', source: { type: 'file', file_id: 'file-123' } },
          ],
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'read_file',
      output: [{ type: 'input_text', text: '[Image omitted: file-based image source is not supported by this endpoint.]' }],
    }])
  })

  test('preserves image URL sources in ordinary message content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'url', url: 'https://example.test/photo.png' },
        }],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_image',
        image_url: 'https://example.test/photo.png',
      }],
    }])
  })

  test('preserves message and tool_result item order', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before result' },
          { type: 'tool_result', tool_use_id: 'read_3', content: 'result' },
          { type: 'text', text: 'after result' },
        ],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([
      { type: 'message', role: 'user', content: 'before result' },
      { type: 'function_call_output', call_id: 'read_3', output: 'result' },
      { type: 'message', role: 'user', content: 'after result' },
    ])
  })

  test('preserves mixed text and image message content', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAECAwQ=' },
          },
        ],
      }],
    }

    const result = anthropicToOpenaiResponses(req)

    expect(result.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe this image' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAECAwQ=' },
      ],
    }])
  })

  test('thinking → reasoning', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 10000 },
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.reasoning).toEqual({ effort: 'high' })
  })

  test('OpenAI OAuth mode restores namespaced redacted thinking as encrypted reasoning input', () => {
    const req = {
      model: 'gpt-5.6-terra',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [{
          type: 'redacted_thinking',
          data: 'cc-haha:openai-reasoning:v1:{"id":"rs_1","summary":[],"encrypted_content":"encrypted-reasoning"}',
        }],
      }],
    } as AnthropicRequest

    expect(anthropicToOpenaiResponses(req).input).toEqual([])
    expect(anthropicToOpenaiResponses(req, { preserveOpenAIReasoning: true }).input).toEqual([{
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'encrypted-reasoning',
    }])
  })

  test('output_config effort → reasoning effort', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    }

    const result = anthropicToOpenaiResponses(req)
    expect(result.reasoning).toEqual({ effort: 'high' })
  })

  test('preserves xhigh output_config effort for Responses API', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.6-luna',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'xhigh' },
    }

    const result = anthropicToOpenaiResponses(req)
    expect(result.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('preserves max output_config effort for Responses API', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'max' },
    }

    const result = anthropicToOpenaiResponses(req)
    expect(result.reasoning).toEqual({ effort: 'max' })
  })

  test('stop_sequences dropped', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      stop_sequences: ['END'],
    }
    const result = anthropicToOpenaiResponses(req)
    expect((result as Record<string, unknown>).stop).toBeUndefined()
    expect((result as Record<string, unknown>).stop_sequences).toBeUndefined()
  })

  // Responses names the function inline. The nested {function:{name}} shape is
  // Chat Completions syntax and strict upstreams (xAI) reject it.
  test('tool_choice type=tool names the function inline, not nested', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.tool_choice).toEqual({ type: 'function', name: 'get_weather' })
  })

  test('drops tool_choice when the request carries no tools', () => {
    for (const choice of [
      { type: 'auto' },
      { type: 'any' },
      { type: 'tool', name: 'get_weather' },
    ]) {
      const result = anthropicToOpenaiResponses({
        model: 'gpt-4o',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: choice,
      } as AnthropicRequest)
      expect(result.tools).toBeUndefined()
      expect(result.tool_choice).toBeUndefined()
    }
  })

  test('drops a tool_choice orphaned by tool filtering', () => {
    const result = anthropicToOpenaiResponses({
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      // BatchTool is filtered out of the tool list, so a choice naming it
      // would point at a tool the upstream never receives.
      tools: [{ name: 'BatchTool', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'BatchTool' },
    } as AnthropicRequest)
    expect(result.tools).toBeUndefined()
    expect(result.tool_choice).toBeUndefined()
  })

  test('keeps a tool_choice whose target survives filtering', () => {
    const result = anthropicToOpenaiResponses({
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'BatchTool', input_schema: { type: 'object' } },
        { name: 'get_weather', input_schema: { type: 'object' } },
      ],
      tool_choice: { type: 'tool', name: 'get_weather' },
    } as AnthropicRequest)
    expect(result.tools).toHaveLength(1)
    expect(result.tool_choice).toEqual({ type: 'function', name: 'get_weather' })
  })
})

// ─── openaiResponsesToAnthropic ─────────────────────────────────

describe('openaiResponsesToAnthropic', () => {
  test('basic text response', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_1',
      object: 'response',
      created_at: 1234567890,
      model: 'gpt-4o',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello!' }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test('function_call → tool_use', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_2',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'search',
        arguments: '{"q":"test"}',
      }],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].id).toBe('call_1')
      expect(result.content[0].input).toEqual({ q: 'test' })
    }
  })

  test('function_call preserves object arguments from local proxies', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_write',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_write',
        call_id: 'call_write',
        name: 'Write',
        arguments: { file_path: '/tmp/issue-288.txt', content: 'ok' },
      }],
    }

    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].input).toEqual({
        file_path: '/tmp/issue-288.txt',
        content: 'ok',
      })
    }
  })

  test('reasoning → thinking', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_3',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'r_1', summary: [{ type: 'text', text: 'Thinking...' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Result' }] },
      ],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('thinking')
    if (result.content[0].type === 'thinking') {
      expect(result.content[0].thinking).toBe('Thinking...')
    }
    expect(result.content[1].type).toBe('text')
  })

  test('OpenAI OAuth mode preserves encrypted reasoning as namespaced redacted thinking', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_reasoning_encrypted',
      object: 'response',
      created_at: 0,
      model: 'gpt-5.6-terra',
      status: 'completed',
      output: [{
        type: 'reasoning',
        id: 'rs_encrypted',
        summary: [],
        encrypted_content: 'opaque-reasoning',
      }],
    }

    const result = openaiResponsesToAnthropic(
      res,
      'gpt-5.6-terra',
      { preserveOpenAIReasoning: true },
    )

    expect(result.content[0]).toMatchObject({ type: 'redacted_thinking' })
    if (result.content[0].type === 'redacted_thinking') {
      expect(result.content[0].data).toContain('opaque-reasoning')
    }
  })

  test('OpenAI OAuth mode falls back to reasoning summary without encrypted content', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_reasoning_summary',
      object: 'response',
      created_at: 0,
      model: 'gpt-5.6-terra',
      status: 'completed',
      output: [{
        type: 'reasoning',
        id: 'rs_summary',
        summary: [{ type: 'summary_text', text: 'safe summary' }],
      }],
    }

    const result = openaiResponsesToAnthropic(
      res,
      'gpt-5.6-terra',
      { preserveOpenAIReasoning: true },
    )

    expect(result.content).toEqual([{ type: 'thinking', thinking: 'safe summary' }])
  })

  test('status incomplete → max_tokens', () => {
    const res: OpenAIResponsesResponse = {
      incomplete_details: { reason: 'max_output_tokens' },
      id: 'resp_4',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'incomplete',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.stop_reason).toBe('max_tokens')
  })

  test('empty output', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_5',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'completed',
      output: [],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.content).toEqual([{ type: 'text', text: '' }])
  })
})

// ─── stripLeadingBillingHeader ──────────────────────────────────

describe('stripLeadingBillingHeader', () => {
  test('returns text unchanged when no billing header prefix', () => {
    expect(stripLeadingBillingHeader('You are helpful')).toBe('You are helpful')
  })

  test('strips a single-line billing header to empty string', () => {
    expect(stripLeadingBillingHeader(BILLING_HEADER)).toBe('')
  })

  test('strips leading header line and its blank separator', () => {
    expect(stripLeadingBillingHeader(`${BILLING_HEADER}\n\nYou are helpful`)).toBe('You are helpful')
  })

  test('strips leading header line followed directly by text', () => {
    expect(stripLeadingBillingHeader(`${BILLING_HEADER}\nYou are helpful`)).toBe('You are helpful')
  })

  test('handles CRLF line endings', () => {
    expect(stripLeadingBillingHeader(`${BILLING_HEADER}\r\n\r\nYou are helpful`)).toBe('You are helpful')
  })

  test('keeps later occurrences inside user-authored text', () => {
    const text = `You are helpful.\n${BILLING_HEADER}`
    expect(stripLeadingBillingHeader(text)).toBe(text)
  })
})

// ─── resolvePromptCacheKey ──────────────────────────────────────

describe('resolvePromptCacheKey', () => {
  const baseRequest = (metadata?: AnthropicRequest['metadata']): AnthropicRequest => ({
    model: 'gpt-5.4',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
    ...(metadata ? { metadata } : {}),
  })

  test('extracts session suffix from metadata.user_id', () => {
    const body = baseRequest({ user_id: 'user_3f7a_account_9b2c_session_sess-42aa' })
    expect(resolvePromptCacheKey(body)).toBe('sess-42aa')
  })

  test('falls back to metadata.session_id', () => {
    const body = baseRequest({ session_id: 'direct-session-id' })
    expect(resolvePromptCacheKey(body)).toBe('direct-session-id')
  })

  test('falls back to the CLI session header', () => {
    expect(resolvePromptCacheKey(baseRequest(), ' header-session ')).toBe('header-session')
  })

  test('prefers user_id session over session_id and header', () => {
    const body = baseRequest({ user_id: 'user_x_session_from-user-id', session_id: 'from-metadata' })
    expect(resolvePromptCacheKey(body, 'from-header')).toBe('from-user-id')
  })

  test('returns undefined without any client session identity', () => {
    expect(resolvePromptCacheKey(baseRequest())).toBeUndefined()
    expect(resolvePromptCacheKey(baseRequest(), '   ')).toBeUndefined()
    expect(resolvePromptCacheKey(baseRequest({ user_id: 'user_without_marker' }))).toBeUndefined()
  })

  test('ignores empty session suffix in user_id', () => {
    expect(resolvePromptCacheKey(baseRequest({ user_id: 'user_x_session_' }))).toBeUndefined()
  })
})

// ─── openaiUsageToAnthropic ─────────────────────────────────────

describe('openaiUsageToAnthropic', () => {
  test('maps Responses-style cached tokens and excludes them from input', () => {
    const usage = openaiUsageToAnthropic({
      input_tokens: 100,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 80 },
    })
    expect(usage).toEqual({ input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80 })
  })

  test('maps Chat-style cached tokens as fallback', () => {
    const usage = openaiUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 30 },
    })
    expect(usage).toEqual({ input_tokens: 70, output_tokens: 5, cache_read_input_tokens: 30 })
  })

  test('prefers direct Anthropic-style cache fields over nested details', () => {
    const usage = openaiUsageToAnthropic({
      input_tokens: 100,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 80 },
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    })
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    })
  })

  test('derives missing prompt and completion counts from total tokens', () => {
    expect(openaiUsageToAnthropic({
      total_tokens: 120,
      completion_tokens: 20,
    })).toEqual({ input_tokens: 100, output_tokens: 20 })

    expect(openaiUsageToAnthropic({
      total_tokens: 120,
      prompt_tokens: 100,
    })).toEqual({ input_tokens: 100, output_tokens: 20 })
  })

  test('uses total-only usage as a conservative context anchor', () => {
    expect(openaiUsageToAnthropic({ total_tokens: 120 }))
      .toEqual({ input_tokens: 120, output_tokens: 0 })
  })

  test('does not turn output-only usage into a false prompt anchor', () => {
    expect(openaiUsageToAnthropic({ completion_tokens: 20 }))
      .toEqual({ input_tokens: 0, output_tokens: 20 })
  })

  test('rejects strings, negative numbers, and non-finite usage values', () => {
    expect(openaiUsageToAnthropic({
      input_tokens: '100' as never,
      output_tokens: -1,
      total_tokens: Number.POSITIVE_INFINITY,
      cache_read_input_tokens: Number.NaN,
    })).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  test('leaves input untouched and omits cache fields without cache activity', () => {
    expect(openaiUsageToAnthropic({ input_tokens: 10, output_tokens: 5 }))
      .toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  test('caps malformed nested cached tokens at the reported input', () => {
    const usage = openaiUsageToAnthropic({
      input_tokens: 50,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 80 },
    })
    expect(usage.input_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(50)
  })

  test('returns zeros for missing usage', () => {
    expect(openaiUsageToAnthropic(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

// ─── prompt caching semantics in request transforms ─────────────

describe('prompt caching semantics', () => {
  test('responses transform strips leading billing header from system array', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.4',
      max_tokens: 64,
      system: [
        { type: 'text', text: BILLING_HEADER },
        { type: 'text', text: 'You are helpful' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.instructions).toBe('You are helpful')
  })

  test('responses transform strips leading billing header from system string', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.4',
      max_tokens: 64,
      system: `${BILLING_HEADER}\n\nYou are helpful`,
      messages: [{ role: 'user', content: 'hi' }],
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.instructions).toBe('You are helpful')
  })

  test('responses transform omits instructions when system is only a billing header', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.4',
      max_tokens: 64,
      system: [{ type: 'text', text: BILLING_HEADER }],
      messages: [{ role: 'user', content: 'hi' }],
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.instructions).toBeUndefined()
  })

  test('responses transform injects prompt_cache_key when provided', () => {
    const req: AnthropicRequest = {
      model: 'gpt-5.4',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }
    expect(anthropicToOpenaiResponses(req, { cacheKey: 'sess-1' }).prompt_cache_key).toBe('sess-1')
    expect(anthropicToOpenaiResponses(req).prompt_cache_key).toBeUndefined()
  })

  test('chat transform strips leading billing header from system', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 64,
      system: [
        { type: 'text', text: BILLING_HEADER },
        { type: 'text', text: 'You are helpful' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful' })
  })

  test('chat transform omits system message when system is only a billing header', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 64,
      system: BILLING_HEADER,
      messages: [{ role: 'user', content: 'hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  test('chat transform requests stream usage explicitly', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }
    expect(anthropicToOpenaiChat(req, {}).stream_options).toBeUndefined()
    expect(anthropicToOpenaiChat({ ...req, stream: true }).stream_options).toEqual({ include_usage: true })
  })

  test('responses non-streaming maps cached tokens into Anthropic usage', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_cache',
      object: 'response',
      created_at: 0,
      model: 'gpt-5.4',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
      usage: {
        input_tokens: 1200,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 1000 },
      },
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-5.4')
    expect(result.usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cache_read_input_tokens: 1000,
    })
  })

  test('chat non-streaming subtracts cached tokens from input', () => {
    const res: OpenAIChatResponse = {
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.usage).toEqual({
      input_tokens: 20,
      output_tokens: 50,
      cache_read_input_tokens: 80,
    })
  })
})
