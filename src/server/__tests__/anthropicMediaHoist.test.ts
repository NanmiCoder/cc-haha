import { describe, expect, test } from 'bun:test'
import type { AnthropicRequest } from '../proxy/transform/types.js'
import { hoistToolResultMediaForCompatibility } from '../proxy/transform/anthropicMediaHoist.js'

function makeRequest(messages: AnthropicRequest['messages']): AnthropicRequest {
  return { model: 'test-model', max_tokens: 100, messages }
}

describe('hoistToolResultMediaForCompatibility', () => {
  test('lifts nested images to the end of the user message and keeps tool results contiguous', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-a',
          content: [
            { type: 'text', text: 'before' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
            { type: 'text', text: 'after' },
          ],
        },
        {
          type: 'tool_result',
          tool_use_id: 'tool-b',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'b' } }],
        },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-a',
          content: [
            { type: 'text', text: 'before' },
            { type: 'text', text: 'after' },
          ],
        },
        {
          type: 'tool_result',
          tool_use_id: 'tool-b',
          content: [{ type: 'text', text: 'Media result attached after this tool result.' }],
        },
        { type: 'text', text: '[Image content for tool call tool-a]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
        { type: 'text', text: '[Image content for tool call tool-b]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'b' } },
      ],
    })
  })

  test('lifts documents alongside images', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-doc',
          content: [
            { type: 'document', title: 'report.pdf', source: { type: 'url', url: 'https://example.test/report.pdf' } },
          ],
        },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-doc', content: [{ type: 'text', text: 'Media result attached after this tool result.' }] },
        { type: 'text', text: '[Document content for tool call tool-doc]' },
        { type: 'document', title: 'report.pdf', source: { type: 'url', url: 'https://example.test/report.pdf' } },
      ],
    })
  })

  test('keeps lifted media ahead of trailing user text', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-shot',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        },
        { type: 'text', text: 'Please look at the top-left corner' },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-shot', content: [{ type: 'text', text: 'Media result attached after this tool result.' }] },
        { type: 'text', text: '[Image content for tool call tool-shot]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
        { type: 'text', text: 'Please look at the top-left corner' },
      ],
    })
  })

  test('preserves references for later messages that need no transform', () => {
    const body = makeRequest([
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-image',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'text', text: 'unchanged' }] },
    ])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[2]).toBe(body.messages[2])
  })

  test('describes mixed images and documents in the media marker', () => {
    const body = makeRequest([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-mixed-media',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
          { type: 'document', source: { type: 'url', url: 'https://example.test/report.pdf' } },
        ],
      }],
    }])

    const result = hoistToolResultMediaForCompatibility(body)
    const content = result.messages[0]?.content

    expect(Array.isArray(content) ? content[1] : undefined).toEqual({
      type: 'text',
      text: '[Media content for tool call tool-mixed-media: 1 image, 1 document]',
    })
  })

  test('leaves string tool results and media-free results untouched', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-text', content: 'plain result' },
        {
          type: 'tool_result',
          tool_use_id: 'tool-mixed',
          content: [{ type: 'text', text: 'text only' }],
        },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result).toBe(body)
    expect(result.messages).toEqual(body.messages)
  })

  test('leaves assistant messages and plain text user messages untouched', () => {
    const body = makeRequest([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
      },
    ])

    expect(hoistToolResultMediaForCompatibility(body)).toBe(body)
  })

  test('skips hoisting when the last assistant turn has an unresolved server tool call', () => {
    const body = makeRequest([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'searching' },
          { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-a',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        }],
      },
    ])

    expect(hoistToolResultMediaForCompatibility(body)).toBe(body)
  })

  test('hoists when a server tool call already has its result in the same turn', () => {
    const body = makeRequest([
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'x' } },
          { type: 'web_search_tool_result', tool_use_id: 'st_1', content: { type: 'web_search_result', query: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-a',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        }],
      },
    ] as unknown as AnthropicRequest['messages'])

    const result = hoistToolResultMediaForCompatibility(body)
    expect(result).not.toBe(body)
    expect(result.messages[1]).not.toEqual(body.messages[1])
  })

  test('hoists when a deferred server tool result arrived in the next assistant turn', () => {
    // Mixed server/client execution: the API returns the server_tool_use
    // without a result, the client returns only its own tool_result, and the
    // server tool result leads the next assistant response.
    const body = makeRequest([
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'st_1', name: 'web_fetch', input: { url: 'https://example.test' } },
          { type: 'tool_use', id: 't_1', name: 'run_command', input: { command: 'uname' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't_1', content: 'Linux' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'web_fetch_tool_result', tool_use_id: 'st_1', content: { type: 'web_fetch_result', url: 'https://example.test' } },
          { type: 'text', text: 'fetched' },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-a',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        }],
      },
    ] as unknown as AnthropicRequest['messages'])

    const result = hoistToolResultMediaForCompatibility(body)
    expect(result).not.toBe(body)
    expect(result.messages[3]).not.toEqual(body.messages[3])
  })

  test('lifts history media while leaving the unresolved continuation message untouched', () => {
    // A completed earlier turn with tool-result media stays convertible even
    // when the current turn continues an unresolved server tool — only the
    // continuation user message may not gain non-tool_result blocks.
    const body = makeRequest([
      { role: 'user', content: 'check this' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't_1', name: 'run_command', input: { command: 'ls' } }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'x' } },
          { type: 'tool_use', id: 't_2', name: 'run_command', input: { command: 'uname' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't_2',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b' } }],
        }],
      },
    ] as unknown as AnthropicRequest['messages'])

    const result = hoistToolResultMediaForCompatibility(body)
    expect(result).not.toBe(body)
    // History turn: media lifted out of the tool_result.
    expect(result.messages[2]).not.toEqual(body.messages[2])
    expect(result.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't_1', content: [{ type: 'text', text: 'Media result attached after this tool result.' }] },
        { type: 'text', text: '[Image content for tool call t_1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
      ],
    })
    // Continuation turn: left as-is.
    expect(result.messages[4]).toEqual(body.messages[4])
  })

  test('skips hoisting when the last assistant turn has an unresolved mcp_tool_use', () => {
    const body = makeRequest([
      {
        role: 'assistant',
        content: [
          { type: 'mcp_tool_use', id: 'mcp_1', name: 'slack', input: { action: 'list' } },
          { type: 'tool_use', id: 't_1', name: 'run_command', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        }],
      },
    ] as unknown as AnthropicRequest['messages'])

    expect(hoistToolResultMediaForCompatibility(body)).toBe(body)
  })

  test('hoists when an mcp_tool_use already has its result in the same turn', () => {
    const body = makeRequest([
      {
        role: 'assistant',
        content: [
          { type: 'mcp_tool_use', id: 'mcp_1', name: 'slack', input: { action: 'list' } },
          { type: 'mcp_tool_result', tool_use_id: 'mcp_1', content: { type: 'mcp_result', data: 'ok' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-a',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
        }],
      },
    ] as unknown as AnthropicRequest['messages'])

    const result = hoistToolResultMediaForCompatibility(body)
    expect(result).not.toBe(body)
    expect(result.messages[1]).not.toEqual(body.messages[1])
  })

  test('keeps plain-text documents inside the tool result as text', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-doc',
          content: [
            { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'actual tool result' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
          ],
        },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    // The plain-text document stays inside the tool result as text (its
    // provenance and title preserved); only the image lifts.
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-doc',
          content: [{ type: 'text', text: '[Document: notes.txt]\nactual tool result' }],
        },
        { type: 'text', text: '[Image content for tool call tool-doc]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
      ],
    })
  })

  test('degrades a text-only document without lifting any media', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-text-doc',
          content: [
            { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: 'result text' } },
          ],
        },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-text-doc',
          content: [{ type: 'text', text: '[Document: notes.txt]\nresult text' }],
        },
      ],
    })
    // No user-level media blocks were added.
    expect(result.messages[0].content).toHaveLength(1)
  })

  test('keeps text-only custom-content documents inside the tool result', () => {
    const body = makeRequest([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-cdoc-string',
            content: [
              { type: 'document', title: 'raw', source: { type: 'content', content: 'plain tool output' } },
            ],
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-cdoc-blocks',
            content: [
              {
                type: 'document',
                title: 'cited',
                source: {
                  type: 'content',
                  content: [
                    { type: 'text', text: 'Bearer ' },
                    { type: 'text', text: 'abc123' },
                  ],
                },
              },
            ],
          },
        ],
      },
    ])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-cdoc-string',
          content: [
            { type: 'text', text: '[Document: raw]' },
            { type: 'text', text: 'plain tool output' },
          ],
        },
      ],
    })
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-cdoc-blocks',
          content: [
            { type: 'text', text: '[Document: cited]' },
            // Original text block boundaries are preserved — no separators
            // are injected into the tool output.
            { type: 'text', text: 'Bearer ' },
            { type: 'text', text: 'abc123' },
          ],
        },
      ],
    })
    // No user-level media blocks were added.
    expect(result.messages[0].content).toHaveLength(1)
    expect(result.messages[1].content).toHaveLength(1)
  })

  test('preserves cache_control when degrading plain-text documents', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-cache',
          content: [
            { type: 'document', title: 'cached.txt', source: { type: 'text', media_type: 'text/plain', data: 'large cached output' }, cache_control: { type: 'ephemeral' } },
            { type: 'document', title: 'cited', source: { type: 'content', content: 'quoted' }, cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-cache',
          content: [
            { type: 'text', text: '[Document: cached.txt]\nlarge cached output', cache_control: { type: 'ephemeral' } },
            // The document-level breakpoint sits on the *last* degraded block
            // (the end of the cached prefix), not on the synthetic title.
            { type: 'text', text: '[Document: cited]' },
            { type: 'text', text: 'quoted', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    })
  })

  test('keeps model-visible title and context when degrading documents', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-prov',
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
        },
      ],
    }] as unknown as Parameters<typeof makeRequest>[0])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-prov',
          content: [
            { type: 'text', text: '[Document: Auth specification]\n[Document context: The examples use production credentials]\nBearer abc123' },
            { type: 'text', text: '[Document: Policy]' },
            { type: 'text', text: '[Document context: Applies to tenant A]' },
            { type: 'text', text: 'quoted' },
          ],
        },
      ],
    })
  })

  test('keeps nested cache_control and citations when degrading custom-content documents', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-nested',
          content: [
            {
              type: 'document',
              title: 'spec',
              source: {
                type: 'content',
                content: [
                  { type: 'text', text: 'cached chunk', cache_control: { type: 'ephemeral' } },
                  { type: 'text', text: 'cited chunk', citations: [{ type: 'char_location', cited_text: 'x' }] },
                ],
              },
            },
          ],
        },
      ],
    }] as unknown as Parameters<typeof makeRequest>[0])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-nested',
          content: [
            { type: 'text', text: '[Document: spec]' },
            { type: 'text', text: 'cached chunk', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'cited chunk', citations: [{ type: 'char_location', cited_text: 'x' }] },
          ],
        },
      ],
    })
  })

  test('does not overwrite an inner cache_control with the document-level breakpoint', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-outer',
          content: [
            {
              type: 'document',
              title: 'mixed',
              source: {
                type: 'content',
                content: [
                  { type: 'text', text: 'a' },
                  // The last degraded block already carries an inner marker —
                  // the document-level breakpoint must not clobber it.
                  { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
                ],
              },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    }] as unknown as Parameters<typeof makeRequest>[0])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-outer',
          content: [
            { type: 'text', text: '[Document: mixed]' },
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    })
  })

  test('lifts custom-content documents that carry inline images', () => {
    const body = makeRequest([{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-cdoc-img',
          content: [
            {
              type: 'document',
              title: 'cited',
              source: {
                type: 'content',
                content: [
                  { type: 'text', text: 'before' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
                ],
              },
            },
          ],
        },
      ],
    }])

    const result = hoistToolResultMediaForCompatibility(body)

    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-cdoc-img', content: [{ type: 'text', text: 'Media result attached after this tool result.' }] },
        { type: 'text', text: '[Document content for tool call tool-cdoc-img]' },
        {
          type: 'document',
          title: 'cited',
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
            ],
          },
        },
      ],
    })
  })

  test('hoists when typed client tools (bash, text_editor) are declared but no server call is pending', () => {
    const body = makeRequest([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-a',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
      }],
    }]) as AnthropicRequest & { tools: Array<Record<string, unknown>> }
    body.tools = [
      { name: 'bash', type: 'bash_20250124', input_schema: { type: 'object' } },
      { name: 'str_replace_editor', type: 'text_editor_20250728', input_schema: { type: 'object' } },
    ]

    const result = hoistToolResultMediaForCompatibility(body)
    expect(result).not.toBe(body)
    expect(result.messages[0]).not.toEqual(body.messages[0])
  })
})
