import { ApiError, type ApiClient } from './client'
import { parseConnectionInput } from './connection'
import type { Host, PairClaim, PairRequest } from './types'

/**
 * Connection progress stage: the UI uses it to decide whether to show progress inline in the form or switch to the full wait-for-approval page.
 * verifying=LAN verification; requesting = starting pairing with the computer; approval = waiting for a person to approve on the computer.
 */
export type ConnectPhase = 'verifying' | 'requesting' | 'approval'

const cancelled = (signal: AbortSignal) => {
  if (signal.aborted) throw new ApiError('Connection canceled', 0, 'ABORTED')
}
export function pairingMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    /expired|invalid.*pair|pairing.*invalid/i.test(error.message)
  )
    return 'The pairing QR code has expired or been used. Generate a new one on the computer and retry.'
  if (error instanceof ApiError && error.status === 429)
    return 'The computer cannot accept more pairings right now; please try again later.'
  return error instanceof Error ? error.message : 'Connection did not complete, please retry.'
}
const wait = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, 1500)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })

/** Verifies the real desktop connection before a credential can enter storage. */
export async function connectHost(
  input: {
    value: string
    token: string
    name: string
    id: string
    platform: string
    signal: AbortSignal
    onStatus(value: string, phase: ConnectPhase): void
  },
  dependencies: {
    client(host: Host, credential: string): Pick<ApiClient, 'post' | 'verify'>
    now?: () => number
    wait?: (signal: AbortSignal) => Promise<void>
  }
): Promise<{ host: Host; credential: string }> {
  const parsed = parseConnectionInput(input.value)
  const host: Host = {
    id: input.id,
    name: input.name.trim() || 'My computer',
    url: parsed.url,
    auth: parsed.auth,
  }
  const now = dependencies.now ?? Date.now
  cancelled(input.signal)
  let credential = parsed.credential || input.token.trim()
  if (host.auth === 'lan') {
    if (!credential)
      throw new Error(
        'Enter the access token from Settings → Mobile connection on the computer, or scan the full QR code.'
      )
    input.onStatus('Verifying LAN connection…', 'verifying')
    await dependencies.client(host, credential).verify({ signal: input.signal })
  } else {
    if (input.platform === 'web')
      throw new Error('Remote pairing requires the native app. Browser preview supports LAN only.')
    if (!parsed.pairSecret)
      throw new Error(
        'Generate and scan a QR code in Settings → Mobile connection → Away connection on the computer, or paste the full pairing link.'
      )
    const client = dependencies.client(host, '')
    input.onStatus('Requesting authorization from the computer…', 'requesting')
    const pair = await client.post<PairRequest>(
      '/api/public-access/pair',
      {
        secret: parsed.pairSecret,
        name: `cc-haha App · ${input.platform}`,
        clientType: 'native',
      },
      { signal: input.signal }
    )
    if (!pair.id || !pair.claimSecret)
      throw new Error('The computer returned an invalid pairing request; update the desktop app and retry.')
    const deadline = now() + 300000
    credential = ''
    input.onStatus('Approve this phone on the computer. It connects automatically after approval.', 'approval')
    while (now() < deadline) {
      cancelled(input.signal)
      const claim = await client.post<PairClaim>(
        '/api/public-access/claim',
        pair,
        { signal: input.signal }
      )
      cancelled(input.signal)
      if (claim.status === 'rejected')
        throw new Error('The computer rejected this connection. Generate a new pairing code and retry.')
      if (claim.status === 'approved') {
        if (
          !claim.token?.startsWith('native_') ||
          claim.tokenType !== 'Bearer' ||
          !claim.deviceId ||
          !Number.isFinite(claim.expiresAt) ||
          claim.expiresAt <= now()
        )
          throw new Error(
            'The computer did not return a valid app authorization. Update the desktop app and pair again.'
          )
        credential = claim.token
        break
      }
      if (claim.status !== 'pending')
        throw new Error('Cannot confirm the computer authorization status; please pair again.')
      await (dependencies.wait ?? wait)(input.signal)
    }
    if (!credential)
      throw new Error('Waiting for authorization timed out; generate a new pairing QR code on the computer.')
  }
  cancelled(input.signal)
  return { host, credential }
}
