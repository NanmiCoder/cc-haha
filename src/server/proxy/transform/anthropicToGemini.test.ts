import { describe, expect, test } from 'bun:test'

import {
  anthropicToGemini,
  decodeGeminiThoughtSignature,
  encodeGeminiThoughtSignature,
} from './anthropicToGemini.js'
import type { AnthropicRequest } from './types.js'

const MODEL = 'gemini-4-argon-contributor'

function request(overrides: Partial<AnthropicRequest>): AnthropicRequest {
  return { model: MODEL, max_tokens: 32000, messages: [{ role: 'user', content: 'hello' }], ...overrides }
}

describe('anthropicToGemini', () => {
  test('maps the system prompt to systemInstruction without the rotating billing header', () => {
    const body = anthropicToGemini(request({
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cch=abc;\n\nYou are a helper.' },
        { type: 'text', text: 'Be brief.' },
      ],
    }))
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are a helper.' }, { text: 'Be brief.' }] })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
  })

  test('asks for thought summaries at the level Claude Code requested', () => {
    // What Claude Code sends for a third-party model with effort xhigh.
    const body = anthropicToGemini(request({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } }))
    expect(body.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' })

    expect(anthropicToGemini(request({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }))
      .generationConfig?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'medium' })
    expect(anthropicToGemini(request({ thinking: { type: 'enabled', budget_tokens: 1024 } }))
      .generationConfig?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
    // Thinking switched off: no summaries, and no level to pin.
    expect(anthropicToGemini(request({ thinking: { type: 'disabled' } }), { budgetSource: 'default' }).generationConfig)
      .toBeUndefined()
  })

  test('omits the default output budget like OpenAI Chat, and sends an explicit one', () => {
    expect(anthropicToGemini(request({}), { budgetSource: 'default' }).generationConfig).toBeUndefined()
    expect(anthropicToGemini(request({ max_tokens: 4096 }), { budgetSource: 'explicit' }).generationConfig)
      .toEqual({ maxOutputTokens: 4096 })
  })

  test('declares tools with a JSON schema Gemini accepts and maps tool_choice', () => {
    const body = anthropicToGemini(request({
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              limit: { type: 'integer', minimum: 0, exclusiveMinimum: true },
              ratio: { type: 'number', maximum: 1, exclusiveMaximum: true },
            },
            required: ['file_path', 'ghost'],
          },
        },
        { name: 'BatchTool', input_schema: { type: 'object' } },
      ],
      tool_choice: { type: 'tool', name: 'Read' },
    }))
    expect(body.tools).toEqual([{
      functionDeclarations: [{
        name: 'Read',
        description: 'Read a file',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            limit: { type: 'integer', exclusiveMinimum: 0 },
            ratio: { type: 'number', exclusiveMaximum: 1 },
          },
          required: ['file_path'],
        },
      }],
    }])
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['Read'] } })
  })

  test('replays the thought signature on the call it came with', () => {
    const body = anthropicToGemini(request({
      messages: [
        { role: 'user', content: 'Read a.txt' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need the file.', signature: encodeGeminiThoughtSignature('sig-thought') },
            { type: 'redacted_thinking', data: encodeGeminiThoughtSignature('sig-call') },
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.txt' } },
            { type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: 'b.txt' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'alpha' },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'missing', is_error: true },
            { type: 'text', text: '<system-reminder>keep going</system-reminder>' },
          ],
        },
      ],
    }))
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Read a.txt' }] },
      {
        role: 'model',
        parts: [
          { text: 'Need the file.', thought: true, thoughtSignature: 'sig-thought' },
          { functionCall: { id: 'call_1', name: 'Read', args: { file_path: 'a.txt' } }, thoughtSignature: 'sig-call' },
          // Gemini signs only the first of parallel calls.
          { functionCall: { id: 'call_2', name: 'Read', args: { file_path: 'b.txt' } } },
        ],
      },
      // The function-response turn answers the calls alone; other content follows it.
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call_1', name: 'Read', response: { output: 'alpha' } } },
          { functionResponse: { id: 'call_2', name: 'Read', response: { error: 'missing' } } },
        ],
      },
      { role: 'user', parts: [{ text: '<system-reminder>keep going</system-reminder>' }] },
    ])
  })

  test('marks a call without a Gemini signature with the documented validator bypass', () => {
    // A call made by another model earlier in the session, or a signature from
    // another protocol, must not be sent as if Gemini had signed it.
    const body = anthropicToGemini(request({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'other model', signature: 'anthropic-signature' },
            { type: 'redacted_thinking', data: 'cc-haha:openai-reasoning:v1:{}' },
            { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      ],
    }))
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'other model', thought: true },
        { functionCall: { id: 'call_1', name: 'Bash', args: { command: 'ls' } }, thoughtSignature: 'skip_thought_signature_validator' },
      ],
    })
  })

  test('sends images inline, nested in the function response for tool results', () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } }
    const body = anthropicToGemini(request({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, image] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'Screenshot', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [{ type: 'text', text: 'taken' }, image] }] },
      ],
    }))
    expect(body.contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
    })
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{
        functionResponse: {
          id: 'shot',
          name: 'Screenshot',
          response: { output: 'taken' },
          parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
        },
      }],
    })
  })

  test('keeps documents, search results and unfetchable media visible to Gemini', () => {
    const body = anthropicToGemini(request({
      messages: [{
        role: 'user',
        content: [
          { type: 'document', title: 'Spec', context: 'v2', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } },
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'plain body' } },
          { type: 'document', title: 'Notes', source: { type: 'content', content: 'inline notes' } },
          {
            type: 'document',
            source: {
              type: 'content',
              content: [
                { type: 'text', text: 'figure:' },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
                { type: 'text', text: '' },
              ],
            },
          },
          { type: 'document', source: { type: 'url', url: 'https://example.test/a.pdf' } },
          { type: 'document', title: 'Upload', source: { type: 'file', file_id: 'file_1' } },
          { type: 'search_result', source: 'https://example.test', title: 'Result', content: [{ type: 'text', text: 'snippet' }] },
          // Gemini fetches no URLs and cannot read Anthropic Files API references.
          { type: 'image', source: { type: 'url', url: 'https://example.test/cat.png' } },
          { type: 'image', source: { type: 'file', file_id: 'file_2' } },
        ],
      }],
    }))
    expect(body.contents).toEqual([{
      role: 'user',
      parts: [
        { text: '[Document: Spec]\n[Document context: v2]\n' },
        { inlineData: { mimeType: 'application/pdf', data: 'JVBE' } },
        { text: 'plain body' },
        { text: '[Document: Notes]\n' },
        { text: 'inline notes' },
        { text: 'figure:' },
        { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } },
        { text: '[Document: https://example.test/a.pdf](https://example.test/a.pdf)' },
        { text: '[Document: Upload omitted — file-based source]' },
        { text: 'Result — snippet — https://example.test' },
        { text: '[Image: https://example.test/cat.png]' },
        { text: '[Image omitted: file-based image source is not supported by this endpoint.]' },
      ],
    }])
  })

  test('replays a call whose input was recorded as a JSON string', () => {
    const body = anthropicToGemini(request({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'thinking', thinking: '' },
            { type: 'tool_use', id: 'a', name: 'Bash', input: '{"command":"ls"}' as unknown as Record<string, unknown> },
            { type: 'tool_use', id: 'b', name: 'Bash', input: '{not json' as unknown as Record<string, unknown> },
          ],
        },
      ],
    }))
    expect(body.contents[1]!.parts.map(part => part.functionCall?.args)).toEqual([{ command: 'ls' }, {}])
  })

  test('sends sampling only when the endpoint accepts it, and asks for JSON output by schema', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } } }
    const withSampling = anthropicToGemini(
      request({ temperature: 0.2, top_p: 0.9, output_config: { format: { type: 'json_schema', schema } } }),
      { budgetSource: 'default', requestCompatibility: { sampling: 'supported' } },
    )
    expect(withSampling.generationConfig).toEqual({
      temperature: 0.2,
      topP: 0.9,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    })
    // Claude Code always sends sampling params; most compatible upstreams reject them.
    expect(anthropicToGemini(request({ temperature: 0.2 }), { budgetSource: 'default' }).generationConfig).toBeUndefined()
  })

  test('maps every tool_choice and drops one naming an unknown tool', () => {
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }]
    expect(anthropicToGemini(request({ tools, tool_choice: { type: 'auto' } })).toolConfig)
      .toEqual({ functionCallingConfig: { mode: 'AUTO' } })
    expect(anthropicToGemini(request({ tools, tool_choice: { type: 'any' } })).toolConfig)
      .toEqual({ functionCallingConfig: { mode: 'ANY' } })
    expect(anthropicToGemini(request({ tools, tool_choice: 'none' })).toolConfig)
      .toEqual({ functionCallingConfig: { mode: 'NONE' } })
    expect(anthropicToGemini(request({ tools, tool_choice: { type: 'tool', name: 'Write' } })).toolConfig).toBeUndefined()
    expect(anthropicToGemini(request({ tools })).toolConfig).toBeUndefined()
  })

  test('round-trips its signature envelope and ignores anything else', () => {
    expect(decodeGeminiThoughtSignature(encodeGeminiThoughtSignature('abc'))).toBe('abc')
    expect(decodeGeminiThoughtSignature('abc')).toBeUndefined()
    expect(decodeGeminiThoughtSignature(encodeGeminiThoughtSignature(''))).toBeUndefined()
    expect(decodeGeminiThoughtSignature(undefined)).toBeUndefined()
  })
})
