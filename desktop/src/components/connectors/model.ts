import type { ConnectorAction, ConnectorDto } from '@/types/connector'

export function primaryAction(connector: ConnectorDto): Exclude<ConnectorAction, 'cancel' | 'remove' | 'deactivate'> | null {
  if (!connector.supported || connector.operation) return null
  if (!connector.installed || connector.updateAvailable) return 'prepare'
  if (connector.status === 'disabled') return 'check'
  if (connector.status === 'error') {
    if (['prepare', 'downloading', 'extracting', 'verifying'].includes(connector.failedPhase || '')) return 'prepare'
    if (connector.transport === 'skills' || connector.collection === 'tools') return 'check'
    if (['authenticate', 'authorizing', 'awaiting-authorization', 'configuring-account'].includes(connector.failedPhase || '')) return 'authenticate'
    return 'check'
  }
  if (connector.transport === 'skills' || connector.collection === 'tools') return connector.enabled && (connector.status === 'ready' || connector.status === 'configured') ? null : 'check'
  if (connector.status === 'needs-auth' || connector.connection === 'needs-auth') return 'authenticate'
  if (connector.status === 'ready' || connector.status === 'configured') return null
  return 'check'
}

// A connector that already holds a credential can be connected or re-checked
// with an untouched setup form: blank fields keep the stored secret. Until a
// successful connection proves a credential exists, blank fields are
// missing input instead of an implicit "use what is stored".
export function hasStoredCredentials(connector: ConnectorDto): boolean {
  return connector.connection === 'connected' || connector.status === 'ready' || connector.status === 'configured'
}

export function safeConnectorUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch { return null }
}
