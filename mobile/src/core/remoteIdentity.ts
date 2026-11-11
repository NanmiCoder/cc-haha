import { ApiError, type ApiClient } from './client'
import { normalizeHostUrl } from './connection'
import type { Host } from './types'

export type RemoteBinding = { hostKey: string; directory: string }
/** Public trust anchors only. Device private keys stay in Android Keystore. */
export type RemoteIdentity = RemoteBinding & {
  hostId: string
  deviceId: string
  sequence: number
}
export type RemoteIdentityKeys = {
  hostId(publicKey: string): Promise<string>
  nonce(): Promise<string>
  hashText(value: string): Promise<string>
  ensurePublicKey(alias: string): Promise<string>
  exists(alias: string): Promise<boolean>
  sign(alias: string, purpose: string, fields: string[]): Promise<string>
  verify(publicKey: string, signature: string, purpose: string, fields: string[]): Promise<boolean>
  remove(alias: string): Promise<void>
}
type Client = Pick<ApiClient, 'get' | 'post' | 'verify'>
type ClientFactory = (host: Host, credential: string) => Client
const noncePattern = /^[A-Za-z0-9_-]{43}$/
const idPattern = /^[a-f0-9]{64}$/
const fail = () => new ApiError('电脑身份验证失败，请检查连接或重新扫码', 403, 'IDENTITY_FAILED')
const requirePairing = () => new ApiError('手机授权已撤销或设备密钥丢失，请重新配对', 401, 'PAIRING_REQUIRED')
const check = (condition: unknown): void => { if (!condition) throw fail() }
const alive = (signal: AbortSignal) => {
  if (signal.aborted) throw new ApiError('连接已取消', 0, 'ABORTED')
}
export const remoteKeyAlias = (id: string) => `cc-haha.remote.${id}`

export function parseRemoteIdentity(value: unknown): RemoteIdentity {
  if (!value || typeof value !== 'object') throw fail()
  const row = value as Record<string, unknown>
  check(typeof row.hostKey === 'string' && /^[A-Za-z0-9_-]{300,4096}$/.test(row.hostKey))
  check(typeof row.hostId === 'string' && idPattern.test(row.hostId))
  check(typeof row.deviceId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.deviceId))
  check(Number.isSafeInteger(row.sequence) && Number(row.sequence) >= 0)
  check(typeof row.directory === 'string')
  const directory = normalizeHostUrl(row.directory as string, 'remote')
  return { hostKey: row.hostKey as string, hostId: row.hostId as string,
    directory, deviceId: row.deviceId as string, sequence: row.sequence as number }
}

async function verifiedSignature(keys: RemoteIdentityKeys, key: string, body: Record<string, unknown>, purpose: string, fields: string[]) {
  check(typeof body.signature === 'string' && /^[A-Za-z0-9_-]{342}$/.test(body.signature))
  check(await keys.verify(key, body.signature as string, purpose, fields))
}

/** No saved credential or pairing material is sent until this endpoint proves the scanned key. */
export async function proveRemoteHost(host: Host, binding: RemoteBinding, keys: RemoteIdentityKeys,
  client: Pick<ApiClient, 'post'>, signal: AbortSignal, now = Date.now) {
  alive(signal)
  const hostId = await keys.hostId(binding.hostKey)
  check(idPattern.test(hostId))
  const nonce = await keys.nonce()
  check(noncePattern.test(nonce))
  const body = await client.post<Record<string, unknown>>('/api/public-access/native/challenge', { hostId, nonce }, { signal })
  alive(signal)
  check(body.version === 2 && body.hostId === hostId && body.publicKey === binding.hostKey && body.origin === host.url && body.nonce === nonce)
  check(typeof body.challenge === 'string' && noncePattern.test(body.challenge))
  check(Number.isSafeInteger(body.expiresAt) && Number(body.expiresAt) > now() && Number(body.expiresAt) <= now() + 90_000)
  await verifiedSignature(keys, binding.hostKey, body, 'host-proof', [hostId, host.url, nonce, body.challenge as string, String(body.expiresAt)])
  return { hostId, nonce, challenge: body.challenge as string, expiresAt: body.expiresAt as number }
}

