import { expect, test } from 'bun:test'
import { getConfiguredProviderOutputBudget, getOutputBudgetHeaders, markOutputBudgetSource } from './outputBudget.js'

test('only the local protocol proxy receives budget provenance headers', () => {
  const body = markOutputBudgetSource({ max_tokens: 32000 }, 'default')
  expect(getOutputBudgetHeaders(body, 'http://127.0.0.1:3131/proxy/providers/fixture')).toEqual({
    'x-cc-haha-output-budget-source': 'default',
  })
  expect(getOutputBudgetHeaders({ max_tokens: 256 }, 'http://localhost:3131/proxy/providers/fixture')).toEqual({
    'x-cc-haha-output-budget-source': 'explicit',
  })
  expect(getOutputBudgetHeaders(body, 'https://api.anthropic.com')).toEqual({})
  expect(getOutputBudgetHeaders(body, 'https://third-party.test/proxy/providers/fixture')).toEqual({})
  expect(getOutputBudgetHeaders(body, 'http://127.0.0.1:3131/other')).toEqual({})
  expect(JSON.stringify(body)).toBe('{"max_tokens":32000}')
})

test('explicit provenance is not guessed from the default numeric value', () => {
  const body = markOutputBudgetSource({ max_tokens: 32000 }, 'explicit')
  expect(getOutputBudgetHeaders(body, 'http://[::1]:3131/proxy/providers/test')).toEqual({
    'x-cc-haha-output-budget-source': 'explicit',
  })
})

test('provider budgets accept only positive safe integers and only affect proxy clients', () => {
  const base = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3131/proxy/providers/test' }
  expect(getConfiguredProviderOutputBudget({ ...base, CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '131072' })).toBe(131072)
  for (const value of ['0', '-1', 'NaN', '1.5', '123bad', '9007199254740992', '']) {
    expect(getConfiguredProviderOutputBudget({ ...base, CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: value })).toBeUndefined()
  }
  expect(getConfiguredProviderOutputBudget({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '131072' })).toBeUndefined()
})
