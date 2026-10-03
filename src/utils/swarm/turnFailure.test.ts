import { expect, test } from 'bun:test'
import { formatTeammateAutoContinuePrompt, isTransientTurnFailure, summarizeTurnFailure } from './turnFailure.js'

test('provider and transport hiccups are transient; configuration and content errors are not', () => {
  for (const text of [
    'API Error: {"type":"error","error":{"type":"stream_truncated","message":"OpenAI Chat upstream stream ended without finish_reason"}}',
    'API Error: {"type":"error","error":{"type":"stream_error","message":"upstream reset"}}',
    'Provider stream ended before message_stop',
    'API Error: 503 Service Unavailable',
    'Request timed out',
    'API Error: Connection error.',
    'Repeated 529 Overloaded errors',
    'API Error: 429 rate_limit_error',
    'Upstream stream idle timeout after 240000ms',
  ]) expect(isTransientTurnFailure(text)).toBe(true)
  for (const text of [
    '',
    '   ',
    'Prompt is too long',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'API Error: 403 forbidden',
    'Credit balance is too low',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"model_not_found"}}',
    'Reached maximum turns (3)',
    '[Request interrupted by user]',
    'All findings written to reviews/runner.md',
  ]) expect(isTransientTurnFailure(text)).toBe(false)
})

test('failure summaries keep one clean, bounded line', () => {
  expect(summarizeTurnFailure('\n  API Error: 502\nstack trace line')).toBe('API Error: 502')
  expect(summarizeTurnFailure('bad\u0007 char')).toBe('bad char')
  expect(summarizeTurnFailure('x'.repeat(300), 10)).toBe(`${'x'.repeat(10)}…`)
})

test('the continuation prompt tells the member where it is in the retry budget', () => {
  const prompt = formatTeammateAutoContinuePrompt('API Error: 502', 2, 5)
  expect(prompt).toContain('API Error: 502')
  expect(prompt).toContain('automatic retry 2 of 5')
  expect(prompt).toContain('Do not redo steps that already finished')
})
