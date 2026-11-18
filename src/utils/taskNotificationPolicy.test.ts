import { describe, expect, test } from 'bun:test'
import {
  addTaskNotificationModelGuidance,
  parseTaskNotificationXml,
  shouldForwardTaskNotificationToModel,
  TaskNotificationFollowUpBatch,
} from './taskNotificationPolicy.js'

describe('task notification policy', () => {
  test('preserves lifecycle payloads when adding model-only guidance', () => {
    const notification = '<task-notification><task-id>failure</task-id><status>failed</status><summary>Failed with exit code 143</summary><result>Original details</result></task-notification>'
    const guided = addTaskNotificationModelGuidance(notification)
    expect(typeof guided).toBe('string')
    expect((guided as string).startsWith(notification)).toBe(true)
    expect(parseTaskNotificationXml(guided as string)).toEqual(parseTaskNotificationXml(notification))
    expect(addTaskNotificationModelGuidance(guided)).toBe(guided)
  })

  test('defers local agent terminal notifications in structured output', () => {
    const notification = parseTaskNotificationXml(`<task-notification>
<task-id>agent-1</task-id>
<task-type>local_agent</task-type>
<output-file>/tmp/agent-1.out</output-file>
<status>completed</status>
<summary>Agent "Probe" completed</summary>
</task-notification>`)

    expect(shouldForwardTaskNotificationToModel(notification, { structuredOutput: true })).toBe(false)
  })

  test('keeps local agent notifications as model input for plain print mode', () => {
    const notification = parseTaskNotificationXml(`<task-notification>
<task-id>agent-1</task-id>
<task-type>local_agent</task-type>
<output-file>/tmp/agent-1.out</output-file>
<status>completed</status>
<summary>Agent "Probe" completed</summary>
</task-notification>`)

    expect(shouldForwardTaskNotificationToModel(notification, { structuredOutput: false })).toBe(true)
  })

  test('continues forwarding background shell notifications to the model', () => {
    const notification = parseTaskNotificationXml(`<task-notification>
<task-id>bash-1</task-id>
<output-file>/tmp/bash-1.out</output-file>
<status>completed</status>
<summary>Background command "bun test" completed</summary>
</task-notification>`)

    expect(shouldForwardTaskNotificationToModel(notification, { structuredOutput: true })).toBe(true)
  })

  test('keeps the stable workflow run id on terminal notifications', () => {
    const notification = parseTaskNotificationXml(`<task-notification>
<task-id>workflow-task-1</task-id>
<tool-use-id>workflow-tool-1</tool-use-id>
<task-type>local_workflow</task-type>
<workflow-run-id>wf_shared-run-1</workflow-run-id>
<output-file>/tmp/workflow-task-1.out</output-file>
<status>completed</status>
<summary>Workflow completed</summary>
</task-notification>`)

    expect(notification.workflowRunId).toBe('wf_shared-run-1')
  })

  test('combines deferred local agent completions into exactly one follow-up', () => {
    const batch = new TaskNotificationFollowUpBatch()
    const first = '<task-notification><task-id>agent-1</task-id></task-notification>'
    const second = '<task-notification><task-id>agent-2</task-id></task-notification>'

    batch.defer(first)
    batch.defer(second)

    expect(batch.hasPending()).toBe(true)
    expect(batch.takeIfSettled(true)).toBeUndefined()
    expect(batch.hasPending()).toBe(true)
    expect(batch.takeIfSettled(false)).toBe(`${first}\n${second}`)
    expect(batch.hasPending()).toBe(false)
    expect(batch.takeIfSettled(false)).toBeUndefined()
  })
})
