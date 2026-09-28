import type { TranslationKey } from '@/i18n'

export function networkIssueKey(code: string): TranslationKey | null {
  if (['PLAN_STALE', 'PLAN_EXPIRED', 'FIELD_CHANGED', 'PROXY_CONFIG_CHANGED'].includes(code)) return 'networkManager.errorPlan'
  if (['INVALID_NETWORK_PROFILE', 'NETWORK_CONFIG_INVALID', 'NETWORK_CONFIG_LIMIT', 'PROFILE_LIMIT'].includes(code)) return 'networkManager.errorProfile'
  if (code === 'REVISION_CONFLICT') return 'networkManager.errorRevision'
  if (code.startsWith('PROXY_')) return 'networkManager.errorProxy'
  if (code.startsWith('SAKURA_')) return 'networkManager.errorLogin'
  if (code.includes('RECOVERY')) return 'networkManager.errorRecovery'
  if (code === 'MANAGEMENT_UNREACHABLE') return 'networkManager.errorManagement'
  if (code.includes('SOURCE_ACL') || code.startsWith('RELAY_UNREACHABLE')) return 'networkManager.errorAcl'
  if (code === 'NETWORK_BUSY') return 'networkManager.errorBusy'
  if (['HOST_NOT_FOUND', 'INVALID_HOST_ID'].includes(code)) return 'networkManager.errorHost'
  if (code === 'WINDOWS_REQUIRED') return 'networkManager.unsupported'
  return null
}
