import { describe, expect, it, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as baileys from '@whiskeysockets/baileys'
import { AdapterMigrationLifecycle, adapterMigrationLifecycle } from '../../common/migration-lifecycle.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearWhatsAppAuth,
  closeWhatsAppSocket,
  createWhatsAppSocket,
  getWhatsAppDisconnectStatus,
  hasWhatsAppAuth,
  isWhatsAppLoggedOut,
  waitForWhatsAppCredsSave,
} from '../session.js'
import type { WhatsAppSocket } from '../session.js'

function makeTempAuthDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-test-'))
}

describe('whatsapp session helpers', () => {
  it('detects and clears persisted auth credentials', () => {
    const authDir = makeTempAuthDir()

    expect(hasWhatsAppAuth(authDir)).toBe(false)

    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}')
    expect(hasWhatsAppAuth(authDir)).toBe(true)

    clearWhatsAppAuth(authDir)
    expect(fs.existsSync(authDir)).toBe(false)
  })

  it('extracts disconnect status from Baileys and direct error shapes', () => {
    expect(getWhatsAppDisconnectStatus({ output: { statusCode: 401 } })).toBe(401)
    expect(getWhatsAppDisconnectStatus({ statusCode: 515 })).toBe(515)
    expect(getWhatsAppDisconnectStatus({ output: { statusCode: '401' } })).toBeUndefined()
    expect(getWhatsAppDisconnectStatus(null)).toBeUndefined()
    expect(isWhatsAppLoggedOut({ output: { statusCode: 401 } })).toBe(true)
    expect(isWhatsAppLoggedOut({ output: { statusCode: 515 } })).toBe(false)
  })

  it('closes sockets best-effort with a reason', () => {
    let received: Error | undefined
    const sock = {
      end: (error?: Error) => {
        received = error
      },
    } as unknown as WhatsAppSocket

    closeWhatsAppSocket(sock, 'test close')
    expect(received?.message).toBe('test close')

    expect(() => closeWhatsAppSocket({} as WhatsAppSocket)).not.toThrow()
    expect(() => closeWhatsAppSocket({
      end: () => {
        throw new Error('already closed')
      },
    } as unknown as WhatsAppSocket)).not.toThrow()
  })

  it('returns immediately when no credential save is queued', async () => {
    const authDir = makeTempAuthDir()
    try { await expect(waitForWhatsAppCredsSave(authDir)).resolves.toBeUndefined() } finally { fs.rmSync(authDir, { recursive: true, force: true }) }
  })

  it('drains queued credentials and signal-key writes from the actual socket binding before migration', async () => {
    const authDir = makeTempAuthDir()
    const lifecycle = new AdapterMigrationLifecycle()
    const events = new EventEmitter()
    let releaseCreds!: () => void
    let releaseKeys!: () => void
    const pendingCreds = new Promise<void>(resolve => { releaseCreds = resolve })
    const pendingKeys = new Promise<void>(resolve => { releaseKeys = resolve })
    let saves = 0
    let authKeys: any
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{"old":true}')
    const auth = spyOn(baileys, 'useMultiFileAuthState').mockResolvedValue({
      state: { creds: {} as any, keys: { get: async () => ({}), set: async () => { await pendingKeys } } },
      saveCreds: async () => {
        if (++saves === 1) await pendingCreds
        fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify({ saves }))
      },
    })
    const version = spyOn(baileys, 'fetchLatestBaileysVersion').mockResolvedValue({ version: [2, 3, 4], isLatest: true })
    const socket = spyOn(baileys, 'makeWASocket').mockImplementation((options: any) => {
      authKeys = options.auth.keys
      return { ev: events, ws: new EventEmitter() } as any
    })
    const track = spyOn(adapterMigrationLifecycle, 'track').mockImplementation(operation => lifecycle.track(operation))
    try {
      await createWhatsAppSocket({ authDir })
      events.emit('creds.update', {})
      events.emit('creds.update', {})
      const keys = authKeys.set({ 'pre-key': { 'fixture-key': { data: 'fixture' } } })
      lifecycle.registerShutdown(() => waitForWhatsAppCredsSave(authDir))
      let drained = false
      const stopping = lifecycle.quiesce().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      releaseCreds()
      await waitForWhatsAppCredsSave(authDir)
      expect(saves).toBe(2)
      expect(drained).toBe(false)
      releaseKeys()
      await Promise.all([keys, stopping])
      expect(JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8'))).toEqual({ saves: 2 })
      expect(fs.existsSync(path.join(authDir, 'creds.json.bak'))).toBe(true)
    } finally {
      releaseCreds()
      releaseKeys()
      for (const spy of [track, socket, version, auth]) spy.mockRestore()
      await waitForWhatsAppCredsSave(authDir)
      fs.rmSync(authDir, { recursive: true, force: true })
    }
  })

  it('keeps the migration barrier pending for a credential save that has not started yet', async () => {
    const authDir = makeTempAuthDir()
    const lifecycle = new AdapterMigrationLifecycle()
    const events = new EventEmitter()
    let first!: () => void
    let second!: () => void
    const pending = [new Promise<void>(resolve => { first = resolve }), new Promise<void>(resolve => { second = resolve })]
    let saves = 0
    const auth = spyOn(baileys, 'useMultiFileAuthState').mockResolvedValue({
      state: { creds: {} as any, keys: { get: async () => ({}), set: async () => {} } },
      saveCreds: async () => {
        await pending[saves++]
        fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify({ saves }))
      },
    })
    const version = spyOn(baileys, 'fetchLatestBaileysVersion').mockResolvedValue({ version: [2, 3, 4], isLatest: true })
    const socket = spyOn(baileys, 'makeWASocket').mockReturnValue({ ev: events, ws: new EventEmitter() } as any)
    const track = spyOn(adapterMigrationLifecycle, 'track').mockImplementation(operation => lifecycle.track(operation))
    let stopping: Promise<void> | undefined
    try {
      await createWhatsAppSocket({ authDir })
      events.emit('creds.update', {})
      events.emit('creds.update', {})
      await Promise.resolve()
      expect(saves).toBe(1)
      let drained = false
      stopping = lifecycle.quiesce().then(() => { drained = true })
      first()
      for (let tick = 0; tick < 15; tick++) await Promise.resolve()
      expect(saves).toBe(2)
      expect(drained).toBe(false)
      second()
      await stopping
      expect(drained).toBe(true)
    } finally {
      first()
      second()
      await stopping
      await waitForWhatsAppCredsSave(authDir)
      for (const spy of [track, socket, version, auth]) spy.mockRestore()
      fs.rmSync(authDir, { recursive: true, force: true })
    }
  })
})
