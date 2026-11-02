import { describe, expect, it } from 'bun:test'
import { formatScheduledTaskPrompt, readScheduledTaskMetadata, scheduledTaskDisplayText, scheduledTaskMessageInputSchema } from './scheduledTaskMessage.js'

describe('host scheduled task messages', () => {
  const metadata = { taskId: 'task', runId: 'run', scheduledFor: '2026-10-26T01:00:00Z', taskName: 'Check' }
  it('requires structured provenance rather than a matching prompt', () => {
    expect(readScheduledTaskMetadata('<scheduled_task>task</scheduled_task>')).toBeUndefined()
    expect(readScheduledTaskMetadata({ ...metadata, runId: '' })).toBeUndefined()
    expect(readScheduledTaskMetadata(metadata)).toEqual(metadata)
  })
  it('keeps saved instructions separate from model-facing notification guidance', () => {
    const prompt = 'Check status\n"quoted" <xml>content</xml>'
    const content = formatScheduledTaskPrompt(prompt, 'run', true)
    expect(content).toContain('action report')
    expect(scheduledTaskDisplayText(content)).toBe(prompt)
    expect(scheduledTaskDisplayText([{ type: 'text', text: content }])).toBe(prompt)
    expect(scheduledTaskDisplayText('normal user text')).toBe('normal user text')
  })
  it('validates the independent SDK control message', () => {
    const input = { subtype: 'enqueue_scheduled_task', message_id: 'occurrence', text: 'Check', scheduled_task: metadata }
    expect(scheduledTaskMessageInputSchema.safeParse(input).success).toBe(true)
    expect(scheduledTaskMessageInputSchema.safeParse({ ...input, sender_session_id: 'spoof' }).success).toBe(false)
    const longPrompt = '\u0001'.repeat(32_000)
    const wrapped = formatScheduledTaskPrompt(longPrompt, 'run', true)
    expect(scheduledTaskMessageInputSchema.safeParse({ ...input, text: wrapped }).success).toBe(true)
    expect(scheduledTaskDisplayText(wrapped)).toBe(longPrompt)
  })
})
