import { expect, test } from 'bun:test'
import { SDKMessageSchema, SDKPromptSuggestionActivityMessageSchema } from './coreSchemas.js'

test('SDK prediction work bookends preserve the generation independently of user completion', () => {
  for (const active of [true, false]) {
    const message = { type: 'system', subtype: 'prompt_suggestion_activity', generation_id: 'prediction-generation',
      active, uuid: crypto.randomUUID(), session_id: 'session' }
    expect(SDKMessageSchema().parse(message)).toEqual(message)
    for (const invalid of [{ active: 'false' }, { generation_id: '' }, { generation_id: 'x'.repeat(129) }]) {
      expect(SDKPromptSuggestionActivityMessageSchema().safeParse({ ...message, ...invalid }).success).toBe(false)
    }
  }
})
