import type { TranslationKey, useTranslation } from '../../../../i18n'
import type { HostManagementError } from '../../api/hostManagementApi'

type Translator = ReturnType<typeof useTranslation>
const messages: Record<string, TranslationKey> = {
  REVISION_CONFLICT: 'managedResources.revisionConflict',
  VAULT_UNAVAILABLE: 'managedResources.vaultUnavailableNotice',
  CREDENTIAL_LEAK_DETECTED: 'managedResources.m2.unsafeImport',
  VALIDATION_FAILED: 'managedResources.m2.invalidInput',
  INVALID_ARGUMENT: 'managedResources.m2.invalidInput',
  INVALID_CREDENTIAL_PAYLOAD: 'managedResources.m2.invalidInput',
  INVALID_TEMPORARY_CREDENTIAL: 'managedResources.m2.invalidInput',
  RESOURCE_IN_USE: 'managedResources.m2.resourceInUse',
  UNAVAILABLE: 'managedResources.m2.unavailable',
  READ_ONLY: 'managedResources.m2.readOnly',
  WRITE_FAILED: 'managedResources.m2.writeFailed',
  FILE_TOO_LARGE: 'managedResources.m2.fileTooLarge',
  NEWER_SCHEMA_VERSION: 'managedResources.m2.newerVersion',
  NOT_FOUND: 'managedResources.m2.notFound',
  RESOURCE_NOT_FOUND: 'managedResources.m2.notFound',
}

// Error messages and params can contain untrusted URLs or credentials. Display
// only a localized, allowlisted description, never raw transport exceptions.
export function resourceErrorMessage(t: Translator, error?: Pick<HostManagementError, 'code'>): string {
  return t(messages[error?.code ?? ''] ?? 'managedResources.m2.operationFailed')
}
