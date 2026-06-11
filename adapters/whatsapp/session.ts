import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'

export type WhatsAppSocket = ReturnType<typeof makeWASocket>

const CREDS_FILE = 'creds.json'
const CREDS_BACKUP_FILE = 'creds.json.bak'
const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401

const credsSaveQueues = new Map<string, Promise<void>>()

export function hasWhatsAppAuth(authDir: string): boolean {
  return fs.existsSync(resolveCredsPath(authDir))
}

export function clearWhatsAppAuth(authDir: string): void {
  fs.rmSync(authDir, { recursive: true, force: true })
}

export function getWhatsAppDisconnectStatus(error: unknown): number | undefined {
  const candidate = error as {
    output?: { statusCode?: unknown }
    statusCode?: unknown
  } | null
  const status = candidate?.output?.statusCode ?? candidate?.statusCode
  return typeof status === 'number' ? status : undefined
}

export function isWhatsAppLoggedOut(error: unknown): boolean {
  return getWhatsAppDisconnectStatus(error) === LOGGED_OUT_STATUS
}

export async function createWhatsAppSocket(options: {
  authDir: string
  onQr?: (qr: string) => void
  verbose?: boolean
}): Promise<WhatsAppSocket> {
  const authDir = path.resolve(options.authDir)
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })
  maybeRestoreCredsFromBackup(authDir)

  const logger = makeBaileysLogger(options.verbose ? 'info' : 'silent')
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ['cc-haha', 'desktop', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', () => enqueueSaveCreds(authDir, saveCreds))
  if (options.onQr) {
    sock.ev.on('connection.update', (update) => {
      if (update.qr) options.onQr?.(update.qr)
    })
  }
  const ws = sock.ws as unknown as { on?: (event: string, handler: (err: Error) => void) => void }
  ws.on?.('error', (err) => {
    console.error('[WhatsApp] WebSocket error:', err.message)
  })

  return sock
}

export function closeWhatsAppSocket(sock: WhatsAppSocket, reason = 'closed'): void {
  try {
    const closable = sock as unknown as { end?: (error?: Error) => void }
    closable.end?.(new Error(reason))
  } catch {
    // best-effort shutdown
  }
}

export async function waitForWhatsAppCredsSave(authDir: string): Promise<void> {
  await (credsSaveQueues.get(path.resolve(authDir)) ?? Promise.resolve())
}

function resolveCredsPath(authDir: string): string {
  return path.join(path.resolve(authDir), CREDS_FILE)
}

function resolveCredsBackupPath(authDir: string): string {
  return path.join(path.resolve(authDir), CREDS_BACKUP_FILE)
}

function maybeRestoreCredsFromBackup(authDir: string): void {
  const credsPath = resolveCredsPath(authDir)
  const backupPath = resolveCredsBackupPath(authDir)
  if (isValidJsonFile(credsPath) || !isValidJsonFile(backupPath)) return
  fs.copyFileSync(backupPath, credsPath)
  fs.chmodSync(credsPath, 0o600)
}

function enqueueSaveCreds(authDir: string, saveCreds: () => Promise<void> | void): void {
  const resolved = path.resolve(authDir)
  const prev = credsSaveQueues.get(resolved) ?? Promise.resolve()
  const next = prev
    .then(() => safeSaveCreds(resolved, saveCreds))
    .catch((err) => {
      console.warn('[WhatsApp] Failed to save credentials:', err instanceof Error ? err.message : err)
    })
    .finally(() => {
      if (credsSaveQueues.get(resolved) === next) {
        credsSaveQueues.delete(resolved)
      }
    })
  credsSaveQueues.set(resolved, next)
}

async function safeSaveCreds(authDir: string, saveCreds: () => Promise<void> | void): Promise<void> {
  backupCreds(authDir)
  await Promise.resolve(saveCreds())
  fs.chmodSync(resolveCredsPath(authDir), 0o600)
}

function backupCreds(authDir: string): void {
  const credsPath = resolveCredsPath(authDir)
  if (!isValidJsonFile(credsPath)) return
  try {
    const backupPath = resolveCredsBackupPath(authDir)
    fs.copyFileSync(credsPath, backupPath)
    fs.chmodSync(backupPath, 0o600)
  } catch {
    // keep the previous backup
  }
}

function isValidJsonFile(filePath: string): boolean {
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return true
  } catch {
    return false
  }
}

function makeBaileysLogger(level: 'silent' | 'info'): any {
  const noop = () => {}
  const sink = level === 'silent'
    ? { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
    : {
        trace: console.debug.bind(console),
        debug: console.debug.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        fatal: console.error.bind(console),
      }
  return {
    level,
    child: () => makeBaileysLogger(level),
    ...sink,
  }
}
