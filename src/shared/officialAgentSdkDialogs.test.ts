import { describe, expect, test } from 'bun:test'
import { parseElicitationFields, safeDialogUrl, validElicitationContent } from './officialAgentSdkDialogs.js'

describe('official MCP form contract', () => {
  test('validates typed values, optional omissions, bounds and both enum forms without coercing consent', () => {
    const fields = parseElicitationFields({ type: 'object', properties: {
      email: { type: 'string', format: 'email' }, count: { type: 'integer', minimum: 1, maximum: 4 },
      accepted: { type: 'boolean' }, role: { type: 'string', oneOf: [{ const: 'reader', title: 'Reader' }] },
      scopes: { type: 'array', items: { anyOf: [{ const: 'read', title: 'Read' }, { const: 'write', title: 'Write' }] }, minItems: 1 },
      extra: { type: 'string', minLength: 2 },
    }, required: ['email', 'count', 'accepted', 'role', 'scopes'] })!
    const content = { email: 'fixture@example.test', count: 2, accepted: false, role: 'reader', scopes: ['read'] }
    expect(validElicitationContent(fields, content)).toBe(true)
    for (const invalid of [{ count: 2.5 }, { count: 0 }, { accepted: 'false' }, { scopes: [] }, { scopes: ['read', 'read'] }, { scopes: ['admin'] }, { role: 'admin' }, { email: 'invalid' }, { extra: 'x' }, { unexpected: true }]) {
      expect(validElicitationContent(fields, { ...content, ...invalid })).toBe(false)
    }
    expect(fields.find(field => field.name === 'role')?.choices).toEqual([{ value: 'reader', label: 'Reader' }])
  })
  test('rejects unsupported nested or composed schemas instead of silently weakening validation', () => {
    for (const property of [{ type: 'object', properties: {} }, { type: 'array', items: { type: 'string' } }, { type: 'string', pattern: 'secret' }, { type: 'string', oneOf: [] }, { type: 'string', format: 'password' }]) {
      expect(parseElicitationFields({ type: 'object', properties: { test: property } })).toBeUndefined()
    }
    expect(parseElicitationFields({ type: 'object', properties: {}, required: ['missing'] })).toBeUndefined()
  })
  test('validates calendar dates and safe browser schemes without throwing or opening anything', () => {
    const fields = parseElicitationFields({ type: 'object', properties: { date: { type: 'string', format: 'date' } }, required: ['date'] })!
    expect(validElicitationContent(fields, { date: '2026-10-20' })).toBe(true)
    for (const date of ['2026-02-31', '2026-88-99', 'today']) expect(validElicitationContent(fields, { date })).toBe(false)
    expect(safeDialogUrl('https://example.test/auth?state=fixture')).toBe('https://example.test/auth?state=fixture')
    expect(safeDialogUrl('http://127.0.0.1:1234/auth')).toBe('http://127.0.0.1:1234/auth')
    for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://secret@example.test', 'not a url']) expect(safeDialogUrl(url)).toBeUndefined()
  })
})

test('MCP string lengths count Unicode characters and accept schema-permitted empty values', () => {
  const fields = parseElicitationFields({ type: 'object', properties: {
    character: { type: 'string', minLength: 1, maxLength: 1 }, empty: { type: 'string', maxLength: 0 },
  }, required: ['character', 'empty'] })!
  expect(validElicitationContent(fields, { character: '😀', empty: '' })).toBe(true)
  expect(validElicitationContent(fields, { character: '😀x', empty: '' })).toBe(false)
  expect(parseElicitationFields({ type: 'object', properties: {}, required: true })).toBeUndefined()
})
