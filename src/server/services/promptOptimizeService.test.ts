import { expect, test } from 'bun:test'
import { SDKControlRequestInnerSchema } from '../../entrypoints/sdk/controlSchemas.js'
import {
  PromptOptimizeService,
  promptOptimizeInputSchema,
} from './promptOptimizeService.js'

const url = new URL('http://127.0.0.1/api/sessions/s/optimize-prompt')
const body = {
  requestId: '11111111-1111-4111-8111-111111111111',
  prompt: 'fix the login bug',
}

test('optimizes prompt through control channel and rejects duplicate request IDs', async () => {
  const calls: unknown[][] = []
  const service = new PromptOptimizeService({
    ensure: async () => {},
    control: async (...args) => {
      calls.push(args)
      return { optimizedPrompt: 'Fix the authentication login bug and add regression tests.' }
    },
  })
  const result = await service.optimize('s', body, url, new AbortController().signal)
  expect(result).toEqual({
    requestId: body.requestId,
    optimizedPrompt: 'Fix the authentication login bug and add regression tests.',
  })
  expect(calls[0]?.slice(0, 3)).toEqual([
    's',
    {
      subtype: 'optimize_prompt',
      request_id: body.requestId,
      prompt: 'fix the login bug',
    },
    120_000,
  ])
  expect(service.hasPendingWork()).toBe(false)
  await expect(
    service.optimize('s', body, url, new AbortController().signal),
  ).rejects.toMatchObject({ statusCode: 409 })
})

test('cancel sends CLI cancel control and aborts in-flight optimization', async () => {
  const calls: Record<string, unknown>[] = []
  let release!: () => void
  const service = new PromptOptimizeService({
    ensure: async () => {},
    control: async (_id, request, _timeout, signal) => {
      calls.push(request)
      if (request.subtype === 'cancel_optimize_prompt') return { cancelled: true }
      await new Promise<void>(resolve => {
        release = resolve
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { optimizedPrompt: 'late' }
    },
  })
  const pending = service.optimize('s', body, url, new AbortController().signal)
  await Bun.sleep(10)
  expect(service.hasPendingWork()).toBe(true)
  await expect(
    service.optimize(
      's',
      { requestId: '22222222-2222-4222-8222-222222222222', prompt: 'second' },
      url,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ statusCode: 409 })
  expect(await service.cancel('s', body.requestId)).toBe(true)
  release()
  await expect(pending).rejects.toMatchObject({ statusCode: 499 })
  expect(calls.map(call => call.subtype)).toEqual([
    'optimize_prompt',
    'cancel_optimize_prompt',
  ])
  expect(service.hasPendingWork()).toBe(false)
})

test('cancel before POST tombstones the request ID so a racing POST cannot start', async () => {
  const calls: string[] = []
  const service = new PromptOptimizeService({
    ensure: async () => { calls.push('ensure') },
    control: async () => { calls.push('control'); return { optimizedPrompt: 'nope' } },
  })
  expect(await service.cancel('s', body.requestId)).toBe(false)
  await expect(
    service.optimize('s', body, url, new AbortController().signal),
  ).rejects.toMatchObject({ statusCode: 409 })
  expect(calls).toEqual([])
})

test('validates HTTP input and SDK control schemas', () => {
  expect(promptOptimizeInputSchema.parse({ ...body, prompt: '  hello  ' }).prompt).toBe('hello')
  for (const invalid of [
    {},
    { ...body, requestId: 'not-a-uuid' },
    { ...body, prompt: '   ' },
    { ...body, extra: true },
  ]) {
    expect(promptOptimizeInputSchema.safeParse(invalid).success).toBe(false)
  }
  for (const request of [
    { subtype: 'optimize_prompt', request_id: body.requestId, prompt: body.prompt },
    { subtype: 'cancel_optimize_prompt', request_id: body.requestId },
  ]) {
    expect(SDKControlRequestInnerSchema().safeParse(request).success).toBe(true)
  }
})

test('both protocol boundaries validate the visible draft and preserve reference offsets', () => {
  const text = '@Report'.padEnd(32_000, 'x')
  for (const [candidate, valid] of [
    [{ text, referenceEnds: [7] }, true],
    [{ text: text + 'x', referenceEnds: [7] }, false],
    [{ text, referenceEnds: [text.length + 1] }, false],
    [{ text, referenceEnds: [7, 7] }, false],
    [{ text, referenceEnds: [7, 8] }, false],
  ] as const) {
    const http = promptOptimizeInputSchema.safeParse({ ...body, prompt: candidate })
    const sdk = SDKControlRequestInnerSchema().safeParse({ subtype: 'optimize_prompt', prompt: candidate })
    expect(http.success).toBe(valid)
    expect(sdk.success).toBe(valid)
    if (http.success) expect(http.data.prompt).toEqual(candidate)
  }
})
