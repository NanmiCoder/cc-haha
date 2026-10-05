// desktop/src/components/settings/CcSwitchImportModal.tsx

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderX, Inbox } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { Modal } from '@/components/ui/Modal'
import { cx } from '@/lib/cx'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useProviderStore } from '../../stores/providerStore'
import { useUIStore } from '../../stores/uiStore'
import type {
  CcSwitchAppType,
  CcSwitchCandidate,
  CcSwitchScanResult,
  CcSwitchSkipReason,
  CcSwitchUnavailableReason,
} from '../../types/provider'

const UNAVAILABLE_KEYS: Record<CcSwitchUnavailableReason, TranslationKey> = {
  'not-found': 'settings.providers.ccSwitch.unavailableNotFound',
  unreadable: 'settings.providers.ccSwitch.unavailableUnreadable',
  'schema-unsupported': 'settings.providers.ccSwitch.unavailableSchema',
  'version-too-old': 'settings.providers.ccSwitch.unavailableTooOld',
  'sqlite-unavailable': 'settings.providers.ccSwitch.unavailableSqlite',
}

const SKIP_KEYS: Record<CcSwitchSkipReason, TranslationKey> = {
  'no-base-url': 'settings.providers.ccSwitch.skipNoBaseUrl',
  'no-api-key': 'settings.providers.ccSwitch.skipNoApiKey',
  'no-model': 'settings.providers.ccSwitch.skipNoModel',
  'unsupported-format': 'settings.providers.ccSwitch.skipUnsupportedFormat',
  'full-url-endpoint': 'settings.providers.ccSwitch.skipFullUrlEndpoint',
}

const APP_TYPE_KEYS: Record<CcSwitchAppType, TranslationKey> = {
  claude: 'settings.providers.ccSwitch.appTypeClaude',
  'claude-desktop': 'settings.providers.ccSwitch.appTypeClaudeDesktop',
}

/**
 * Rows that already match one of our providers start unchecked: re-importing
 * them is the one outcome nobody asks for, and cc-switch users typically have
 * a handful of providers they already copied over by hand.
 */
function defaultSelection(candidates: CcSwitchCandidate[]): string[] {
  return candidates
    .filter((candidate) => candidate.importable && !candidate.duplicate)
    .map((candidate) => candidate.sourceId)
}

function importableIds(candidates: CcSwitchCandidate[]): string[] {
  return candidates.filter((candidate) => candidate.importable).map((candidate) => candidate.sourceId)
}

export type CcSwitchImportModalProps = {
  open: boolean
  onClose: () => void
}

/**
 * Bulk-imports the providers configured in cc-switch.
 *
 * The scan runs on open rather than behind a second click — there is nothing to
 * configure, and the dialog has no useful state before it resolves.
 */
