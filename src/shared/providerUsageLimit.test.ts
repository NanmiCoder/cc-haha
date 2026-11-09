import { expect, test } from 'bun:test'
import { inspectProviderUsageError } from './providerUsageLimit.js'

test('inspects nested provider errors without mistaking short limits or invalid keys for quota exhaustion', () => {
  const go = { error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' }, metadata: { limitName: 'monthly' } }
  expect(inspectProviderUsageError({ error: { message: `Upstream returned HTTP 429: ${JSON.stringify(go)}` } })).toEqual({ usageLimit: true, invalidCredential: false })
  expect(inspectProviderUsageError({ error: { code: 'insufficient_quota', message: 'Check your plan' } })).toEqual({ usageLimit: true, invalidCredential: false })
  expect(inspectProviderUsageError({ error: { code: 'insufficient_quota', message: 'Quota exhausted for requests/minute' } })).toEqual({ usageLimit: false, invalidCredential: false })
  expect(inspectProviderUsageError({ error: { code: 'invalid_api_key', message: 'Your quota was exhausted.' } })).toEqual({ usageLimit: false, invalidCredential: true })
  expect(inspectProviderUsageError({ error: { message: 'API key you provided has expired. Your monthly quota was exhausted.' } })).toEqual({ usageLimit: true, invalidCredential: true })
})
