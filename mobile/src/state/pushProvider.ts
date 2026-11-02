import type { Storage } from './storage'

/**
 * How this phone receives one computer's pushes:
 * - `direct`: the computer signs APNs / FCM itself (only the publisher's own machine has the keys);
 * - `expo`: the Expo Push Service holds this app's APNs credentials, so any computer can send;
 * - `desktop`: Android keeps a foreground connection and pulls alerts from the computer,
 *   the one channel that works on every phone without Google services or a store listing.
 */
export type PushProvider = 'direct' | 'expo' | 'desktop'

/** `GET /api/sessions/mobile-push`; older computers have no `providers`. */
export type HostPushStatus = {
  platforms?: { ios?: unknown; android?: unknown }
  providers?: { expo?: unknown; desktop?: unknown }
  /** Why the computer's latest send through a relay failed; absent once one succeeds. */
  relayErrors?: { expo?: unknown }
}

/** The relay failure that concerns a phone using `provider`, as text safe to show. */
export function relayFailure(provider: PushProvider, status: HostPushStatus) {
  const error = provider === 'expo' ? status.relayErrors?.expo : undefined
  return typeof error === 'string' && error ? error.slice(0, 200) : undefined
}

export function choosePushProvider(
  platform: 'ios' | 'android',
  status: HostPushStatus
): PushProvider | undefined {
  if (platform === 'android' && status.providers?.desktop === true) return 'desktop'
  // The computer's own keys also carry Live Activities, which Expo cannot.
  if (status.platforms?.[platform] === true) return 'direct'
  if (platform === 'ios' && status.providers?.expo === true) return 'expo'
  return undefined
}

/** One per computer: a computer learns only its own, so it cannot read another's alerts. */
export const pullTokenKey = (hostId: string) => `cc-haha.pushPullToken.${hostId}`
const PULL_TOKEN = /^[A-Za-z0-9_-]{43,128}$/
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2
    for (let c = 0; c < chars; c++) out += ALPHABET[(n >> (18 - 6 * c)) & 63]
  }
  return out
}

/** The token each provider registers with. Native modules are injected so this stays testable. */
export class PushTokens {
  private pulls = new Map<string, Promise<string>>()
  constructor(
    private secrets: Storage,
    private deps: {
      random(count: number): Uint8Array
      device(): Promise<string>
      expo(): Promise<string>
    }
  ) {}

  token(provider: PushProvider, hostId: string): Promise<string> {
    if (provider === 'direct') return this.deps.device()
    if (provider === 'expo') return this.deps.expo()
    return this.pullToken(hostId)
  }

  /** A random secret for this phone and computer, kept in SecureStore; it proves ownership when pulling. */
  private pullToken(hostId: string): Promise<string> {
    let pending = this.pulls.get(hostId)
    if (!pending) {
      pending = (async () => {
        const stored = await this.secrets.getItem(pullTokenKey(hostId))
        if (stored && PULL_TOKEN.test(stored)) return stored
        const token = base64url(this.deps.random(32))
        await this.secrets.setItem(pullTokenKey(hostId), token)
        return token
      })().catch((error) => {
        this.pulls.delete(hostId)
        throw error
      })
      this.pulls.set(hostId, pending)
    }
    return pending
  }

  /** The computer was removed; a later pairing with it starts from a new secret. */
  async forget(hostId: string) {
    this.pulls.delete(hostId)
    await this.secrets.removeItem(pullTokenKey(hostId))
  }
}
