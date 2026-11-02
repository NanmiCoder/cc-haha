import { ApiError, type ApiClient } from './client'
import { parseConnectionInput } from './connection'
import type { Host, PairClaim, PairRequest } from './types'

/**
 * 连接进度阶段：界面据此决定在表单里内联显示进度，还是切到「等电脑批准」整页。
 * verifying=局域网验证，requesting=向电脑发起配对，approval=等待电脑上的人批准。
 */
export type ConnectPhase = 'verifying' | 'requesting' | 'approval'

const cancelled = (signal: AbortSignal) => {
  if (signal.aborted) throw new ApiError('连接已取消', 0, 'ABORTED')
}
export function pairingMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    /expired|invalid.*pair|pairing.*invalid/i.test(error.message)
  )
    return '配对二维码已过期或已使用。请在电脑上生成新二维码后重试。'
  if (error instanceof ApiError && error.status === 429)
    return '电脑暂时无法接受更多配对，请稍后再试。'
  return error instanceof Error ? error.message : '连接未完成，请重试。'
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
    name: input.name.trim() || '我的电脑',
    url: parsed.url,
    auth: parsed.auth,
  }
  const now = dependencies.now ?? Date.now
  cancelled(input.signal)
  let credential = parsed.credential || input.token.trim()
  if (host.auth === 'lan') {
    if (!credential)
      throw new Error(
        '请输入电脑「设置 → 手机连接」中的访问令牌，或扫描完整二维码。'
      )
    input.onStatus('正在验证局域网连接…', 'verifying')
    await dependencies.client(host, credential).verify({ signal: input.signal })
  } else {
    if (input.platform === 'web')
      throw new Error('远程配对需要使用原生 App。浏览器预览仅支持局域网。')
    if (!parsed.pairSecret)
      throw new Error(
        '请在电脑「设置 → 手机连接 → 外出连接」生成并扫描二维码，或粘贴完整配对链接。'
      )
    const client = dependencies.client(host, '')
    input.onStatus('正在请求电脑授权…', 'requesting')
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
      throw new Error('电脑返回了无效的配对请求，请升级电脑端后重试。')
    const deadline = now() + 300000
    credential = ''
    input.onStatus('请在电脑上批准这台手机。批准后会自动连接。', 'approval')
    while (now() < deadline) {
      cancelled(input.signal)
      const claim = await client.post<PairClaim>(
        '/api/public-access/claim',
        pair,
        { signal: input.signal }
      )
      cancelled(input.signal)
      if (claim.status === 'rejected')
        throw new Error('电脑拒绝了这次连接。请重新生成配对码后重试。')
      if (claim.status === 'approved') {
        if (
          !claim.token?.startsWith('native_') ||
          claim.tokenType !== 'Bearer' ||
          !claim.deviceId ||
          !Number.isFinite(claim.expiresAt) ||
          claim.expiresAt <= now()
        )
          throw new Error(
            '电脑没有返回有效的 App 授权。请升级电脑端并重新配对。'
          )
        credential = claim.token
        break
      }
      if (claim.status !== 'pending')
        throw new Error('无法确认电脑的授权状态，请重新配对。')
      await (dependencies.wait ?? wait)(input.signal)
    }
    if (!credential)
      throw new Error('等待授权已超时，请在电脑上生成新的配对二维码。')
  }
  cancelled(input.signal)
  return { host, credential }
}
