import { describe, expect, it } from 'bun:test'
import { encodeOpenAIReasoningEnvelope } from '../proxy/transform/openaiReasoning.js'
import { createSessionProtocolAccumulator, inferSessionApiFormat } from './sessionProtocolHistory.js'

const user = { type: 'user', message: { role: 'user', content: 'hello' } }
const assistant = { type: 'assistant', message: { id: 'reply', role: 'assistant', model: 'same-model', content: 'hello' } }
const meta = (runtimeProviderId: string | null) => ({ type: 'session-meta', runtimeProviderId })

describe('legacy session protocol inference', () => {
  it('leaves selection-only and synthetic placeholder sessions unlocked', () => {
    expect(inferSessionApiFormat([meta('openai-official')])).toBeUndefined()
    expect(inferSessionApiFormat([{ ...assistant, message: { ...assistant.message, model: '<synthetic>' } }])).toBeUndefined()
  })

  it.each([
    [null, 'anthropic'], ['claude-official', 'anthropic'],
    ['openai-official', 'openai_responses'], ['grok-official', 'openai_responses'],
  ] as const)('uses the recorded immutable route %s', (provider, protocol) => {
    expect(inferSessionApiFormat([meta(provider), user, assistant])).toBe(protocol)
  })

  it('never guesses from model names or mutable saved-provider ids', () => {
    expect(inferSessionApiFormat([user, assistant])).toBe('unknown')
    expect(inferSessionApiFormat([meta('saved-provider'), user, assistant])).toBe('unknown')
  })

  it('does not count unused model selections or assign a later route to earlier messages', () => {
    expect(inferSessionApiFormat([meta(null), user, assistant, meta('openai-official')])).toBe('anthropic')
    expect(inferSessionApiFormat([user, assistant, meta('openai-official')])).toBe('unknown')
    expect(inferSessionApiFormat([meta(null), user, meta('openai-official')])).toBe('anthropic')
  })

  it('marks actual cross-protocol history mixed and incomplete evidence unknown', () => {
    expect(inferSessionApiFormat([meta(null), user, assistant, meta('openai-official'), user, assistant])).toBe('mixed')
    expect(inferSessionApiFormat([meta('saved'), user, assistant, meta('openai-official'), user, {
      ...assistant, message: { ...assistant.message, id: 'reply-2' },
    }])).toBe('unknown')
  })

  it('recognizes application-owned Responses evidence even across streamed content blocks', () => {
    const data = encodeOpenAIReasoningEnvelope({ type: 'reasoning', summary: [], encrypted_content: 'fixture-only' })!
    const reasoning = { ...assistant, message: { ...assistant.message, content: [{ type: 'redacted_thinking', data }] } }
    expect(inferSessionApiFormat([user, assistant, reasoning])).toBe('openai_responses')
    expect(inferSessionApiFormat([user, reasoning, assistant])).toBe('openai_responses')
    expect(inferSessionApiFormat([user, { ...reasoning, message: { ...reasoning.message, content: [{ type: 'redacted_thinking', data: 'opaque' }] } }])).toBe('unknown')
  })

  it('preserves explicit locks and detects conflicting locks', () => {
    const lock = { type: 'session-meta', sessionApiFormat: 'openai_chat' }
    expect(inferSessionApiFormat([lock, meta('saved-provider'), user, assistant])).toBe('openai_chat')
    expect(inferSessionApiFormat([lock, { ...lock, sessionApiFormat: 'anthropic' }])).toBe('mixed')
  })

  it('keeps incremental projection branches independent', () => {
    const base = createSessionProtocolAccumulator()
    base.add(meta(null))
    base.add(user)
    base.add(assistant)
    const changed = base.clone()
    changed.add(meta('openai-official'))
    changed.add(assistant)
    expect(changed.get()).toBe('mixed')
    expect(base.get()).toBe('anthropic')
  })
})
