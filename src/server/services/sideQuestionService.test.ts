import { expect, test } from 'bun:test'
import { ApiError } from '../middleware/errorHandler.js'
import { SideQuestionService, sideQuestionInputSchema } from './sideQuestionService.js'
import { SDKControlRequestSchema } from '../../entrypoints/sdk/controlSchemas.js'
const url = new URL('http://127.0.0.1/api/sessions/s/side-question')
const input = () => ({ questionId: crypto.randomUUID(), question: 'why?', history: [] })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('side questions use isolated controls, long timeout, and reject concurrent/duplicate work', async () => {
  const calls: unknown[][] = []
  let resolve!: (value: Record<string, unknown>) => void
  const service = new SideQuestionService({ ensure: async () => {}, control: async (...args) => {
    calls.push(args)
    return await new Promise(r => { resolve = r })
  } })
  const body = input()
  const pending = service.ask('s', body, url, new AbortController().signal)
  await tick()
  await expect(service.ask('s', input(), url, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 })
  expect(calls[0]?.slice(0, 3)).toEqual(['s', { subtype: 'side_question', question_id: body.questionId, question: 'why?', history: [] }, 300_000])
  resolve({ response: 'because' })
  expect(await pending).toEqual({ questionId: body.questionId, response: 'because' })
  await expect(service.ask('s', body, url, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 })
  expect(calls).toHaveLength(1)
})

test('cancel and disconnect target only the matching side question; late results are ignored', async () => {
  for (const disconnect of [false, true]) {
    const calls: Array<Record<string, unknown>> = []
    let late!: (value: Record<string, unknown>) => void
    const service = new SideQuestionService({ ensure: async () => {}, control: async (_id, request) => {
      calls.push(request)
      if (request.subtype === 'cancel_side_question') return { cancelled: true }
      return await new Promise(resolve => { late = resolve })
    } })
    const controller = new AbortController()
    const body = input()
    const pending = service.ask('s', body, url, controller.signal)
    const rejected = pending.catch(error => error)
    await tick()
    expect(await service.cancel('other', body.questionId)).toBe(false)
    expect(await service.cancel('s', crypto.randomUUID())).toBe(false)
    if (disconnect) controller.abort()
    else expect(await service.cancel('s', body.questionId)).toBe(true)
    expect(await rejected).toMatchObject({ statusCode: 499 })
    late({ response: 'must not appear' })
    expect(calls.map(call => call.subtype)).toEqual(['side_question', 'cancel_side_question'])
    expect(calls[1]?.question_id).toBe(body.questionId)
  }
})

test('startup cancellation sends no question, while independent sessions can progress', async () => {
  let ready!: () => void
  const calls: string[] = []
  const service = new SideQuestionService({
    ensure: async id => { if (id === 'slow') await new Promise<void>(resolve => { ready = resolve }) },
    control: async id => { calls.push(id); return { response: 'ok' } },
  })
  const controller = new AbortController()
  const pending = service.ask('slow', input(), url, controller.signal)
  const rejected = pending.catch(error => error)
  controller.abort()
  expect(await rejected).toMatchObject({ statusCode: 499 })
  await expect(service.ask('other', input(), url, new AbortController().signal)).resolves.toMatchObject({ response: 'ok' })
  ready()
  await tick()
  expect(calls).toEqual(['other'])
})

test('timeout cancels isolated work; failures do not replay and release the session', async () => {
  const calls: string[] = []
  const service = new SideQuestionService({ ensure: async () => {}, control: async (_id, request) => {
    calls.push(String(request.subtype))
    if (request.subtype === 'cancel_side_question') return { cancelled: true }
    return await new Promise(() => {})
  } }, 5)
  await expect(service.ask('s', input(), url, new AbortController().signal)).rejects.toMatchObject({ statusCode: 504 })
  expect(calls).toEqual(['side_question', 'cancel_side_question'])
  let attempts = 0
  const failing = new SideQuestionService({ ensure: async () => {}, control: async () => { attempts++; throw new Error('upstream failure') } })
  for (let i = 0; i < 2; i++) await expect(failing.ask('s', input(), url, new AbortController().signal)).rejects.toMatchObject({ statusCode: 502 })
  expect(attempts).toBe(2)
})

test('HTTP and SDK schemas validate question/history and preserve cancel correlation', () => {
  const body = input()
  expect(sideQuestionInputSchema.parse({ ...body, question: ' why? ' }).question).toBe('why?')
  for (const invalid of [{ ...body, question: ' ' }, { ...body, questionId: 'bad' }, { ...body, history: Array(21).fill({ question: 'q', response: 'r' }) }, { ...body, question: 'a'.repeat(16001) }]) {
    expect(sideQuestionInputSchema.safeParse(invalid).success).toBe(false)
  }
  for (const request of [{ subtype: 'side_question', question_id: body.questionId, question: body.question, history: [] }, { subtype: 'cancel_side_question', question_id: body.questionId }]) {
    expect(SDKControlRequestSchema().parse({ type: 'control_request', request_id: 'request', request }).request).toEqual(request)
  }
})


test('recent replay protection is bounded without a lifetime usage limit, and startup status survives', async () => {
  const service = new SideQuestionService({ ensure: async () => {}, control: async () => ({ response: 'ok' }) })
  const first = input()
  await service.ask('s', first, url, new AbortController().signal)
  for (let index = 0; index < 1000; index++) await service.ask('s', input(), url, new AbortController().signal)
  await expect(service.ask('s', first, url, new AbortController().signal)).resolves.toMatchObject({ response: 'ok' })
  const missing = new SideQuestionService({ ensure: async () => { throw ApiError.notFound('Gone') }, control: async () => ({}) })
  await expect(missing.ask('s', input(), url, new AbortController().signal)).rejects.toMatchObject({ statusCode: 404, message: 'Gone' })
})


test('cancel arriving before POST prevents late work without cancelling another session', async () => {
  let calls = 0
  const service = new SideQuestionService({ ensure: async () => {}, control: async () => { calls++; return { response: 'ok' } } })
  const body = input()
  expect(await service.cancel('s', body.questionId)).toBe(false)
  await expect(service.ask('s', body, url, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 })
  expect(calls).toBe(0)
  await expect(service.ask('other', body, url, new AbortController().signal)).resolves.toMatchObject({ response: 'ok' })
  expect(calls).toBe(1)
})
