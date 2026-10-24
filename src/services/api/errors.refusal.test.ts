import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const originalEnvironment = { ...process.env }
let sandbox: string
let getErrorMessageIfRefusal: typeof import('./errors.js').getErrorMessageIfRefusal
let setIsInteractive: typeof import('../../bootstrap/state.js').setIsInteractive
let originalInteractive: boolean

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'refusal-error-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {}, originalEnvironment))
  ;({ getErrorMessageIfRefusal } = await import('./errors.js'))
  const state = await import('../../bootstrap/state.js')
  setIsInteractive = state.setIsInteractive
  originalInteractive = state.getIsInteractive()
})

beforeEach(() => {
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_AZURE_OPENAI',
  ]) delete process.env[key]
  setIsInteractive(false)
})

afterAll(() => {
  if (setIsInteractive) setIsInteractive(originalInteractive)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  rmSync(sandbox, { recursive: true, force: true })
})

function refusalText(model: string) {
  const message = getErrorMessageIfRefusal('refusal', model)!
  expect(message.isApiErrorMessage).toBe(true)
  expect(message.error).toBe('invalid_request')
  return message.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('provider refusal attribution', () => {
  for (const interactive of [false, true]) {
    test(`attributes DeepSeek OAuth refusal to the selected model (interactive=${interactive})`, () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
      setIsInteractive(interactive)

      const text = refusalText('deepseek-flash')

      expect(text).toContain('deepseek-flash')
      expect(text).toContain('refused this request')
      expect(text).toContain('configured provider')
      expect(text).not.toContain('anthropic.com')
      expect(text).not.toContain('Usage Policy')
      expect(text).not.toContain('claude-sonnet')
    })
  }

  test('does not infer Anthropic policy from a Claude model name behind a custom endpoint', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456/proxy/fixture-provider'

    const text = refusalText('claude-sonnet-4-6')

    expect(text).toContain('claude-sonnet-4-6')
    expect(text).toContain('refused this request')
    expect(text).not.toContain('anthropic.com')
    expect(text).not.toContain('/model claude-sonnet-4-20250514')
  })

  for (const providerFlag of [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_AZURE_OPENAI',
  ]) {
    test(`keeps refusal guidance within the configured deployment (${providerFlag})`, () => {
      process.env[providerFlag] = '1'

      const text = refusalText('deployment-model')

      expect(text).toContain('deployment-model')
      expect(text).toContain('refused this request')
      expect(text).not.toContain('anthropic.com')
      expect(text).not.toContain('/model claude-sonnet-4-20250514')
    })
  }

  for (const baseUrl of [undefined, 'https://api.anthropic.com']) {
    test(`preserves official Anthropic refusal guidance (${baseUrl ?? 'default endpoint'})`, () => {
      if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl

      const text = refusalText('claude-sonnet-4-6')

      expect(text).toContain('https://www.anthropic.com/legal/aup')
      expect(text).toContain('Try rephrasing the request')
    })
  }

  test('leaves successful and incomplete responses alone', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    expect(getErrorMessageIfRefusal('end_turn', 'deepseek-flash')).toBeUndefined()
    expect(getErrorMessageIfRefusal(null, 'deepseek-flash')).toBeUndefined()
  })
})
