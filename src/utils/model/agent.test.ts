import { afterEach, describe, expect, test } from 'bun:test'
import { isolateModelDefaultsEnv } from '../../testUtils/modelEnv.js'
import { getAgentModel } from './agent.js'

isolateModelDefaultsEnv()

const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

afterEach(() => {
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
  }
})

describe('getAgentModel', () => {
  test('treats CLAUDE_CODE_SUBAGENT_MODEL=inherit as normal parent resolution', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'

    expect(
      getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-haiku-4-5-20251001')
    expect(
      getAgentModel('inherit', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-sonnet-4-6')
  })

  test('treats the inherit sentinel case-insensitively', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'INHERIT'

    expect(
      getAgentModel('inherit', 'claude-opus-4-7', undefined, 'default'),
    ).toBe('claude-opus-4-7')
  })

  test('trims the inherit sentinel before applying normal Agent resolution', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = '  InHeRiT  '

    expect(
      getAgentModel('inherit', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-sonnet-4-6')
  })

  test('keeps a concrete environment override authoritative', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = '  provider-owned-model  '

    expect(
      getAgentModel('inherit', 'claude-opus-4-7', undefined, 'default'),
    ).toBe('provider-owned-model')
  })

  test('uses normal agent resolution for an empty environment override', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = ''

    expect(
      getAgentModel('inherit', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-sonnet-4-6')
  })
})