export function CcSwitchImportModal({ open, onClose }: CcSwitchImportModalProps) {
  const t = useTranslation()
  const { scanCcSwitch, importCcSwitch } = useProviderStore()
  const addToast = useUIStore((s) => s.addToast)
  const [scan, setScan] = useState<CcSwitchScanResult | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [isImporting, setIsImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const runScan = useCallback(async () => {
    setIsScanning(true)
    setScanError(null)
    setImportError(null)
    try {
      const result = await scanCcSwitch()
      setScan(result)
      setSelectedIds(defaultSelection(result.candidates))
    } catch (err) {
      setScan(null)
      setSelectedIds([])
      setScanError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsScanning(false)
    }
  }, [scanCcSwitch])

  useEffect(() => {
    if (!open) return
    void runScan()
  }, [open, runScan])

  const candidates = scan?.candidates ?? []
  const selectable = useMemo(() => importableIds(candidates), [candidates])
  // Intersected rather than trusted: a re-scan can retire a source id that is
  // still sitting in the selection.
  const selectedCount = useMemo(
    () => selectedIds.filter((id) => selectable.includes(id)).length,
    [selectedIds, selectable],
  )

  const toggleCandidate = (sourceId: string, checked: boolean) => {
    setSelectedIds((current) => (
      checked
        ? current.includes(sourceId) ? current : [...current, sourceId]
        : current.filter((id) => id !== sourceId)
    ))
  }

  const handleClose = () => {
    if (isImporting) return
    onClose()
  }

  const handleImport = async () => {
    const sourceIds = selectedIds.filter((id) => selectable.includes(id))
    if (sourceIds.length === 0 || isImporting) return
    setIsImporting(true)
    setImportError(null)
    try {
      const result = await importCcSwitch(sourceIds)
      addToast({
        type: result.imported.length > 0 ? 'success' : 'warning',
        message: t('settings.providers.ccSwitch.importedSummary', {
          imported: result.imported.length,
          skipped: result.skipped.length,
        }),
      })
      onClose()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsImporting(false)
    }
  }

  const configDirLine = scan?.configDir
    ? (
      <p className="break-all font-mono text-[11px] text-[var(--color-text-tertiary)]">
        {t('settings.providers.ccSwitch.configDir', { path: scan.configDir })}
      </p>
    )
    : null

  const renderBody = () => {
    if (isScanning) {
      return <LoadingState label={t('settings.providers.ccSwitch.scanning')} />
    }

    if (scanError) {
      return (
        <ErrorState
          title={t('settings.providers.ccSwitch.scanFailed')}
          detail={scanError}
          onRetry={() => void runScan()}
          retryLabel={t('common.retry')}
        />
      )
    }

    if (!scan) return null

    if (!scan.available) {
      return (
        <div className="flex flex-col items-center gap-2">
          <EmptyState
            className="w-full"
            icon={<FolderX size={20} strokeWidth={1.75} aria-hidden="true" />}
            title={t('settings.providers.ccSwitch.unavailableTitle')}
            description={t(UNAVAILABLE_KEYS[scan.reason ?? 'not-found'])}
            action={{ label: t('common.retry'), onClick: () => void runScan() }}
          />
          {configDirLine}
        </div>
      )
    }

    if (candidates.length === 0) {
      return (
        <div className="flex flex-col items-center gap-2">
          <EmptyState
            className="w-full"
            icon={<Inbox size={20} strokeWidth={1.75} aria-hidden="true" />}
            title={t('settings.providers.ccSwitch.emptyTitle')}
            description={t('settings.providers.ccSwitch.emptyDesc')}
            action={{ label: t('common.retry'), onClick: () => void runScan() }}
          />
          {configDirLine}
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">
          {t('settings.providers.ccSwitch.description')}
        </p>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--color-text-tertiary)]">
            {t('settings.providers.ccSwitch.selectedCount', {
              selected: selectedCount,
              total: selectable.length,
            })}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(selectable)}>
              {t('settings.providers.ccSwitch.selectAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
              {t('settings.providers.ccSwitch.selectNone')}
            </Button>
          </div>
        </div>

        <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
          {candidates.map((candidate) => (
            <li
              key={candidate.sourceId}
              data-testid={`cc-switch-candidate-${candidate.sourceId}`}
              className={cx(
                'px-3.5 py-3',
                !candidate.importable && 'opacity-60',
              )}
            >
              <Checkbox
                checked={selectedIds.includes(candidate.sourceId)}
                disabled={!candidate.importable}
                onChange={(event) => toggleCandidate(candidate.sourceId, event.target.checked)}
                label={(
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-[var(--color-text-primary)]">{candidate.name}</span>
                    <Badge tone="neutral">{t(APP_TYPE_KEYS[candidate.appType])}</Badge>
                    {candidate.isCurrent && (
                      <Badge tone="brand" bordered>{t('settings.providers.ccSwitch.currentBadge')}</Badge>
                    )}
                    {candidate.duplicate && (
                      <Badge tone="warning">{t('settings.providers.ccSwitch.duplicateBadge')}</Badge>
                    )}
                  </span>
                )}
                description={(
                  <span className="flex flex-col gap-0.5">
                    <span className="break-all font-mono text-[11px]">{candidate.baseUrl}</span>
                    <span className="break-all font-mono text-[11px]">{candidate.models.main}</span>
                    <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">
                      {candidate.apiKeyPreview}
                    </span>
                    {candidate.duplicate && (
                      <span>
                        {t('settings.providers.ccSwitch.duplicateHint', { name: candidate.duplicate.name })}
                      </span>
                    )}
                    {!candidate.importable && (
                      <span className="text-[var(--color-error)]">
                        {t(candidate.skipReason
                          ? SKIP_KEYS[candidate.skipReason]
                          : 'settings.providers.ccSwitch.skipUnknown')}
                      </span>
                    )}
                  </span>
                )}
              />
            </li>
          ))}
        </ul>

        {importError && (
          <ErrorState
            size="sm"
            title={t('settings.providers.ccSwitch.importFailed')}
            detail={importError}
          />
        )}

        {configDirLine}
      </div>
    )
  }

  const canImport = Boolean(scan?.available) && candidates.length > 0

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('settings.providers.ccSwitch.title')}
      width={640}
      footer={(
        <>
          <Button variant="secondary" onClick={handleClose} disabled={isImporting}>
            {t('common.cancel')}
          </Button>
          {canImport && (
            <Button
              onClick={handleImport}
              disabled={selectedCount === 0 || isImporting}
              loading={isImporting}
            >
              {t('settings.providers.ccSwitch.importAction', { count: selectedCount })}
            </Button>
          )}
        </>
      )}
    >
      {renderBody()}
    </Modal>
  )
}
