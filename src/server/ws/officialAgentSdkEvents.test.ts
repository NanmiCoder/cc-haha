import { describe, expect, test } from 'bun:test'
import { toOfficialSdkServerNotification } from './officialAgentSdkEvents.js'

describe('official SDK notification transport', () => {
  test('preserves refusal identity, scope, nulls and exact retraction targets', () => {
    const data = { type: 'system', subtype: 'model_refusal_fallback', scope: 'local',
      original_model: 'model-a', fallback_model: 'model-b', request_id: null,
      refused_user_message_uuid: null, retracted_message_uuids: ['partial-a', 'result-b'],
      api_refusal_category: 'new-category', api_refusal_explanation: null,
      content: 'Retrying response', uuid: 'event', session_id: 'native-session' }
    expect(toOfficialSdkServerNotification(data)).toEqual({
      type: 'system_notification', subtype: data.subtype, message: data.content,
      data: { ...data, official_agent_sdk: true },
    })
    expect(data).not.toHaveProperty('official_agent_sdk')
  })

  test('preserves no-fallback and credit choice events without inventing a model change', () => {
    for (const subtype of ['model_refusal_no_fallback', 'model_consent_fallback']) {
      const data = { type: 'system', subtype, original_model: 'model-a', choice: 'cancelled',
        persisted_as_default: false, content: 'Stopped', uuid: 'event' }
      expect(toOfficialSdkServerNotification(data)?.data).toEqual({ ...data, official_agent_sdk: true })
    }
  })

  test('forwards reset identity and unknown triggers for host deduplication', () => {
    const data = { type: 'conversation_reset', new_conversation_id: 'new',
      user_message_uuid: 'clear-message', trigger: 'future-trigger', timestamp: '2026-01-01T00:00:00Z' }
    expect(toOfficialSdkServerNotification(data)).toEqual({
      type: 'system_notification', subtype: 'conversation_reset', data: { ...data, official_agent_sdk: true },
    })
  })

  test('keeps empty level snapshots and command replacements authoritative', () => {
    expect(toOfficialSdkServerNotification({ type: 'system', subtype: 'commands_changed', commands: [] })?.data.commands).toEqual([])
    expect(toOfficialSdkServerNotification({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })?.data.tasks).toEqual([])
    expect(toOfficialSdkServerNotification({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'a', elicitation_id: 'b' })?.data).toMatchObject({ mcp_server_name: 'a', elicitation_id: 'b' })
  })

  test('preserves task run ordering metadata, nested patch and MCP result resources', () => {
    for (const subtype of ['task_started', 'task_progress', 'task_notification', 'task_updated']) {
      const data = { type: 'system', subtype, task_id: 'task', run_id: 'run-2',
        ambient: true, patch: { is_backgrounded: false, description: '' },
        resource_links: [{ uri: 'mcp://file', name: 'Result' }] }
      expect(toOfficialSdkServerNotification(data)?.data).toEqual({ ...data, official_agent_sdk: true })
    }
  })

  test('does not convert malformed or unrelated frames into destructive notifications', () => {
    for (const data of [
      null, [], { type: 'assistant', subtype: 'commands_changed', commands: [] },
      { type: 'system', subtype: 'init' }, { type: 'conversation_reset' },
      { type: 'system', subtype: 'commands_changed', commands: {} },
      { type: 'system', subtype: 'background_tasks_changed' },
      { type: 'system', subtype: 'task_updated', task_id: 't', patch: [] },
    ]) expect(toOfficialSdkServerNotification(data)).toBeNull()
  })
})
