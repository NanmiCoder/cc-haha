import { expect, test } from 'bun:test'
import { agentDesktopToolResult } from './agentDesktopResult.js'

const emptyImage = {
  version: '2.5',
  ok: true,
  command: 'clipboard-get',
  data: { type: 'image', found: false },
}

test('reading an absent clipboard image preserves the successful not-found observation', async () => {
  const result = await agentDesktopToolResult({
    stdout: JSON.stringify(emptyImage), stderr: '', exitCode: 0,
  }, '/unused-host-artifacts', false)

  expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(emptyImage) }] })
})

test('an empty clipboard image in a batch does not discard the other observations', async () => {
  const envelope = {
    version: '2.5', ok: true, command: 'batch',
    data: { results: [emptyImage, { ok: true, command: 'status', data: { platform: 'linux' } }] },
  }
  const result = await agentDesktopToolResult({
    stdout: JSON.stringify(envelope), stderr: '', exitCode: 0,
  }, '/unused-host-artifacts', false)

  expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(envelope) }] })
})

test.each([
  ['', { attempted: false, rendered: null }],
  ['CC_HAHA_CURSOR_FEEDBACK {"acknowledged":true,"warning":null}', { attempted: true, rendered: true }],
  ['CC_HAHA_CURSOR_FEEDBACK {"acknowledged":false,"warning":null}', { attempted: true, rendered: null }],
  ['CC_HAHA_CURSOR_FEEDBACK {"acknowledged":false,"warning":{"code":"TIMEOUT","message":"renderer pipe did not respond"}}', {
    attempted: true, rendered: false, warning: { code: 'TIMEOUT', message: 'renderer pipe did not respond' },
  }],
])('preserves input delivery independently of cursor feedback %#', async (line, feedback) => {
  const envelope = { ok: true, command: 'click', data: { disposition: { delivery: 'delivered_verified' } } }
  const result = await agentDesktopToolResult({
    stdout: JSON.stringify(envelope),
    stderr: `native warning\r\n${line}\r\nCC_HAHA_CURSOR_FEEDBACK invalid`,
    exitCode: 0,
  }, '/unused-host-artifacts', false, 'click', { configured: true })

  expect(result).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ ...envelope, cursor_overlay: { configured: true, ...feedback } }) }],
  })
})
