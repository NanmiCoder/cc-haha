import { expect, test } from 'bun:test'
import { translateCliMessage } from '../ws/handler.js'

test('carries the transcript identity of a provider error to the client', () => {
  const messages = translateCliMessage({
    type: 'assistant', uuid: 'quota-error-fixture', error: 'billing_error', isApiErrorMessage: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Go usage limit exceeded' }] },
  }, 'quota-error-session-fixture')
  expect(messages).toEqual([{
    type: 'error', code: 'billing_error', message: 'Go usage limit exceeded', transcriptMessageId: 'quota-error-fixture',
  }])
})