export async function enrollRemoteIdentity(host: Host, binding: RemoteBinding, deviceId: string,
  keys: RemoteIdentityKeys, client: Pick<ApiClient, 'post'>, signal: AbortSignal): Promise<Host> {
  const hostId = await keys.hostId(binding.hostKey)
  const devicePublicKey = await keys.ensurePublicKey(remoteKeyAlias(host.id))
  const nonce = await keys.nonce()
  const signature = await keys.sign(remoteKeyAlias(host.id), 'enroll', [hostId, host.url, devicePublicKey, nonce])
  alive(signal)
  const body = await client.post<Record<string, unknown>>('/api/public-access/native/enroll', { devicePublicKey, nonce, signature }, { signal })
  alive(signal)
  check(body.version === 2 && body.hostId === hostId && body.origin === host.url && body.deviceId === deviceId && body.devicePublicKey === devicePublicKey && body.nonce === nonce)
  await verifiedSignature(keys, binding.hostKey, body, 'enrolled', [hostId, host.url, deviceId, devicePublicKey, nonce])
  return { ...host, remoteIdentity: { ...binding, hostId, deviceId, sequence: 0 } }
}

/** Only signed directory discovery plus a fresh host proof may change the stored origin. */
export async function recoverRemoteConnection(host: Host, credential: string, dependencies: {
  client: ClientFactory; keys: RemoteIdentityKeys; signal: AbortSignal; now?: () => number
}): Promise<{ host: Host; credential: string }> {
  if (!host.remoteIdentity) return { host, credential }
  const identity = parseRemoteIdentity(host.remoteIdentity)
  const { keys, signal, client } = dependencies
  const now = dependencies.now ?? Date.now
  check(await keys.hostId(identity.hostKey) === identity.hostId)
  if (!await keys.exists(remoteKeyAlias(host.id))) throw requirePairing()
  let next = host
  let proof: Awaited<ReturnType<typeof proveRemoteHost>>
  try {
    proof = await proveRemoteHost(host, identity, keys, client(host, ''), signal, now)
  } catch (original) {
    alive(signal)
    const directoryHost: Host = { ...host, url: identity.directory, remoteIdentity: undefined }
    let announcement: Record<string, unknown>
    try {
      announcement = await client(directoryHost, '').get<Record<string, unknown>>(`/v1/hosts/${identity.hostId}`, { signal })
    } catch { alive(signal); throw original }
    check(announcement.version === 2 && announcement.hostId === identity.hostId && announcement.publicKey === identity.hostKey)
    check(typeof announcement.origin === 'string')
    const origin = normalizeHostUrl(announcement.origin as string, 'remote')
    check(origin === announcement.origin)
    check(Number.isSafeInteger(announcement.sequence) && Number(announcement.sequence) >= identity.sequence)
    check(Number(announcement.sequence) > identity.sequence || origin === host.url)
    check(Number.isSafeInteger(announcement.expiresAt) && Number(announcement.expiresAt) > now() && Number(announcement.expiresAt) <= now() + 660_000)
    await verifiedSignature(keys, identity.hostKey, announcement, 'announce', [identity.hostId, origin, String(announcement.sequence), String(announcement.expiresAt)])
    next = { ...host, url: origin, remoteIdentity: { ...identity, sequence: announcement.sequence as number } }
    proof = await proveRemoteHost(next, identity, keys, client(next, ''), signal, now)
  }
  // The old token is never sent to the directory or a new origin.
  if (next.url === host.url && credential) {
    try {
      await client(next, credential).verify({ signal })
      return { host: next, credential }
    } catch (error) {
      alive(signal)
      if (!(error instanceof ApiError) || error.status !== 401) throw error
    }
  }
  if (proof.expiresAt <= now()) proof = await proveRemoteHost(next, identity, keys, client(next, ''), signal, now)
  const fields = [identity.hostId, next.url, identity.deviceId, proof.nonce, proof.challenge, String(proof.expiresAt)]
  const signature = await keys.sign(remoteKeyAlias(host.id), 'resume', fields)
  alive(signal)
  let body: Record<string, unknown>
  try {
    body = await client(next, '').post<Record<string, unknown>>('/api/public-access/native/session', {
      hostId: identity.hostId, deviceId: identity.deviceId, nonce: proof.nonce,
      challenge: proof.challenge, expiresAt: proof.expiresAt, signature, clientType: 'native',
    }, { signal })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw requirePairing()
    throw error
  }
  alive(signal)
  check(body.version === 2 && body.hostId === identity.hostId && body.origin === next.url && body.deviceId === identity.deviceId && body.nonce === proof.nonce)
  check(body.tokenType === 'Bearer' && typeof body.token === 'string' && /^native_[A-Za-z0-9_-]{43}$/.test(body.token))
  check(Number.isSafeInteger(body.expiresAt) && Number(body.expiresAt) > now())
  const tokenHash = await keys.hashText(body.token as string)
  check(body.tokenHash === tokenHash)
  await verifiedSignature(keys, identity.hostKey, body, 'session', [identity.hostId, next.url, identity.deviceId, proof.nonce, tokenHash, String(body.expiresAt)])
  return { host: next, credential: body.token as string }
}
