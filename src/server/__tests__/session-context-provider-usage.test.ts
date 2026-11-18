import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { SessionService } from '../services/sessionService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { roughTokenCountEstimationForMessage } from '../../services/tokenEstimation.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import type { Message } from '../../types/message.js'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const sessionId = 'a1111111-b222-c333-d444-e55555555555'
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
let configDir: string
let filePath: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'context-provider-usage-'))
  const fixtureEnv = createSandboxedTestEnvironment(configDir, {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'sk-ant-test-fake',
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, fixtureEnv)
  globalThis.fetch = (() => {
    throw new Error('Network access is blocked in the transcript context fixture')
  }) as typeof fetch
  const workDir = join(configDir, 'project')
  filePath = join(configDir, 'projects', sanitizePath(workDir), `${sessionId}.jsonl`)
  await mkdir(dirname(filePath), { recursive: true })
  const entries = [
    { type: 'session-meta', workDir },
    {
      type: 'assistant',
      uuid: 'qwen-history',
      message: {
        id: 'qwen-response', role: 'assistant', model: 'qwen4.0-max-preview',
        content: [{ type: 'text', text: 'old history '.repeat(360_000) }],
        usage: { input_tokens: 900_000, output_tokens: 1_000 },
      },
    },
    {
      type: 'assistant',
      uuid: 'deepseek-response',
      message: {
        id: 'deepseek-response', role: 'assistant', model: 'deepseek-flash',
        content: [{ type: 'text', text: 'Continued with DeepSeek' }],
        usage: {
          input_tokens: 235, output_tokens: 937,
          cache_read_input_tokens: 815_232, cache_creation_input_tokens: 0,
        },
      },
    },
  ]
  await writeFile(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(configDir, { recursive: true, force: true })
})

describe('transcript context after switching providers', () => {
  it('uses the latest prompt including cached input, then estimates only subsequent messages', async () => {
    const service = new SessionService()
    const initial = await service.getTranscriptContextEstimate(sessionId)
    expect(initial?.totalTokens).toBe(816_404)
    expect(initial?.model).toBe('deepseek-flash')
    expect(initial?.rawMaxTokens).toBe(1_000_000)
    expect(initial?.percentage).toBe(82)

    const tail = {
      type: 'user', uuid: 'new-tool-result',
      message: { role: 'user', content: [{ type: 'text', text: 'new tool result '.repeat(200) }] },
    }
    await appendFile(filePath, JSON.stringify(tail) + '\n')
    const updated = await service.getTranscriptContextEstimate(sessionId)
    expect(updated?.totalTokens).toBe(816_404 + roughTokenCountEstimationForMessage(tail))
    expect(updated?.categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(updated?.rawMaxTokens)
  })

  it('returns the same count through the inactive session inspection API', async () => {
    const url = new URL(`http://127.0.0.1/api/sessions/${sessionId}/inspection?contextOnly=true&includeContext=true`)
    const response = await handleSessionsApi(new Request(url), url, url.pathname.split('/').filter(Boolean))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.active).toBe(false)
    expect(body.contextEstimate?.totalTokens).toBe(816_404)
    expect(body.contextEstimate?.model).toBe('deepseek-flash')
    expect(body.contextEstimate?.percentage).toBe(82)
  })

  it.each([0, 500])('retains the previous prompt anchor when the next response reports only %s output tokens', async outputTokens => {
    const previous = {
      type: 'assistant',
      message: {
        id: 'previous-response', role: 'assistant', model: 'deepseek-flash',
        content: [{ type: 'text', text: 'previous' }],
        usage: { input_tokens: 80_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
    const incomplete = {
      type: 'assistant',
      message: {
        id: 'incomplete-response', role: 'assistant', model: 'deepseek-flash',
        content: [{ type: 'text', text: 'x'.repeat(4_000) }],
        usage: { input_tokens: 0, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
    const messages = [previous, incomplete] as Message[]
    await writeFile(filePath, messages.map(message => JSON.stringify(message)).join('\n') + '\n')

    expect((await new SessionService().getTranscriptContextEstimate(sessionId))?.totalTokens)
      .toBe(tokenCountWithEstimation(messages))
  })

  it.each([0, 500])('estimates the whole context when no response has prompt usage and output usage is %s', async outputTokens => {
    const messages = [
      { type: 'user', message: { role: 'user', content: '中'.repeat(100_000) } },
      {
        type: 'assistant',
        message: {
          id: 'incomplete-response', role: 'assistant', model: 'deepseek-flash',
          content: [{ type: 'text', text: 'x'.repeat(4_000) }],
          usage: { input_tokens: 0, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ] as Message[]
    await writeFile(filePath, messages.map(message => JSON.stringify(message)).join('\n') + '\n')

    expect((await new SessionService().getTranscriptContextEstimate(sessionId))?.totalTokens)
      .toBe(tokenCountWithEstimation(messages))
  })

  it.each([0, 100])('counts all interleaved results and split content when output usage is %s', async outputTokens => {
    const usage = { input_tokens: 80_000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const assistant = (toolId: string, reportedUsage = usage) => ({
      type: 'assistant',
      message: {
        id: 'split-response', role: 'assistant', model: 'deepseek-flash',
        content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: toolId } }],
        usage: reportedUsage,
      },
    })
    const result = (toolId: string) => ({
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'r'.repeat(1_000) }] },
    })
    const messages = [
      assistant('tool-a', { ...usage, input_tokens: 0, output_tokens: 0 }),
      result('tool-a'),
      assistant('tool-b'),
      result('tool-b'),
      assistant('tool-c'),
      result('tool-c'),
    ] as Message[]
    await writeFile(filePath, messages.map(message => JSON.stringify(message)).join('\n') + '\n')

    expect((await new SessionService().getTranscriptContextEstimate(sessionId))?.totalTokens)
      .toBe(tokenCountWithEstimation(messages))
  })
})
