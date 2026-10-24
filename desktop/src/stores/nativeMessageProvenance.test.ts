import { describe, expect, it } from 'vitest'
import { nativeMessageMatches, sameNativeMessageIds, stampNativeMessageProvenance } from './nativeMessageProvenance'
import type { UIMessage } from '@/types/chat'

describe('native refusal provenance', () => {
  it('matches streamed and hydrated frames but preserves human messages', () => {
    const ids = new Set(['withdrawn'])
    expect(nativeMessageMatches({ id: 'local', type: 'assistant_text', content: 'partial', timestamp: 1, nativeMessageIds: ['withdrawn'] }, ids)).toBe(true)
    expect(nativeMessageMatches({ id: 'withdrawn-block-2', type: 'thinking', content: 'partial', timestamp: 1 }, ids)).toBe(true)
    expect(nativeMessageMatches({ id: 'other', type: 'assistant_text', transcriptMessageId: 'withdrawn', content: 'partial', timestamp: 1 }, ids)).toBe(true)
    expect(nativeMessageMatches({ id: 'withdrawn', type: 'user_text', content: 'original', timestamp: 1 }, ids)).toBe(false)
    expect(nativeMessageMatches({ id: 'withdrawn-block-not-an-index', type: 'thinking', content: 'kept', timestamp: 1 }, ids)).toBe(false)
  })
  it('separates flushed text provenance from the new tool frame', () => {
    const next: UIMessage[] = [
      { id: 'text', type: 'assistant_text', content: 'kept', timestamp: 1 },
      { id: 'tool', type: 'tool_use', toolUseId: 'tool', toolName: 'Read', input: {}, timestamp: 2 },
    ]
    const result = stampNativeMessageProvenance([], next, { type: 'tool_use_complete', toolName: 'Read', toolUseId: 'tool', input: {}, nativeMessageIds: ['new'] }, ['previous'])
    expect(result[0]!.nativeMessageIds).toEqual(['previous'])
    expect(result[1]!.nativeMessageIds).toEqual(['new'])
    expect(sameNativeMessageIds(undefined, [])).toBe(true)
    expect(sameNativeMessageIds(['a'], ['b'])).toBe(false)
    expect(stampNativeMessageProvenance(result, result, { type: 'message_complete', usage: { input_tokens: 0, output_tokens: 0 } }, ['later'])).toEqual(result)
    expect(stampNativeMessageProvenance([], [{ id: 'error', type: 'error', code: 'refusal', message: 'paused', timestamp: 1 }],
      { type: 'error', code: 'refusal', message: 'paused', nativeMessageIds: ['refusal-error'] })[0]!.nativeMessageIds).toEqual(['refusal-error'])
  })
})
