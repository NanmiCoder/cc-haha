import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { ComputerUseApprovalService } from './computerUseApprovalService.js'
import * as handler from '../ws/handler.js'
import { observeSessionTurns, type SessionTurnEvent } from './sessionTurnEvents.js'

const request = { requestId: 'fixture-request', reason: 'Desktop permission', apps: [], requestedFlags: {}, screenshotFiltering: 'none' as const }
afterEach(() => { mock.restore() })

test('headless running session retains approval for reconnect without auto-granting', async () => {
  spyOn(handler, 'sendToSession').mockReturnValue(false)
  spyOn(handler, 'getSessionTurnState').mockReturnValue('running')
  const service = new ComputerUseApprovalService()
  const events: SessionTurnEvent[] = []
  const dispose = observeSessionTurns(event => { events.push(event) })
  const response = { granted: [], denied: [], flags: { clipboard: false } } as any
  try {
    const approval = service.requestApproval('headless', request)
    expect(service.getPendingRequests('headless')).toEqual([request])
    expect(events[0]).toMatchObject({ type: 'output', sessionId: 'headless', message: { type: 'control_request', request_id: request.requestId } })
    expect(service.resolveApproval(request.requestId, response)).toBe(true)
    expect(await approval).toEqual(response)
    expect(service.getPendingRequests('headless')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'output', message: { type: 'control_response' } })
  } finally { dispose(); service.cancelSession('headless') }
})

test('a missing idle session still rejects disconnected approval', async () => {
  spyOn(handler, 'sendToSession').mockReturnValue(false)
  spyOn(handler, 'getSessionTurnState').mockReturnValue('idle')
  const service = new ComputerUseApprovalService()
  await expect(service.requestApproval('missing', request)).rejects.toThrow('Desktop session is not connected')
  expect(service.getPendingRequests('missing')).toEqual([])
})

test('headless approval timeout rejects and clears pending state without granting access', async () => {
  spyOn(handler, 'sendToSession').mockReturnValue(false)
  spyOn(handler, 'getSessionTurnState').mockReturnValue('running')
  const service = new ComputerUseApprovalService(5)
  const events: SessionTurnEvent[] = []
  const dispose = observeSessionTurns(event => { events.push(event) })
  try {
    await expect(service.requestApproval('headless', request)).rejects.toThrow('timed out')
    expect(service.getPendingRequests('headless')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'output', message: { type: 'control_response' } })
  } finally { dispose() }
})
