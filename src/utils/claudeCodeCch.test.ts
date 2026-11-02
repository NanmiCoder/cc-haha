import { describe, expect, test } from 'bun:test'
import { signClaudeCodeCCHBody, signClaudeCodeCCHInString, xxHash64Seeded } from './claudeCodeCch.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function billingBody(content: string): string {
  return JSON.stringify({
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.220.693; cc_entrypoint=cli; cch=00000;' }],
    messages: [{ role: 'user', content }],
  })
}

describe('xxHash64Seeded', () => {
  test('matches xxHash64 reference values for seed 0', () => {
    expect(xxHash64Seeded(encoder.encode(''), 0n).toString(16)).toBe('ef46db3751d8e999')
    expect(xxHash64Seeded(encoder.encode('a'), 0n).toString(16)).toBe('d24ec4f1a98c6e5b')
    expect(xxHash64Seeded(encoder.encode('hello world'), 0n).toString(16)).toBe('45ab6734b21e6968')
  })

  test('Bun.hash.xxHash64 matches the JS implementation with the CCH seed', () => {
    const seed = 0x6E52736AC806831En
    const samples = ['', 'a', 'abc', 'hello world', '中文请求体', 'x'.repeat(31), 'y'.repeat(32), 'z'.repeat(100003)]
    for (const s of samples) {
      const bytes = encoder.encode(s)
      expect(BigInt(Bun.hash.xxHash64(bytes, seed))).toBe(xxHash64Seeded(bytes, seed))
    }
  })
})

describe('signClaudeCodeCCHInString', () => {
  test('replaces Anthropic system billing placeholder with deterministic 5 hex signature', () => {
    const body = '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.693; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"hello from proxy"}]}'
    const signed = signClaudeCodeCCHInString(body)

    expect(signed).toBe(body.replace('cch=00000;', 'cch=22198;'))
  })

  // Golden values come from the original pure-JS xxHash64 signer; the native
  // hash must keep every request signature byte-identical.
  test('keeps signatures identical to the original signer for multibyte, large, zero-padded and byte bodies', () => {
    const cjk = billingBody('你好，帮我看看这个文件')
    const large = billingBody('0123456789abcdef'.repeat(8192))
    const padded = billingBody('hello 4')

    expect(signClaudeCodeCCHInString(cjk)).toBe(cjk.replace('cch=00000;', 'cch=4388b;'))
    expect(signClaudeCodeCCHInString(large)).toBe(large.replace('cch=00000;', 'cch=a99ce;'))
    expect(signClaudeCodeCCHInString(padded)).toBe(padded.replace('cch=00000;', 'cch=01496;'))
    const signedBytes = signClaudeCodeCCHBody(encoder.encode(cjk))
    expect(signedBytes).toBeInstanceOf(Uint8Array)
    expect(decoder.decode(signedBytes as Uint8Array)).toBe(cjk.replace('cch=00000;', 'cch=4388b;'))
  })

  test('does not touch cch placeholder outside structured billing block', () => {
    const body = '{"messages":[{"role":"user","content":"please keep x-anthropic-billing-header: cc_version=2.1.220.abc; cc_entrypoint=cli; cch=00000; literal"}]}'
    expect(signClaudeCodeCCHInString(body)).toBe(body)
  })

  test('does not leave partial signatures when multiple placeholders exist', () => {
    const body = '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.abc; cc_entrypoint=cli; cch=00000;"},{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.def; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"hi"}]}'
    expect(signClaudeCodeCCHInString(body)).toBe(body)
  })

  test('does not partially sign when user text also contains a placeholder', () => {
    const body = '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.abc; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"literal x-anthropic-billing-header: cc_version=2.1.220.user; cc_entrypoint=cli; cch=00000;"}]}'
    expect(signClaudeCodeCCHInString(body)).toBe(body)
  })
})
