import { expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import type { Options, Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk/core'
import { OfficialAgentSdkSideQuestions } from './officialAgentSdkSideQuestions.js'

const parent = { options: { env: { ANTHROPIC_API_KEY: 'fake-fixture-key' }, persistSession: true } as Options, sessionId: crypto.randomUUID(), model: 'claude-haiku-5-5', resumeAt: crypto.randomUUID(), context: [{ role: 'user', content: 'parent context' }] }

test('side questions fork a frozen native context without tools, persistence or parent controls', async () => {
  let params!: Parameters<typeof query>[0]
  const close = mock(() => {})
  const side = new OfficialAgentSdkSideQuestions(input => {
    params = input
    return Object.assign((async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Side answer.' }] } } as SDKMessage
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Side answer.' } as SDKMessage
    })(), { close }) as Query
  })
  const result = await side.ask({ question_id: crypto.randomUUID(), question: 'Explain this', history: [{ question: 'prior', response: 'answer' }] }, parent)
  expect(result.response).toBe('Side answer.')
  expect(params.options).toMatchObject({ resume: parent.sessionId, resumeSessionAt: parent.resumeAt, forkSession: true, persistSession: false, model: 'claude-haiku-5-5', tools: [], skills: [], strictMcpConfig: true, mcpServers: {}, maxTurns: 1 })
  expect(params.options!.sessionId).not.toBe(parent.sessionId)
  expect(params.prompt).toContain('prior')
  expect(existsSync(params.options!.settings as string)).toBe(false)
  expect(close).toHaveBeenCalledTimes(1)
})

test('cancelling a side question closes only its separate query, and no-history sessions use a frozen in-memory context', async () => {
  let params!: Parameters<typeof query>[0]
  let finish!: () => void
  const close = mock(() => finish())
  const side = new OfficialAgentSdkSideQuestions(input => {
    params = input
    return Object.assign((async function* () {
      await new Promise<void>(resolve => { finish = resolve })
    })(), { close }) as Query
  })
  const id = crypto.randomUUID()
  const pending = side.ask({ question_id: id, question: 'explain' }, { ...parent, options: { ...parent.options, persistSession: false } })
  expect(params.options!.resume).toBeUndefined()
  expect(params.prompt).toContain('parent context')
  await expect(side.ask({ question_id: id, question: 'duplicate' }, parent)).rejects.toThrow('already running')
  side.cancel(id)
  await expect(pending).rejects.toThrow('cancelled')
  expect(params.options!.abortController!.signal.aborted).toBe(true)
  expect(existsSync(params.options!.settings as string)).toBe(false)
  side.close()
})
