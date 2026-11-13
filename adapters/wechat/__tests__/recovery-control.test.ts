import { expect, test } from 'bun:test'
import { handleWechatJournalFull } from '../recovery-control.js'

test('full journal permits only authorized, deduplicated status/stop controls without model work', async () => {
  const events: string[] = []
  const seen = new Set<string>()
  const deps = {
    allowed: (id: string) => id === 'peer',
    first: (key: string) => { if (seen.has(key)) return false; seen.add(key); return true },
    context: () => { events.push('context') }, stop: () => { events.push('stop') },
    summary: () => 'fixture status', reply: async (_id: string, text: string) => { events.push(text) },
  }
  const messages = ['/delivery', '/stop', '/retry id', 'delete a file'].map((text, message_id) => ({ from_user_id: 'peer', message_id, item_list: [{ type: 1, text_item: { text } }] }))
  messages.push({ from_user_id: 'outsider', message_id: 99, item_list: [{ type: 1, text_item: { text: '/stop' } }] })
  await handleWechatJournalFull(messages, deps)
  await handleWechatJournalFull(messages, deps)
  expect(events.filter(event => event === 'stop')).toHaveLength(1)
  expect(events.filter(event => event.includes('fixture status'))).toHaveLength(2)
  expect(events).toHaveLength(5)
})
