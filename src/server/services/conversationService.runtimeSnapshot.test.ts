import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { ConversationService } from './conversationService.js'

afterEach(() => mock.restore())

function fixture() {
  const service = new ConversationService()
  const session = { providerId: 'first', runtimeSelection: { providerId: 'first', modelId: 'old', effortLevel: 'high' }, initMessage: { model: 'old' } }
  const sessions = (service as unknown as { sessions: Map<string, typeof session> }).sessions
  sessions.set('worker', session)
  return { service, session, sessions }
}

test('runtime snapshot changes only after the model control is acknowledged', async () => {
  const { service } = fixture()
  let acknowledge!: () => void
  spyOn(service, 'requestControl').mockImplementation(() => new Promise(resolve => { acknowledge = () => resolve({}) }))
  const changing = service.setModel('worker', 'new')
  expect(service.getSessionRuntimeSelection('worker')?.modelId).toBe('old')
  acknowledge()
  expect(await changing).toBe(true)
  expect(service.getSessionRuntimeSelection('worker')).toEqual({ providerId: 'first', modelId: 'new', effortLevel: 'high' })
})

test('a failed model control and a late acknowledgement from a replaced process do not change its runtime', async () => {
  const { service, sessions } = fixture()
  spyOn(service, 'requestControl').mockRejectedValueOnce(new Error('rejected'))
  await expect(service.setModel('worker', 'new')).rejects.toThrow('rejected')
  expect(service.getSessionRuntimeSelection('worker')?.modelId).toBe('old')
  spyOn(service, 'requestControl').mockImplementation(async () => { sessions.set('worker', { providerId: 'other', runtimeSelection: { providerId: 'other', modelId: 'replacement', effortLevel: 'low' }, initMessage: { model: 'replacement' } }); return {} })
  expect(await service.setModel('worker', 'new')).toBe(false)
  expect(service.getSessionRuntimeSelection('worker')?.modelId).toBe('replacement')
})

test('strict shutdown rejects an unconfirmed kill and retains the process for retry', async () => {
  const { service, session, sessions } = fixture()
  Object.assign(session, { proc: { exited: new Promise(() => {}), exitCode: null } })
  const internals = service as unknown as { killProcess: (...args: unknown[]) => void; waitForProcessOutputDrain: (...args: unknown[]) => Promise<void>; cancelPendingControlRequests: (...args: unknown[]) => void; clearSessionAutoAnswerWaits: (...args: unknown[]) => void }
  spyOn(internals, 'killProcess').mockImplementation(() => {})
  spyOn(internals, 'waitForProcessOutputDrain').mockResolvedValue(undefined)
  spyOn(internals, 'cancelPendingControlRequests').mockImplementation(() => {})
  spyOn(internals, 'clearSessionAutoAnswerWaits').mockImplementation(() => {})
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { queueMicrotask(callback); return 1 }) as typeof setTimeout)
  await expect(service.stopSessionAndWait('worker', 1, { requireExit: true })).rejects.toThrow('did not confirm exit')
  expect(sessions.get('worker')).toBe(session)
  expect(internals.waitForProcessOutputDrain).not.toHaveBeenCalled()
})
