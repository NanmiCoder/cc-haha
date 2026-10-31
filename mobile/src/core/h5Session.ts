import { isLocalHostname } from './connection'
import type { Host } from './types'

/**
 * H5：桌面服务端把这份网页版托管给手机浏览器。页面所在的电脑就是唯一的电脑，
 * 没有添加、切换、配对电脑这些步骤——连接由桌面 H5 的入口（令牌页、远程配对页）
 * 完成，这里只沿用它已经验证过的那份凭据。
 */

/** 桌面 H5 入口验证令牌后写下的两个键，见 desktop/src/lib/desktopRuntime.ts。 */
export const H5_SERVER_URL_STORAGE_KEY = 'cc-haha-h5-server-url'
export const H5_TOKEN_STORAGE_KEY = 'cc-haha-h5-token'
export const H5_HOST_ID = 'h5'
export const H5_HOST_NAME = '这台电脑'

export type H5Location = { origin: string; hostname: string }
export type H5Storage = { getItem(key: string): string | null }

/**
 * 页面能直接用的连接方式，按优先级：
 * - token：局域网 H5，桌面入口验证过、属于这个地址的访问令牌；
 * - cookie：远程浏览器，桌面入口配对后由服务端种下的设备 Cookie，浏览器自己带上；
 * - loopback：就在这台电脑上打开，服务端信任回环地址，不需要凭据。
 */
export type H5Credential =
  | { kind: 'token'; token: string }
  | { kind: 'cookie' }
  | { kind: 'loopback' }

/** 只取属于当前地址的令牌：令牌只对验证它的那台服务器有效。 */
export function storedH5Token(location: H5Location, storage: H5Storage | null): string | null {
  if (!storage) return null
  let serverUrl: string | null
  let token: string | null
  try {
    serverUrl = storage.getItem(H5_SERVER_URL_STORAGE_KEY)
    token = storage.getItem(H5_TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
  const value = token?.trim()
  if (!value || /\s|[\u0000-\u001f\u007f]/.test(value)) return null
  return normalizeOrigin(serverUrl) === location.origin ? value : null
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
}

/**
 * 页面这台电脑。`auth` 沿用原生 App 的含义：remote 表示经公网网关访问
 * （首页显示「公网」、读取授权到期时间），其余都是 lan。
 */
export function h5Host(location: H5Location, credential: H5Credential): Host {
  return {
    id: H5_HOST_ID,
    name: H5_HOST_NAME,
    url: location.origin,
    auth: credential.kind === 'cookie' && !isLocalHostname(location.hostname) ? 'remote' : 'lan',
    page: true,
  }
}

/** 请求和 WebSocket 里携带的凭据字符串；Cookie 和回环地址不需要。 */
export function h5CredentialValue(credential: H5Credential): string {
  return credential.kind === 'token' ? credential.token : ''
}

/**
 * 凭据失效或缺失时回到桌面 H5 入口：那里有令牌页和远程配对页，完成后会再送回来。
 * 局域网入口带上 `reconnect`：桌面 index.html 对已存令牌的手机会直接跳回这里，
 * 带参数才会重新验证令牌（失效的令牌在那里被清掉、显示令牌页）。
 */
export function h5EntryUrl(location: H5Location, remote: boolean): string {
  return `${location.origin}${remote ? '/remote' : '/?reconnect=1'}`
}

type SessionProbe = (
  url: string,
  init: { credentials: 'same-origin'; redirect: 'error'; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type H5Resolution =
  | { credential: H5Credential; host: Host }
  /** 这个页面还没连上：回到桌面入口（局域网是令牌页，远程网关是配对页）。 */
  | { entry: string }

/**
 * 决定页面用哪种凭据连接电脑。令牌不需要请求就能判断；没有令牌时问一次
 * 远程网关的会话接口——只有网关会回答它（主服务端对浏览器一律拒绝），
 * 回答了「未登录」就说明这是远程网关上一个还没配对的浏览器。
 */
export async function resolveH5Session(input: {
  location: H5Location
  storage: H5Storage | null
  fetch: SessionProbe
  signal?: AbortSignal
}): Promise<H5Resolution> {
  const { location } = input
  const token = storedH5Token(location, input.storage)
  if (token) {
    const credential = { kind: 'token', token } as const
    return { credential, host: h5Host(location, credential) }
  }
  let gateway = false
  try {
    const response = await input.fetch(`${location.origin}/api/public-access/session`, {
      credentials: 'same-origin',
      redirect: 'error',
      signal: input.signal,
    })
    if (response.ok) {
      gateway = true
      const session = (await response.json()) as { authenticated?: unknown } | null
      if (session?.authenticated === true) {
        const credential = { kind: 'cookie' } as const
        return { credential, host: h5Host(location, credential) }
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    // 网络失败时不判断是不是网关；回环地址仍可直接连接。
  }
  if (!gateway && isLoopbackHostname(location.hostname)) {
    const credential = { kind: 'loopback' } as const
    return { credential, host: h5Host(location, credential) }
  }
  return { entry: h5EntryUrl(location, gateway) }
}
