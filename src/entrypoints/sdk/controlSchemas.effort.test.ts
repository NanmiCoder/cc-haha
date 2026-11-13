import { describe, expect, test } from 'bun:test'
import {
  SDKControlGetSettingsResponseSchema,
  SDKControlRequestSchema,
} from './controlSchemas.js'

describe('SDKControlGetSettingsResponseSchema effort', () => {
  test('accepts every runtime named effort level including xhigh', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        SDKControlGetSettingsResponseSchema().safeParse({
          effective: {},
          sources: [],
          applied: {
            model: 'gpt-5.6-sol',
            effort,
          },
        }).success,
      ).toBe(true)
    }
  })

  test('rejects unknown runtime effort values', () => {
    expect(
      SDKControlGetSettingsResponseSchema().safeParse({
        effective: {},
        sources: [],
        applied: {
          model: 'gpt-5.6-sol',
          effort: 'extreme',
        },
      }).success,
    ).toBe(false)
  })
})

describe('SDKControlRequestSchema agent continuation', () => {
  test('accepts a typed follow-up message for an existing subagent', () => {
    expect(SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'continue-1',
      request: {
        subtype: 'send_agent_message',
        agent_id: 'agent-123',
        content: 'Continue reviewing the patch.',
      },
    }).success).toBe(true)
  })

  test('rejects an empty follow-up message', () => {
    expect(SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'continue-2',
      request: {
        subtype: 'send_agent_message',
        agent_id: 'agent-123',
        content: '',
      },
    }).success).toBe(false)
  })
})

describe('SDK team runtime controls', () => {
  test('requires a durable human-intent identity for team resume', () => {
    const request = { subtype: 'team_runtime_resume', team_name: 'reviewed', created_at: 123, incarnation_id: 'incarnation', epoch: 2, request_id: 'human-resume' }
    const parse = (request: unknown) => SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'control-resume', request })
    expect(parse(request).success).toBe(true)
    for (const key of ['team_name', 'created_at', 'incarnation_id', 'epoch', 'request_id']) {
      const incomplete = { ...request } as Record<string, unknown>
      delete incomplete[key]
      expect(parse(incomplete).success).toBe(false)
    }
  })
  test('requires a generation on structured team snapshots', () => {
    expect(SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'snapshot', request: { subtype: 'team_runtime_snapshot', team_name: 'reviewed', created_at: 123 } }).success).toBe(true)
    expect(SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'snapshot', request: { subtype: 'team_runtime_snapshot', team_name: 'reviewed' } }).success).toBe(false)
  })
  test('names the team the host ended', () => {
    expect(SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'ended', request: { subtype: 'team_runtime_ended', team_name: 'reviewed' } }).success).toBe(true)
    expect(SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'ended', request: { subtype: 'team_runtime_ended' } }).success).toBe(false)
  })
  test('accepts planning pause without ending the SDK session', () => {
    expect(SDKControlRequestSchema().safeParse({ type: 'control_request', request_id: 'pause', request: { subtype: 'team_plan_pause' } }).success).toBe(true)
  })
})
