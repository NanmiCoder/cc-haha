import { useEffect, useMemo, useState } from 'react'
import { Network } from 'lucide-react'
import { workflowsApi } from '../../api/workflows'
import { useTranslation } from '../../i18n'
import { runsForSession, useWorkflowStore } from '../../stores/workflowStore'
import type { WorkflowRunDetail } from '../../types/workflow'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SelectField } from '@/components/ui/SelectField'
import {
  getSlashCommandNameConflict,
  type SlashCommandOption,
} from './composerUtils'
import { SlashCommandPanelShell } from './SlashCommandPanelShell'

type WorkflowSaveScope = 'project' | 'user'

export function WorkflowSavePanel({
  sessionId,
  cwd,
  commands = [],
  onClose,
}: {
  sessionId?: string
  cwd?: string
  commands?: ReadonlyArray<SlashCommandOption>
  onClose: () => void
}) {
  const t = useTranslation()
  const runs = useWorkflowStore(state => state.runs)
  const completedRuns = useMemo(
    () =>
      sessionId
        ? runsForSession({ runs }, sessionId).filter(
            run => run.status === 'completed' && Boolean(run.runId),
          )
        : [],
    [runs, sessionId],
  )
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<WorkflowSaveScope>('project')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [savedNames, setSavedNames] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [loadAttempt, setLoadAttempt] = useState(0)

  const selectedRun =
    completedRuns.find(run => run.taskId === selectedTaskId) ?? completedRuns[0]

  useEffect(() => {
    if (!selectedRun || !sessionId || !selectedRun.runId) {
      setDetail(null)
      setName('')
      setLoading(false)
      setError(null)
      return
    }
    if (selectedTaskId !== selectedRun.taskId) {
      setSelectedTaskId(selectedRun.taskId)
    }

    let cancelled = false
    setLoading(true)
    setDetail(null)
    setError(null)
    setSavedName(null)
    void workflowsApi
      .getRun(sessionId, selectedRun.runId)
      .then(run => {
        if (cancelled) return
        setDetail(run)
        setName(run.workflowName)
      })
      .catch(cause => {
        if (!cancelled) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedRun?.runId, selectedRun?.taskId, sessionId, loadAttempt])

  const normalizedName = name.trim()
  const validName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(normalizedName)
  const normalizedNameKey = normalizedName.toLowerCase()
  const isCurrentSuccess =
    savedName?.toLowerCase() === normalizedNameKey
  const nameConflict = validName && !isCurrentSuccess
    ? getSlashCommandNameConflict(normalizedName, commands) ??
      (savedNames.has(normalizedNameKey) ? 'existing' : null)
    : null
  const nameError = name === ''
    ? undefined
    : !validName
      ? t('slash.saveWorkflow.invalidName')
      : nameConflict === 'reserved'
        ? t('slash.saveWorkflow.reservedName', { name: normalizedName })
        : nameConflict === 'existing'
          ? t('slash.saveWorkflow.existingName', { name: normalizedName })
          : undefined

  async function save() {
    if (!detail || !validName || nameConflict) return
    setSaving(true)
    setError(null)
    setSavedName(null)
    try {
      const saved = await workflowsApi.save(
        detail.script,
        scope,
        cwd,
        normalizedName,
      )
      setSavedNames(current => new Set(current).add(saved.name.toLowerCase()))
      setSavedName(saved.name)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SlashCommandPanelShell
      title={t('slash.saveWorkflow.title')}
      subtitle={t('slash.saveWorkflow.subtitle')}
      onClose={onClose}
    >
      {completedRuns.length === 0 ? (
        <EmptyState
          icon={<Network size={20} strokeWidth={1.75} aria-hidden="true" />}
          description={t('slash.saveWorkflow.noCompletedRun')}
        />
      ) : (
        <div className="space-y-4">
          <SelectField
            label={t('slash.saveWorkflow.runLabel')}
            value={selectedRun?.taskId ?? ''}
            onChange={setSelectedTaskId}
            disabled={saving}
            options={completedRuns.map(run => ({
              value: run.taskId,
              label: run.workflowName,
            }))}
          />
          {loading ? (
            <LoadingState label={t('slash.saveWorkflow.loading')} />
          ) : !detail ? (
            <ErrorState
              title={t('slash.saveWorkflow.error', {
                detail: error ?? t('slash.saveWorkflow.loading'),
              })}
              onRetry={() => setLoadAttempt(attempt => attempt + 1)}
              retryLabel={t('slash.saveWorkflow.retry')}
            />
          ) : (
            <>
              <Input
                label={t('slash.saveWorkflow.nameLabel')}
                value={name}
                placeholder={t('slash.saveWorkflow.namePlaceholder')}
                error={nameError}
                disabled={saving}
                onChange={event => {
                  setName(event.target.value)
                  setSavedName(null)
                }}
              />
              <SelectField
                label={t('slash.saveWorkflow.scopeLabel')}
                value={scope}
                disabled={saving}
                onChange={value => {
                  setScope(value)
                  setSavedName(null)
                }}
                options={[
                  { value: 'project', label: t('slash.saveWorkflow.scopeProject') },
                  { value: 'user', label: t('slash.saveWorkflow.scopeUser') },
                ]}
              />
              {error && (
                <p role="alert" className="text-[13px] text-[var(--color-error)]">
                  {t('slash.saveWorkflow.error', { detail: error })}
                </p>
              )}
              {savedName && (
                <p role="status" className="text-[13px] text-[var(--color-success)]">
                  {t('slash.saveWorkflow.success', { name: savedName })}
                </p>
              )}
              <Button
                type="button"
                variant="primary"
                block
                loading={saving}
                disabled={!validName || Boolean(nameConflict) || saving}
                onClick={() => void save()}
              >
                {t('slash.saveWorkflow.save')}
              </Button>
            </>
          )}
        </div>
      )}
    </SlashCommandPanelShell>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
