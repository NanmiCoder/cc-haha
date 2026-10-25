/**
 * 电脑上「连接器」目录在手机上的样子，规则和桌面输入框「＋」菜单一致
 * （desktop/src/components/chat/capabilityMenuModel.ts）：
 * 已连接、需要处理、推荐（固定名单，跳过已安装的）、其余。
 * 手机上不能安装也不能授权，这里只负责分类和展示。
 */

/** 手机拿到的一个连接器：服务端对远程请求已经裁掉授权链接、错误原文和安装细节。 */
export type Connector = {
  id: string
  displayName?: string
  description?: string
  category?: string
  transport?: string
  collection?: string
  pluginId?: string
  status?: string
  connection?: string
  supported?: boolean
  installed?: boolean
  enabled?: boolean
  accountLabel?: string
  /** 正在安装或授权中：只有「有没有」有意义。 */
  operation?: { kind?: string; phase?: string }
}

/** 同桌面：推荐给还没添加的人，固定顺序；已安装的跳过，后面的顺位补上。 */
export const SUGGESTED_CONNECTOR_IDS = [
  'github',
  'feishu',
  'context7',
  'notion',
  'figma',
  'tencent-docs',
  'linear',
  'dingtalk',
  'wecom',
  'amap',
]
export const SUGGESTED_CONNECTOR_LIMIT = 3

/** 已经从技能市场下架的托管包，桌面输入框里也不出现。 */
const withdrawnPluginNames = new Set([
  'office-frontend-design',
  'office-canvas-design',
  'office-algorithmic-art',
  'office-webapp-testing',
  'office-mcp-builder',
])

export function isPluginIdVisible(pluginId: string): boolean {
  const [name, marketplace, ...rest] = pluginId.split('@')
  return marketplace !== 'haha-connectors' || rest.length > 0 || !withdrawnPluginNames.has(name ?? '')
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined)

/** `/api/connectors` 的返回体：不是 `{ items: [...] }`（接口不存在、被拦截后的错误体）就当作不可用。 */
export function normalizeConnectors(value: unknown): Connector[] | null {
  if (!value || typeof value !== 'object') return null
  const list = (value as Record<string, unknown>).items
  if (!Array.isArray(list)) return null
  const connectors: Connector[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const id = text(raw.id)
    if (!id) continue
    const operation =
      raw.operation && typeof raw.operation === 'object'
        ? { kind: text((raw.operation as Record<string, unknown>).kind), phase: text((raw.operation as Record<string, unknown>).phase) }
        : undefined
    connectors.push({
      id,
      displayName: text(raw.displayName),
      description: text(raw.description),
      category: text(raw.category),
      transport: text(raw.transport),
      collection: text(raw.collection),
      pluginId: text(raw.pluginId),
      status: text(raw.status),
      connection: text(raw.connection),
      supported: flag(raw.supported),
      installed: flag(raw.installed),
      enabled: flag(raw.enabled),
      accountLabel: text(raw.accountLabel),
      ...(operation ? { operation } : {}),
    })
  }
  return connectors
}

/** 技能包也在目录里，但它们不是要连接的服务。 */
export const isServiceConnector = (connector: Connector) =>
  connector.collection !== 'tools' && connector.transport !== 'skills'

export const isVisibleConnector = (connector: Connector) =>
  connector.supported === true && isServiceConnector(connector) && isPluginIdVisible(connector.pluginId ?? '')

/** 已安装、没有正在进行的操作、又没连上，而且是要授权或出错了。 */
export const connectorNeedsAttention = (connector: Connector) =>
  !!connector.installed &&
  !connector.operation &&
  connector.connection !== 'connected' &&
  (connector.connection === 'needs-auth' || connector.status === 'needs-auth' || connector.status === 'error')

export type ConnectorSections = {
  connected: Connector[]
  attention: Connector[]
  suggested: Connector[]
  /** 「浏览全部」展开后的其余连接器：上面三段没列出的。 */
  rest: Connector[]
}

export function connectorSections(connectors: Connector[]): ConnectorSections {
  const visible = connectors.filter(isVisibleConnector)
  const connected = visible.filter((connector) => connector.connection === 'connected')
  const attention = visible.filter(connectorNeedsAttention)
  const byId = new Map(visible.map((connector) => [connector.id, connector]))
  const suggested = SUGGESTED_CONNECTOR_IDS.map((id) => byId.get(id))
    .filter((connector): connector is Connector => !!connector && !connector.installed && !connector.operation)
    .slice(0, SUGGESTED_CONNECTOR_LIMIT)
  const shown = new Set([...connected, ...attention, ...suggested].map((connector) => connector.id))
  return { connected, attention, suggested, rest: visible.filter((connector) => !shown.has(connector.id)) }
}
