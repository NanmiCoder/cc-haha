import { describe, expect, test } from 'bun:test'
import { normalizeAnthropicBaseUrl } from './anthropicBaseUrl.js'

describe('normalizeAnthropicBaseUrl', () => {
  test.each([
    ['https://gateway.example', 'https://gateway.example'],
    ['https://gateway.example/', 'https://gateway.example/'],
    ['https://gateway.example/v1', 'https://gateway.example'],
    ['https://gateway.example/v1///', 'https://gateway.example'],
    ['http://127.0.0.1:1234/anthropic/v1/', 'http://127.0.0.1:1234/anthropic'],
    ['https://gateway.example/a%2Fb/v1', 'https://gateway.example/a%2Fb'],
    ['https://gateway.example/v1/tenant', 'https://gateway.example/v1/tenant'],
    ['https://gateway.example/v10', 'https://gateway.example/v10'],
    ['https://gateway.example/v1/messages', 'https://gateway.example/v1/messages'],
    ['https://gateway.example/?route=/v1', 'https://gateway.example/?route=/v1'],
    ['https://gateway.example/v1?route=one', 'https://gateway.example/v1?route=one'],
    ['https://gateway.example/#/v1', 'https://gateway.example/#/v1'],
    ['invalid/v1', 'invalid/v1'],
    ['file:///v1', 'file:///v1'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAnthropicBaseUrl(input)).toBe(expected)
  })
})
