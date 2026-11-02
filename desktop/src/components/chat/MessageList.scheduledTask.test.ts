import { expect, it } from 'vitest'
import { buildRenderModel } from './MessageList'
import type { UIMessage } from '@/types/chat'

const tool: UIMessage = { id: 'use', type: 'tool_use', toolUseId: 'call', toolName: 'ScheduledTask', input: {}, timestamp: 1 }
const result: UIMessage = { id: 'result', type: 'tool_result', toolUseId: 'call', isError: false, timestamp: 2, content: JSON.stringify({ schemaVersion: 1, kind: 'scheduled_task', operation: 'created', taskId: 'task', task: { id: 'task', name: 'Check', prompt: 'Check', cron: '0 9 * * *', enabled: true } }) }

it('lifts a successful task card outside collapsible tool activity', () => {
  const model = buildRenderModel([tool, result])
  expect(model.renderItems).toEqual([{ kind: 'message', message: tool }])
  expect(model.toolResultMap.get('call')).toBe(result)
})

it('keeps pending, failed and invalid task tool output in the ordinary tool trace', () => {
  for (const messages of [[tool], [tool, { ...result, isError: true }], [tool, { ...result, content: 'created' }]]) {
    expect(buildRenderModel(messages).renderItems[0]?.kind).toBe('tool_group')
  }
})
