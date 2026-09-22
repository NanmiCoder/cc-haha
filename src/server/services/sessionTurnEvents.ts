import { EventEmitter } from 'node:events'

export type SessionTurnEvent =
  | { type: 'user-input' | 'input-committed' | 'stopped'; sessionId: string }
  | { type: 'output'; sessionId: string; message: Record<string, any> }

// The transport owns turn admission. Collaboration observes it without making
// the WebSocket handler depend on its persistence or HTTP implementation.
const events = new EventEmitter()

export function emitSessionTurnEvent(event: SessionTurnEvent): void {
  events.emit('event', event)
}

export function observeSessionTurns(listener: (event: SessionTurnEvent) => void): () => void {
  events.on('event', listener)
  return () => { events.off('event', listener) }
}

export type SessionTurnAdmissionLease = { release(): Promise<void> }
type AdmissionGuard = (sessionId: string, canAdmit: () => boolean) => Promise<SessionTurnAdmissionLease>
let admissionGuard: AdmissionGuard | undefined

export function registerSessionTurnAdmissionGuard(guard: AdmissionGuard): () => void {
  admissionGuard = guard
  return () => { if (admissionGuard === guard) admissionGuard = undefined }
}

export async function admitSessionUserTurn(sessionId: string, canAdmit: () => boolean): Promise<SessionTurnAdmissionLease> {
  if (admissionGuard) return admissionGuard(sessionId, canAdmit)
  return { release: async () => {} }
}
