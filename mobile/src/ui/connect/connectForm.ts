import { parseConnectionInput, type ParsedConnection } from '../../core/connection'

/** 手动连接面板顶部的两种方式。真正走哪条协议仍由地址本身决定。 */
export type ConnectMode = 'lan' | 'remote'

export const defaultHostName = '我的电脑'

function parse(value: string): ParsedConnection | null {
  try {
    return parseConnectionInput(value)
  } catch {
    // The field can be incomplete while the user is typing.
    return null
  }
}

/** 输入框里的地址能解析出什么；解析不了时返回 null（还在输入中）。 */
export function inspectAddress(value: string) {
  const parsed = parse(value)
  if (!parsed) return null
  return {
    auth: parsed.auth,
    hostname: new URL(parsed.url).hostname,
    pairing: Boolean(parsed.pairSecret),
    embeddedCredential: Boolean(parsed.credential),
  }
}

/**
 * 地址变化后面板应切到哪种方式：带 #pair= 的配对链接切到公网，
 * 带局域网凭据的二维码切回局域网，其余保持用户当前的选择。
 */
export function modeForAddress(value: string, current: ConnectMode): ConnectMode {
  const info = inspectAddress(value)
  if (info?.pairing) return 'remote'
  if (info?.embeddedCredential) return 'lan'
  return current
}

/** 扫码或粘贴进来的内容：解析失败直接抛出原有的错误文案。 */
export function receivedConnection(value: string) {
  const parsed = parseConnectionInput(value)
  return {
    address: value,
    name: new URL(parsed.url).hostname,
    mode: (parsed.auth === 'remote' ? 'remote' : 'lan') as ConnectMode,
  }
}

/** 地址里带配对码或局域网令牌时按密码框打码。 */
export function shouldMaskAddress(value: string) {
  return value.includes('#pair=') || value.includes('h5Token=')
}

/** 局域网且链接里没带凭据时，才需要手动填访问令牌。 */
export function needsToken(mode: ConnectMode, value: string) {
  return mode === 'lan' && !inspectAddress(value)?.embeddedCredential
}

/** 用户选的方式和地址对不上时，先在本地说明，不去联系电脑。 */
export function connectionBlocker(mode: ConnectMode, value: string): string {
  const info = inspectAddress(value)
  if (!info) return ''
  if (mode === 'remote' && info.auth === 'lan')
    return '这是局域网地址。公网连接请粘贴带配对码的 HTTPS 链接，或切换到「同一个局域网」。'
  if (mode === 'lan' && info.pairing)
    return '这是公网配对链接，请切换到「公网链接」后再连接。'
  return ''
}

export function formFootnote(mode: ConnectMode, value: string) {
  if (mode === 'remote')
    return '配对链接会请求电脑授权。请在电脑上核对这台手机并批准，链接过期后需要重新生成。'
  if (inspectAddress(value)?.embeddedCredential)
    return '二维码已包含局域网凭据。手机和电脑需要能通过这个地址互相访问。'
  return '手机和电脑要在同一个网络。令牌在电脑的「设置 → H5 访问」里。'
}

export const addressPlaceholder = (mode: ConnectMode) =>
  mode === 'remote' ? 'https://…/remote#pair=…' : 'http://192.168.1.10:3456'

export const primaryTitle = (mode: ConnectMode) =>
  mode === 'remote' ? '请求电脑授权' : '连接'

/** 等电脑批准页上的等宽胶囊。 */
export function remoteBadge(value: string) {
  const info = inspectAddress(value)
  return info ? `公网 · ${info.hostname}` : '公网'
}
