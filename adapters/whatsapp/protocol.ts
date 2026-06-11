import * as crypto from 'node:crypto'
import * as path from 'node:path'
import {
  clearWhatsAppAuth,
  closeWhatsAppSocket,
  createWhatsAppSocket,
  getWhatsAppDisconnectStatus,
  isWhatsAppLoggedOut,
  waitForWhatsAppCredsSave,
  type WhatsAppSocket,
} from './session.js'

export type WhatsAppLoginStartResult = {
  sessionKey: string
  qr?: string
  message: string
}

export type WhatsAppLoginPollResult =
  | {
      connected: true
      accountJid: string
      authDir: string
      message: string
    }
  | {
      connected: false
      status: 'waiting' | 'expired' | 'error'
      qr?: string
      message: string
    }

type CreateLoginSocket = typeof createWhatsAppSocket

type LoginSession = {
  authDir: string
  sock: WhatsAppSocket
  createSocket: CreateLoginSocket
  qr?: string
  connected: boolean
  accountJid?: string
  error?: string
  restarts: number
  createdAt: number
}

const LOGIN_TTL_MS = 2 * 60 * 1000
const WAIT_FOR_QR_MS = 20_000
// After a successful QR scan WhatsApp always closes the socket with
// DisconnectReason.restartRequired; login must reconnect to finish pairing.
const POST_PAIRING_RESTART_STATUS = 515
// QR rotation exhausts after ~1min and closes with DisconnectReason.timedOut;
// reconnecting serves a fresh QR instead of failing the login session.
const TIMED_OUT_STATUS = 408
const MAX_LOGIN_RESTARTS = 5
const sessions = new Map<string, LoginSession>()

export async function startWhatsAppLoginWithQr(options: {
  authDir: string
  force?: boolean
  createSocket?: CreateLoginSocket
}): Promise<WhatsAppLoginStartResult> {
  cleanupExpiredSessions()
  const authDir = path.resolve(options.authDir)
  if (options.force) {
    closeSessionsForAuthDir(authDir)
    clearWhatsAppAuth(authDir)
  }

  const sessionKey = crypto.randomUUID()
  const session: LoginSession = {
    authDir,
    sock: undefined as unknown as WhatsAppSocket,
    createSocket: options.createSocket ?? createWhatsAppSocket,
    connected: false,
    restarts: 0,
    createdAt: Date.now(),
  }
  sessions.set(sessionKey, session)
  const qrPromise = waitForQr(session)
  try {
    await connectLoginSocket(sessionKey, session)
  } catch (err) {
    sessions.delete(sessionKey)
    throw err
  }

  await qrPromise
  return {
    sessionKey,
    qr: session.qr,
    message: session.qr
      ? 'Scan this QR in WhatsApp > Linked devices.'
      : 'Waiting for WhatsApp QR code...',
  }
}

async function connectLoginSocket(sessionKey: string, session: LoginSession): Promise<void> {
  const sock = await session.createSocket({
    authDir: session.authDir,
    onQr: (qr) => {
      session.qr = qr
    },
  })
  session.sock = sock

  sock.ev.on('connection.update', async (update) => {
    if (sessions.get(sessionKey) !== session || session.sock !== sock) return
    if (update.qr) {
      session.qr = update.qr
    }
    if (update.connection === 'open') {
      await waitForWhatsAppCredsSave(session.authDir)
      session.connected = true
      session.accountJid = sock.user?.id ?? ''
    }
    if (update.connection === 'close' && !session.connected) {
      if (isWhatsAppLoggedOut(update.lastDisconnect?.error)) {
        session.error = 'WhatsApp session logged out. Please scan again.'
        return
      }
      const status = getWhatsAppDisconnectStatus(update.lastDisconnect?.error)
      const shouldRestart = (status === POST_PAIRING_RESTART_STATUS || status === TIMED_OUT_STATUS)
        && session.restarts < MAX_LOGIN_RESTARTS
      if (!shouldRestart) {
        session.error = 'WhatsApp login connection closed. Please retry.'
        return
      }
      session.restarts += 1
      closeWhatsAppSocket(sock, 'WhatsApp login restart')
      try {
        await waitForWhatsAppCredsSave(session.authDir)
        await connectLoginSocket(sessionKey, session)
      } catch (err) {
        if (sessions.get(sessionKey) !== session) return
        console.warn('[WhatsApp] Login socket restart failed:', err instanceof Error ? err.message : err)
        session.error = 'WhatsApp login connection closed. Please retry.'
      }
    }
  })
}

export async function pollWhatsAppLoginWithQr(options: {
  sessionKey: string
}): Promise<WhatsAppLoginPollResult> {
  cleanupExpiredSessions()
  const session = sessions.get(options.sessionKey)
  if (!session) {
    return {
      connected: false,
      status: 'expired',
      message: 'WhatsApp login session expired. Generate a new QR code.',
    }
  }

  if (session.connected) {
    await waitForWhatsAppCredsSave(session.authDir)
    const accountJid = session.accountJid || session.sock.user?.id || ''
    closeWhatsAppSocket(session.sock, 'WhatsApp login complete')
    sessions.delete(options.sessionKey)
    return {
      connected: true,
      accountJid,
      authDir: session.authDir,
      message: 'WhatsApp linked successfully.',
    }
  }

  if (session.error) {
    closeWhatsAppSocket(session.sock, 'WhatsApp login error')
    sessions.delete(options.sessionKey)
    return {
      connected: false,
      status: 'error',
      message: session.error,
    }
  }

  return {
    connected: false,
    status: 'waiting',
    qr: session.qr,
    message: session.qr
      ? 'Waiting for WhatsApp scan confirmation...'
      : 'Waiting for WhatsApp QR code...',
  }
}

export async function logoutWhatsAppAuth(authDir: string): Promise<void> {
  closeSessionsForAuthDir(path.resolve(authDir))
  clearWhatsAppAuth(authDir)
}

function waitForQr(session: LoginSession): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (session.qr || session.connected || Date.now() - started > WAIT_FOR_QR_MS) {
        clearInterval(timer)
        resolve()
      }
    }, 250)
  })
}

function cleanupExpiredSessions(): void {
  const now = Date.now()
  for (const [sessionKey, session] of sessions) {
    if (now - session.createdAt <= LOGIN_TTL_MS) continue
    closeWhatsAppSocket(session.sock, 'WhatsApp login expired')
    sessions.delete(sessionKey)
  }
}

function closeSessionsForAuthDir(authDir: string): void {
  for (const [sessionKey, session] of sessions) {
    if (path.resolve(session.authDir) !== authDir) continue
    closeWhatsAppSocket(session.sock, 'WhatsApp login superseded')
    sessions.delete(sessionKey)
  }
}
