import { t } from '../../../../i18n'

/** Display only fixed error codes; never surface native exception/DSN text. */
export function dataBrowserMessage(code: string): string {
  if (code === 'QUERY_TIMEOUT') return t('managedResources.dataBrowser.timeout')
  if (code === 'QUERY_CANCEL_OUTCOME_UNKNOWN') return t('managedResources.dataBrowser.cancelUnknown')
  return `${t('managedResources.m2.operationFailed')} (${code})`
}
