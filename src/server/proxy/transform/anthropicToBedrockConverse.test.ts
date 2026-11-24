import { describe, expect, test } from 'bun:test'
import {
  anthropicToBedrockConverse,
  normalizeBedrockToolCallId,
} from './anthropicToBedrockConverse.js'
import { encodeGeminiThoughtSignature } from './anthropicToGemini.js'
import type { AnthropicRequest } from './types.js'

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('anthropicToBedrockConverse', () => {
  test('converts system, messages, tools, images, documents, and serviceTier', () => {
    const req: AnthropicRequest = {
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      max_tokens: 2048,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cch=abc123;\nYou are a helpful coding assistant.' },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file from disk',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      tool_choice: { type: 'auto' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this screenshot and PDF.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
            {
              type: 'document',
              title: 'spec_v1.pdf',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' },
            },
          ],
        },
      ],
    }

    const out = anthropicToBedrockConverse(req, {
      requestCompatibility: { serviceTier: 'flex' },
    })

    expect(out.system).toEqual([{ text: 'You are a helpful coding assistant.' }])
    expect(out.inferenceConfig?.maxTokens).toBe(2048)
    expect(out.serviceTier).toEqual({ type: 'flex' })
    expect(out.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'Read',
            description: 'Read a file from disk',
            inputSchema: {
              json: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
            },
          },
        },
      ],
      toolChoice: { auto: {} },
    })

    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]!.role).toBe('user')
    expect(out.messages[0]!.content).toEqual([
      { text: 'Inspect this screenshot and PDF.' },
      { image: { format: 'png', source: { bytes: TINY_PNG_BASE64 } } },
      { text: '[Document: spec_v1.pdf]\n' },
      { document: { format: 'pdf', name: 'specv1', source: { bytes: 'JVBERi0xLjQK' } } },
    ])
  })

  test('maps Claude thinking, drops sampling params when thinking is enabled, and replays signed/redacted reasoning while filtering foreign signatures', () => {
    const req: AnthropicRequest = {
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      output_config: { effort: 'high' },
      tools: [
        { name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
      messages: [
        { role: 'user', content: 'Check image' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Unsigned thought that should be omitted' },
            { type: 'thinking', thinking: 'Foreign Gemini thought', signature: encodeGeminiThoughtSignature('gem-sig') },
            { type: 'thinking', thinking: 'Valid Bedrock Claude thought  ', signature: 'bedrock-sig-123' },
            { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' },
            { type: 'redacted_thinking', data: encodeGeminiThoughtSignature('gem-redacted') },
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'a.png' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: [
                { type: 'text', text: 'Read image OK' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
              ],
            },
          ],
        },
      ],
    }

    const out = anthropicToBedrockConverse(req, { passSamplingParams: true })

    // Bumps maxTokens above thinking.budget_tokens and strips temperature/topP
    expect(out.inferenceConfig?.maxTokens).toBe(3072)
    expect(out.inferenceConfig?.temperature).toBeUndefined()
    expect(out.inferenceConfig?.topP).toBeUndefined()
    expect(out.additionalModelRequestFields).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2048 },
      output_config: { effort: 'high' },
    })

    // Assistant reasoning preserves exact bytes of signed thought & redactedContent, skipping unsigned & Gemini
    expect(out.messages[1]!.content).toEqual([
      { reasoningContent: { reasoningText: { text: 'Valid Bedrock Claude thought  ', signature: 'bedrock-sig-123' } } },
      { reasoningContent: { redactedContent: 'cmVkYWN0ZWQ=' } },
      { toolUse: { toolUseId: 'toolu_01', name: 'Read', input: { path: 'a.png' } } },
    ])

    // Nested image preserved inside toolResult.content
    expect(out.messages[2]!.content).toEqual([
      {
        toolResult: {
          toolUseId: 'toolu_01',
          content: [
            { text: 'Read image OK' },
            { image: { format: 'png', source: { bytes: TINY_PNG_BASE64 } } },
          ],
        },
      },
    ])
  })

  test('hoists tool_result media when supportsNestedToolResultMedia is false', () => {
    const req: AnthropicRequest = {
      model: 'meta.llama3-2-90b-instruct-v1:0',
      max_tokens: 512,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'Open image' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
              ],
            },
          ],
        },
      ],
    }

    const out = anthropicToBedrockConverse(req, { supportsNestedToolResultMedia: false })
    expect(out.messages[2]!.content).toEqual([
      {
        toolResult: {
          toolUseId: 'toolu_1',
          content: [{ text: 'Media result attached after this tool result.' }],
        },
      },
      { text: '[Media content for tool call toolu_1]' },
      { image: { format: 'png', source: { bytes: TINY_PNG_BASE64 } } },
    ])
  })

  test('handles Nova 2 high reasoning (omitting maxTokens), Mistral 9-char toolCallIds, and tool-less history fallback', () => {
    const nova = anthropicToBedrockConverse({
      model: 'amazon.nova-2-lite-v1:0',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'Solve this' }],
    })
    expect(nova.additionalModelRequestFields).toEqual({
      reasoningConfig: { type: 'enabled', maxReasoningEffort: 'high' },
    })
    expect(nova.inferenceConfig?.maxTokens).toBeUndefined()

    const normalized = normalizeBedrockToolCallId('tooluse_bpe71yCfRu2b5i-nKGDr5g', true)
    expect(normalized).toMatch(/^[a-zA-Z0-9]{9}$/)
    expect(normalizeBedrockToolCallId(normalized, true)).toBe(normalized)
    expect(normalizeBedrockToolCallId('toolu_abc_123', false)).toBe('toolu_abc_123')

    // When no tools are passed, historical tool_use / tool_result degrade to text so Bedrock never throws ValidationException
    const withoutTools = anthropicToBedrockConverse({
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'Run it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { cmd: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'file.ts' }] },
      ],
    })
    expect(withoutTools.toolConfig).toBeUndefined()
    expect(withoutTools.messages[1]!.content[0]).toEqual({ text: '[Tool call Bash({"cmd":"ls"})]' })
    expect(withoutTools.messages[2]!.content[0]).toEqual({ text: '[Tool result toolu_x]: file.ts' })
  })

  test('guards empty tool_result and whitespace prefill, enforces maxTokens > thinking budget under default budgetSource, drops Claude topP when temperature is set, and requests stop_sequence', () => {
    // 1) Empty tool_result content and whitespace-only trailing assistant prefill never emit `{ text: "" }`
    const guarded = anthropicToBedrockConverse({
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 10_000 },
      tools: [{ name: 'Noop', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_empty', name: 'Noop', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_empty', content: '' }] },
        { role: 'assistant', content: '   \n\t  ' },
      ],
    }, { budgetSource: 'default' })

    expect(guarded.messages).toHaveLength(3)
    expect(guarded.messages[2]!.content).toEqual([
      { toolResult: { toolUseId: 'toolu_empty', content: [{ text: '(empty)' }] } },
    ])
    // Under budgetSource: 'default', Claude thinking budget >= 4096 still ensures inferenceConfig.maxTokens > budget_tokens
    expect(guarded.inferenceConfig?.maxTokens).toBe(14_096)
    expect(guarded.additionalModelResponseFieldPaths).toEqual(['/delta/stop_sequence'])

    // Respect explicit outputTokenLimit cap when above budget_tokens
    const capped = anthropicToBedrockConverse({
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 10_000 },
      messages: [{ role: 'user', content: 'hi' }],
    }, { budgetSource: 'default', requestCompatibility: { outputTokenLimit: 12_000 } })
    expect(capped.inferenceConfig?.maxTokens).toBe(12_000)

    // 2) Bedrock Claude drops topP when temperature is also present; non-Anthropic Bedrock models keep both
    const claudeSampling = anthropicToBedrockConverse({
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      max_tokens: 512,
      temperature: 0.4,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
    }, { passSamplingParams: true })
    expect(claudeSampling.inferenceConfig?.temperature).toBe(0.4)
    expect(claudeSampling.inferenceConfig?.topP).toBeUndefined()

    const novaSampling = anthropicToBedrockConverse({
      model: 'amazon.nova-pro-v1:0',
      max_tokens: 512,
      temperature: 0.4,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hello' }],
    }, { passSamplingParams: true })
    expect(novaSampling.inferenceConfig?.temperature).toBe(0.4)
    expect(novaSampling.inferenceConfig?.topP).toBe(0.9)
    expect(novaSampling.additionalModelResponseFieldPaths).toBeUndefined()
  })
})
