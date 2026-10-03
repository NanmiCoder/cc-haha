import { expect, test } from 'bun:test'
import { formatTeammateMessages } from '../../utils/teammateMailbox.js'
import { parseTeammateMessages } from './UserTeammateMessage.js'

test('teammate envelope attributes read back as the text the teammate sent', () => {
  const text = formatTeammateMessages([
    { from: 'reviewer', color: 'blue', summary: 'Fix "auth" & <retry>', text: 'details' },
    { from: 'tester', text: 'plain' },
  ])

  expect(parseTeammateMessages(text)).toEqual([
    { teammateId: 'reviewer', color: 'blue', summary: 'Fix "auth" & <retry>', content: 'details' },
    { teammateId: 'tester', color: undefined, summary: undefined, content: 'plain' },
  ])
})
