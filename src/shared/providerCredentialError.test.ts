import { expect, test } from 'bun:test'
import { isInvalidSavedProviderKey } from './providerCredentialError.js'

test('recognizes only explicit invalid saved-key responses', () => {
  expect(isInvalidSavedProviderKey(401, { error: { type: 'authentication_error', message: 'Invalid credential' } })).toBe(true)
  expect(isInvalidSavedProviderKey(401, { error: { code: 'invalid_api_key', message: 'Check your account' } })).toBe(true)
  expect(isInvalidSavedProviderKey(401, { error: { message: 'The API key you provided is incorrect.' } })).toBe(true)
  expect(isInvalidSavedProviderKey(401, { error: { type: 'authentication_error', message: 'Authentication service unavailable' } })).toBe(false)
  expect(isInvalidSavedProviderKey(401, { error: { type: 'authentication_error', message: 'Authentication service unavailable; this is not an invalid API key, retry later.' } })).toBe(false)
  expect(isInvalidSavedProviderKey(401, { error: { type: 'authentication_error', code: 'invalid_token', message: 'Invalid bearer token' } })).toBe(false)
  expect(isInvalidSavedProviderKey(401, { error: { type: 'authentication_error', code: 'invalid_token', message: 'Invalid credential' } })).toBe(false)
  expect(isInvalidSavedProviderKey(401, { code: 'invalid_token', error: { type: 'authentication_error', message: 'Invalid credential' } })).toBe(false)
  expect(isInvalidSavedProviderKey(401, { code: 'invalid_api_key', error: { message: 'Check your account' } })).toBe(true)
  expect(isInvalidSavedProviderKey(401, { error: { message: 'Invalid credential' } })).toBe(false)
  expect(isInvalidSavedProviderKey(429, { error: { type: 'authentication_error', message: 'Invalid credential' } })).toBe(false)
  expect(isInvalidSavedProviderKey(401, 'Invalid credential')).toBe(false)
})
