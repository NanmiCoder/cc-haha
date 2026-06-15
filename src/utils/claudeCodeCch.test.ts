import { describe, expect, test } from 'bun:test'
import { signClaudeCodeCCHInString, xxHash64Seeded } from './claudeCodeCch.js'

const encoder = new TextEncoder()

describe('xxHash64Seeded', () => {
  test('matches xxHash64 reference values for seed 0', () => {
    expect(xxHash64Seeded(encoder.encode(''), 0n).toString(16)).toBe('ef46db3751d8e999')
    expect(xxHash64Seeded(encoder.encode('a'), 0n).toString(16)).toBe('d24ec4f1a98c6e5b')
    expect(xxHash64Seeded(encoder.encode('hello world'), 0n).toString(16)).toBe('45ab6734b21e6968')
  })
})

describe('signClaudeCodeCCHInString', () => {
  test('replaces Anthropic system billing placeholder with deterministic 5 hex signature', () => {
    const body = '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.92.693; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"hello from proxy"}]}'
    const signed = signClaudeCodeCCHInString(body)

    expect(signed).toMatch(/cch=[0-9a-f]{5};/)
    expect(signed).not.toContain('cch=00000;')
  })

  test('does not touch cch placeholder outside structured billing block', () => {
    const body = '{"messages":[{"role":"user","content":"please keep x-anthropic-billing-header: cc_version=2.1.92.abc; cc_entrypoint=cli; cch=00000; literal"}]}'
    expect(signClaudeCodeCCHInString(body)).toBe(body)
  })

  test('does not leave partial signatures when multiple placeholders exist', () => {
    const body = '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.92.abc; cc_entrypoint=cli; cch=00000;"},{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.92.def; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"hi"}]}'
    expect(signClaudeCodeCCHInString(body)).toBe(body)
  })

  test('does not partially sign when user text also contains a placeholder', () => {
    const body = '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.92.abc; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"literal x-anthropic-billing-header: cc_version=2.1.92.user; cc_entrypoint=cli; cch=00000;"}]}'
    expect(signClaudeCodeCCHInString(body)).toBe(body)
  })
})
