import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { getSdkBetas, setSdkBetas } from '../bootstrap/state.js'
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { clearBetasCaches, getBedrockExtraBodyParamsBetas, getMergedBetas } from './betas.js'
import { enableConfigs } from './config.js'

let savedEnv: NodeJS.ProcessEnv
let savedSdkBetas: string[] | undefined
let sandbox: string

beforeEach(() => {
  savedEnv = { ...process.env }
  savedSdkBetas = getSdkBetas()
  sandbox = mkdtempSync(join(tmpdir(), 'cc-haha-betas-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    ANTHROPIC_API_KEY: 'beta-fixture-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }, savedEnv))
  enableConfigs()
  setSdkBetas(undefined)
  clearBetasCaches()
})

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  setSdkBetas(savedSdkBetas)
  clearBetasCaches()
  rmSync(sandbox, { recursive: true, force: true })
})

test('third-party context markers retain only the selected beta', () => {
  for (const model of ['claude-opus-5[1m]', 'claude-opus-5[1M]', 'claude-opus-5:1m']) {
    expect(getMergedBetas(model, { isAgenticQuery: true })).toEqual([CONTEXT_1M_BETA_HEADER])
  }
})

test('third-party defaults stay empty even for a model configured with a large local window', () => {
  process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = '{"claude-opus-5":1000000}'
  expect(getMergedBetas('claude-opus-5', { isAgenticQuery: true })).toEqual([])
  expect(getMergedBetas('vendor-model')).toEqual([])
})

test('explicit environment and SDK opt-ins are trimmed and deduplicated', () => {
  process.env.ANTHROPIC_BETAS = ` , custom-beta, ${CONTEXT_1M_BETA_HEADER},custom-beta, `
  setSdkBetas([CONTEXT_1M_BETA_HEADER])
  expect(getMergedBetas('claude-opus-5[1m]')).toEqual([CONTEXT_1M_BETA_HEADER, 'custom-beta'])
  expect(getMergedBetas('vendor-model')).toEqual(['custom-beta', CONTEXT_1M_BETA_HEADER])
})

test('SDK opt-ins work independently of the model suffix and environment', () => {
  setSdkBetas([CONTEXT_1M_BETA_HEADER])
  expect(getMergedBetas('claude-opus-5')).toEqual([CONTEXT_1M_BETA_HEADER])
})

test('disabling 1M context suppresses automatic context markers', () => {
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
  expect(getMergedBetas('claude-opus-5[1m]')).toEqual([])
  expect(getMergedBetas('claude-opus-5:1m')).toEqual([])
})

test('explicit beta opt-ins remain available when experimental defaults are disabled', () => {
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
  expect(getMergedBetas('claude-opus-5[1m]')).toEqual([])
  expect(getMergedBetas('claude-opus-5')).toEqual([])
  process.env.ANTHROPIC_BETAS = CONTEXT_1M_BETA_HEADER
  expect(getMergedBetas('claude-opus-5[1m]')).toEqual([CONTEXT_1M_BETA_HEADER])
})

test('official and cloud providers retain their existing model beta assembly', () => {
  for (const provider of ['official', 'bedrock', 'vertex', 'foundry']) {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    if (provider !== 'official') process.env[`CLAUDE_CODE_USE_${provider.toUpperCase()}`] = '1'
    process.env.ANTHROPIC_BETAS = ' custom-beta, , '
    clearBetasCaches()
    const betas = getMergedBetas('claude-sonnet-4-6[1m]', { isAgenticQuery: true })
    if (provider === 'bedrock') {
      expect(getBedrockExtraBodyParamsBetas('claude-sonnet-4-6[1m]')).toContain(CONTEXT_1M_BETA_HEADER)
      expect(betas).not.toContain(CONTEXT_1M_BETA_HEADER)
    } else {
      expect(betas).toContain(CONTEXT_1M_BETA_HEADER)
    }
    expect(betas).toContain('custom-beta')
    expect(betas).toContain('claude-code-20250219')
  }
})
