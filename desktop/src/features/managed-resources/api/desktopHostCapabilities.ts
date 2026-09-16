import type { DesktopHost } from '../../../lib/desktopHost/types'
import { getDesktopHost } from '../../../lib/desktopHost'

export function isHostManagementSupported(host: DesktopHost = getDesktopHost()): boolean {
  return Boolean(host.capabilities.hostManagement)
}

export function isConceptKnowledgeSupported(host: DesktopHost = getDesktopHost()): boolean {
  return Boolean(host.capabilities.conceptKnowledge)
}

export function isConversationContextSupported(host: DesktopHost = getDesktopHost()): boolean {
  return Boolean(host.capabilities.conversationContext)
}

export function isDataConnectionsSupported(host: DesktopHost = getDesktopHost()): boolean {
  return Boolean(host.capabilities.dataConnections)
}
