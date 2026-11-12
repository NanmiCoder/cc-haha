/**
 * How the computer's Connectors directory looks on the phone; rules match the desktop input "+" menu
 * (desktop/src/components/chat/capabilityMenuModel.ts): 
 * connected, needs attention, recommended (fixed list, skipping installed), rest.
 * The phone can neither install nor authorize; this only classifies and displays.
 */

import { isPluginIdVisible } from './capabilityVisibility'

/** A connector as received by the phone: the server already strips auth links, raw errors and install details for remote requests. */
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
  /** Installing or authorizing: only "whether there is one" matters. */
  operation?: { kind?: string; phase?: string }
}

/** Same as desktop: recommend to those who have not added them, in fixed order; skip installed ones and fill from the next. */
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

export { isPluginIdVisible }

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined)

/** `/api/connectors` response body: anything other than `{ items: [...] }` (missing endpoint, error body after being blocked) counts as unavailable. */
/** The desktop server sends no names for these three native connectors (desktop shows localized copy); mobile uses the same English names. */
const nativeNames: Record<string, { name: string; description: string }> = {
  feishu: { name: 'Feishu', description: 'Manage Feishu docs, calendar and office collaboration.' },
  dingtalk: { name: 'DingTalk', description: 'Connect DingTalk calendar and team office services.' },
  wecom: { name: 'WeCom', description: 'Use WeCom for team collaboration.' },
}

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
      displayName: text(raw.displayName) ?? nativeNames[id]?.name,
      description: text(raw.description) ?? nativeNames[id]?.description,
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

/** Skill packages are also in the directory, but they are not services to connect. */
export const isServiceConnector = (connector: Connector) =>
  connector.collection !== 'tools' && connector.transport !== 'skills'

export const isVisibleConnector = (connector: Connector) =>
  connector.supported === true && isServiceConnector(connector) && isPluginIdVisible(connector.pluginId ?? '')

/** Installed, no operation in progress, not connected, and needs auth or errored. */
export const connectorNeedsAttention = (connector: Connector) =>
  !!connector.installed &&
  !connector.operation &&
  connector.connection !== 'connected' &&
  (connector.connection === 'needs-auth' || connector.status === 'needs-auth' || connector.status === 'error')

export type ConnectorSections = {
  connected: Connector[]
  attention: Connector[]
  suggested: Connector[]
  /** Remaining connectors after expanding Browse all: those not listed in the three sections above. */
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
