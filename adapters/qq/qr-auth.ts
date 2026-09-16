/**
 * QQ Open Platform QR provisioning.
 *
 * `@tencent-connect/qqbot-connector` drives the scan flow with callbacks and a
 * dispose function; the desktop settings page needs a start/poll pair it can
 * drive over HTTP. This module owns that adaptation: one attempt per session
 * key, terminal states latched so a slow poll still observes the result, and
 * QR refreshes surfaced so the UI can redraw the image.
 */

import * as crypto from 'node:crypto'

export type QqQrCredentials = { appId: string; appSecret: string; userOpenid?: string }

type QrConnectCallbacks = {
  onSuccess: (credentials: QqQrCredentials[]) => void
  onFailure: (error: Error) => void
  onQrDisplayed?: (url: string) => void
  onQrExpired?: () => void
}

type QrConnectOptions = {
  displayQrCodeToConsole?: boolean
  signal?: AbortSignal
  source?: string
}

export type StartQrConnect = (
  callbacks: QrConnectCallbacks,
  options?: QrConnectOptions,
) => () => void

export type QqQrStartResult = {
  sessionKey: string
  verificationUrl: string
  pollIntervalMs: number
  message: string
}

export type QqQrPollResult =
  | { connected: true; appId: string; appSecret: string; userOpenid?: string }
  | {
      connected: false
      status: 'waiting' | 'expired' | 'failed' | 'not_started'
      message: string
      /** Present when the connector rotated the code and the UI must redraw. */
      verificationUrl?: string
    }

const DEFAULT_SOURCE = 'claude-code-haha'
const QR_READY_TIMEOUT_MS = 20_000
const SESSION_TTL_MS = 10 * 60_000
export const QQ_POLL_INTERVAL_MS = 2_000

type QqLoginSession = {
  sessionKey: string
  verificationUrl: string
  /** Bumped on every QR rotation so a poll can tell the UI to redraw. */
  urlVersion: number
  deliveredUrlVersion: number
  status: 'waiting' | 'success' | 'expired' | 'failed'
  credentials?: QqQrCredentials
  failureMessage?: string
  dispose: () => void
  startedAt: number
}

const activeLogins = new Map<string, QqLoginSession>()

let startQrConnectImpl: StartQrConnect | null = null

/** Test seam: inject a fake connector instead of loading the real SDK. */
export function setQqQrConnector(impl: StartQrConnect | null): void {
  startQrConnectImpl = impl
}

async function resolveConnector(): Promise<StartQrConnect> {
  if (startQrConnectImpl) return startQrConnectImpl
  const mod = await import('@tencent-connect/qqbot-connector')
  return mod.startQrConnect as unknown as StartQrConnect
}

function purgeExpiredLogins(): void {
  const now = Date.now()
  for (const [key, session] of activeLogins) {
    if (now - session.startedAt <= SESSION_TTL_MS) continue
    activeLogins.delete(key)
    safeDispose(session)
  }
}

function safeDispose(session: QqLoginSession): void {
  try {
    session.dispose()
  } catch {
    // The connector is already finished in the common case.
  }
}

export async function startQqQrLogin(
  opts: { sessionKey?: string; source?: string } = {},
): Promise<QqQrStartResult> {
  purgeExpiredLogins()

  const sessionKey = opts.sessionKey || crypto.randomUUID()
  // Only one scan can be in flight: the settings page shows one QR at a time,
  // and every start mints a fresh key. Without this, closing the page without
  // cancelling leaves a connector polling the vendor until its TTL, and each
  // retry stacks another one on top.
  for (const [key, session] of activeLogins) {
    activeLogins.delete(key)
    safeDispose(session)
  }

  const startQrConnect = await resolveConnector()

  // The session record exists before the connector runs: a user who scans
  // faster than the first `await` still lands their result somewhere the poll
  // can read it, instead of into a `null` that silently drops the credentials.
  const session: QqLoginSession = {
    sessionKey,
    verificationUrl: '',
    urlVersion: 0,
    deliveredUrlVersion: 0,
    status: 'waiting',
    dispose: () => {},
    startedAt: Date.now(),
  }

  let resolveReady: ((url: string) => void) | null = null
  let rejectReady: ((error: Error) => void) | null = null
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const dispose = startQrConnect(
    {
      onQrDisplayed(url) {
        session.verificationUrl = url
        session.urlVersion += 1
        resolveReady?.(url)
      },
      onSuccess(credentials) {
        const first = credentials?.[0]
        if (!first?.appId || !first?.appSecret) {
          session.status = 'failed'
          session.failureMessage = 'QQ 返回的机器人凭据不完整，请重新扫码。'
          return
        }
        session.status = 'success'
        session.credentials = first
      },
      onFailure(error) {
        const message = error?.message ?? 'QQ 扫码授权失败。'
        // The connector reports expiry through onFailure once it stops retrying.
        session.status = /expire|timeout|过期/i.test(message) ? 'expired' : 'failed'
        session.failureMessage = message
        rejectReady?.(error instanceof Error ? error : new Error(message))
      },
    },
    { displayQrCodeToConsole: false, source: opts.source || DEFAULT_SOURCE },
  )
  session.dispose = dispose

  let verificationUrl: string
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  try {
    verificationUrl = await Promise.race([
      ready,
      new Promise<string>((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error('QQ 二维码获取超时，请重试。')),
          QR_READY_TIMEOUT_MS,
        )
      }),
    ])
  } catch (err) {
    safeDispose(session)
    throw err
  } finally {
    // Without this the timer holds the event loop for its full duration after
    // every successful start.
    if (readyTimer) clearTimeout(readyTimer)
  }

  session.deliveredUrlVersion = session.urlVersion
  activeLogins.set(sessionKey, session)

  return {
    sessionKey,
    verificationUrl,
    pollIntervalMs: QQ_POLL_INTERVAL_MS,
    message: '使用 QQ 扫描二维码，创建并授权机器人。',
  }
}

export function pollQqQrLogin(opts: { sessionKey: string }): QqQrPollResult {
  purgeExpiredLogins()

  const session = activeLogins.get(opts.sessionKey)
  if (!session) {
    return {
      connected: false,
      status: 'not_started',
      message: '当前没有进行中的 QQ 绑定，请重新生成二维码。',
    }
  }

  if (session.status === 'success' && session.credentials) {
    activeLogins.delete(opts.sessionKey)
    safeDispose(session)
    return {
      connected: true,
      appId: session.credentials.appId,
      appSecret: session.credentials.appSecret,
      userOpenid: session.credentials.userOpenid,
    }
  }

  if (session.status === 'expired' || session.status === 'failed') {
    activeLogins.delete(opts.sessionKey)
    safeDispose(session)
    return {
      connected: false,
      status: session.status,
      message: session.failureMessage
        ?? (session.status === 'expired' ? '二维码已过期，请重新生成。' : 'QQ 授权失败，请重新扫码。'),
    }
  }

  const rotated = session.urlVersion !== session.deliveredUrlVersion
  session.deliveredUrlVersion = session.urlVersion
  return {
    connected: false,
    status: 'waiting',
    message: '等待 QQ 扫码确认...',
    verificationUrl: rotated ? session.verificationUrl : undefined,
  }
}

export function cancelQqQrLogin(sessionKey: string): void {
  const session = activeLogins.get(sessionKey)
  if (!session) return
  activeLogins.delete(sessionKey)
  safeDispose(session)
}

/** Test seam: the module-level session map must not leak across test cases. */
export function resetQqQrLoginsForTest(): void {
  for (const session of activeLogins.values()) safeDispose(session)
  activeLogins.clear()
}
