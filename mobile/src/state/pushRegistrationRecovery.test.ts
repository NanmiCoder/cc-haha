import { expect, test } from 'bun:test'
import { PushRegistrationCoordinator, type PushRegistrationInput } from './pushRegistrations'
import { PushRegistrationRecovery, type PushInfo } from './pushRegistrationRecovery'
import type { ApiClient } from '../core/client'

test('backgrounding during an accepted PUT preserves the existing push registration', async () => {
  const values = new Map<string, string>()
  const coordinator = new PushRegistrationCoordinator({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value) },
    removeItem: async (key) => { values.delete(key) },
  })
  const input: PushRegistrationInput = {
    platform: 'android', token: 'fixture-device-token', hostId: 'fixture-host',
    preferences: { decisions: true, completed: true, errors: true },
    quietHours: { enabled: false, start: '23:00', end: '08:00' }, timeZone: 'UTC',
  }
  // Updating this token returns its existing registration ID. Compensation would
  // remove a previously working registration as well as the just-accepted update.
  const records = new Map([['existing-registration', input]])
  let releasePut!: () => void
  let enteredPut!: () => void
  const entered = new Promise<void>((resolve) => { enteredPut = resolve })
  const response = new Promise<void>((resolve) => { releasePut = resolve })
  const methods: string[] = []
  const client = {
    host: { id: 'fixture-host' },
    request: async (_path: string, options: { method: string }) => {
      methods.push(options.method)
      if (options.method === 'DELETE') {
        records.delete('existing-registration')
        return { removed: true }
      }
      records.set('existing-registration', input)
      enteredPut()
      await response
      return { registered: true, status: 'registered', id: 'existing-registration' }
    },
  } as unknown as ApiClient
  const history: PushInfo[] = []
  let signal!: AbortSignal
  const recovery = new PushRegistrationRecovery(async (requestSignal) => {
    signal = requestSignal
    await coordinator.register(client, input, requestSignal)
    return { info: { status: 'registered' } }
  }, (info) => history.push(info))
  try {
    recovery.setActive(true)
    await entered
    recovery.setActive(false)
    releasePut()
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(signal.aborted).toBe(false)
    expect(methods).toEqual(['PUT'])
    expect(records.has('existing-registration')).toBe(true)
    expect(history.map(info => info.status)).toEqual(['loading'])
  } finally {
    recovery.stop()
    releasePut()
  }
})
