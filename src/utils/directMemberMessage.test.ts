import { expect, test } from 'bun:test'
import { parseDirectMemberMessage, sendDirectMemberMessage } from './directMemberMessage.js'

const teamContext = {
  teamName: 'review',
  leadAgentId: 'team-lead@review',
  teammates: { 'reader@review': { name: 'reader' } },
} as never

test('a direct member message is reported as sent only once it is persisted', async () => {
  const parsed = parseDirectMemberMessage('@reader please re-check runner.ts')
  expect(parsed).toEqual({ recipientName: 'reader', message: 'please re-check runner.ts' })

  const written: unknown[] = []
  expect(await sendDirectMemberMessage('reader', 'hi', teamContext, async (...args) => { written.push(args); return true }))
    .toEqual({ success: true, recipientName: 'reader' })
  expect(written).toHaveLength(1)

  // A contended or unreadable inbox must not look like a delivered message.
  expect(await sendDirectMemberMessage('reader', 'hi', teamContext, async () => false))
    .toEqual({ success: false, error: 'delivery_failed', recipientName: 'reader' })
  expect(await sendDirectMemberMessage('stranger', 'hi', teamContext, async () => true))
    .toEqual({ success: false, error: 'unknown_recipient', recipientName: 'stranger' })
})
