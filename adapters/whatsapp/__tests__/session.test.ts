import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearWhatsAppAuth,
  closeWhatsAppSocket,
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
    await expect(waitForWhatsAppCredsSave(makeTempAuthDir())).resolves.toBeUndefined()
  })
})
