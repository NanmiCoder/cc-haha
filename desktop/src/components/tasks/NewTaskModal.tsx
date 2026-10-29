import { TextArea } from '@/components/ui/TextArea'
import { dateTimeInZone, zonedDateTimeToIso, formatTaskDate } from '@/lib/scheduledTask'
import { reconcileRuntimeSelection, resolveDefaultRuntimeSelection } from '@/lib/runtimeSelection'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useState, useEffect } from 'react'
import { Clock, Info, TriangleAlert } from 'lucide-react'
import { useTaskStore } from '../../stores/taskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useAdapterStore } from '../../stores/adapterStore'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { FIELD_BASE_CLASSES, FIELD_SIZE_CLASSES, Input, fieldStateClasses } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { Button } from '@/components/ui/Button'
import { PromptEditor } from './PromptEditor'
import { DayOfWeekPicker } from './DayOfWeekPicker'
import { useTranslation } from '../../i18n'
import { buildCron, describeCron, isValidCron, parseCron, type FrequencyKey } from '@/lib/cronDescribe'
import { getSessionSeedWorkDir } from '../../lib/sessionWorkspace'
import type { CronTask, TaskNotificationPolicy } from '../../types/task'

type NotificationChannel = 'desktop' | 'telegram' | 'feishu'

type Props = {
  open: boolean
  onClose: () => void
  editTask?: CronTask
}

const MINUTE_INTERVALS = [5, 10, 15, 20, 30]
const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12]
const MINUTE_OFFSETS = [0, 15, 30, 45]

export function NewTaskModal({ open, onClose, editTask }: Props) {
  const t = useTranslation()
  const { createTask, updateTask } = useTaskStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const defaultWorkDir = getSessionSeedWorkDir(activeSession) || ''
  const adapterConfig = useAdapterStore((s) => s.config)
  const fetchAdapterConfig = useAdapterStore((s) => s.fetchConfig)

  useEffect(() => {
    if (open) fetchAdapterConfig()
  }, [open])

  const isFeishuConfigured = !!(adapterConfig.feishu?.appId && adapterConfig.feishu?.appSecret
    && ((adapterConfig.feishu?.pairedUsers?.length ?? 0) > 0 || (adapterConfig.feishu?.allowedUsers?.length ?? 0) > 0))
  const isTelegramConfigured = !!(adapterConfig.telegram?.botToken
    && ((adapterConfig.telegram?.pairedUsers?.length ?? 0) > 0 || (adapterConfig.telegram?.allowedUsers?.length ?? 0) > 0))

  const isEdit = !!editTask
  const parsed = editTask ? parseCron(editTask.cron) : null

  const FREQUENCY_OPTIONS: Array<{ value: FrequencyKey | 'once'; label: string }> = [
    { value: 'once', label: t('scheduledChat.once') },
    { value: 'everyNMinutes', label: t('newTask.everyNMinutes') },
    { value: 'everyNHours',   label: t('newTask.everyNHours') },
    { value: 'daily',         label: t('newTask.daily') },
    { value: 'weekdays',      label: t('newTask.weekdays') },
    { value: 'specificDays',  label: t('newTask.specificDays') },
    { value: 'monthly',       label: t('newTask.monthly') },
    { value: 'customCron',    label: t('newTask.customCron') },
  ]

  const [name, setName] = useState(editTask?.name || '')
  const [description, setDescription] = useState(editTask?.description || '')
  const [prompt, setPrompt] = useState(editTask?.prompt || '')
  const [frequency, setFrequency] = useState<FrequencyKey | 'once'>(editTask?.schedule?.kind === 'once' ? 'once' : parsed?.frequency || 'daily')
  const [time, setTime] = useState(parsed?.time || '09:00')
  const [initialRuntime] = useState(() => ({
    model: editTask?.model || '',
    providerId: editTask?.providerId,
    // A source-inherited task must never pick up the unrelated active chat.
    // Display the source directory when available, but keep inheritance until edited.
    folderPath: editTask?.folderPath || (editTask?.sourceSessionId
      ? sessions.find(session => session.id === editTask.sourceSessionId)?.workDir || ''
      : defaultWorkDir),
  }))
  const [model, setModel] = useState(initialRuntime.model)
  const [providerId, setProviderId] = useState<string | null | undefined>(initialRuntime.providerId)
  const [folderPath, setFolderPath] = useState(initialRuntime.folderPath)
  const [useWorktree, setUseWorktree] = useState(editTask?.useWorktree || false)
  const [notifyEnabled, setNotifyEnabled] = useState(editTask?.notification?.enabled || false)
  const [notifyChannels, setNotifyChannels] = useState<NotificationChannel[]>(editTask?.notification?.channels || [])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [revision] = useState(editTask?.revision)
  const [timeZone, setTimeZone] = useState(editTask?.schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [runAt, setRunAt] = useState(() => editTask?.schedule?.kind === 'once' ? dateTimeInZone(editTask.schedule.runAt, editTask.schedule.timeZone) : '')
  const [executionMode, setExecutionMode] = useState<'legacy' | 'session' | 'new-session'>(editTask ? editTask.execution?.kind ?? 'legacy' : 'new-session')
  const [targetSessionId, setTargetSessionId] = useState(editTask?.execution?.kind === 'session' ? editTask.execution.targetSessionId : activeSessionId ?? '')
  const [notificationPolicy, setNotificationPolicy] = useState<TaskNotificationPolicy>(editTask?.notificationPolicy ?? 'all')
  const runAtIso = frequency === 'once'
    ? editTask?.schedule?.kind === 'once' && timeZone === editTask.schedule.timeZone && runAt === dateTimeInZone(editTask.schedule.runAt, timeZone)
      ? editTask.schedule.runAt
      : zonedDateTimeToIso(runAt, timeZone)
    : null
  let zoneValid = true
  try { new Intl.DateTimeFormat(undefined, { timeZone }).format() } catch { zoneValid = false }
  const onceValid = !!runAtIso && (Date.parse(runAtIso) > Date.now() || (editTask?.schedule?.kind === 'once' && editTask.schedule.runAt === runAtIso))

  // Enhanced scheduling state
  const [minuteInterval, setMinuteInterval] = useState(parsed?.minuteInterval || 15)
  const [hourInterval, setHourInterval] = useState(parsed?.hourInterval || 1)
  const [minuteOffset, setMinuteOffset] = useState(parsed?.minuteOffset || 0)
  const [selectedDays, setSelectedDays] = useState<number[]>(parsed?.selectedDays || [1])
  const [monthDay, setMonthDay] = useState(parsed?.monthDay || 1)
  const [customCron, setCustomCron] = useState(parsed?.customCron || '0 9 * * *')

  const showTime = ['daily', 'weekdays', 'specificDays', 'monthly'].includes(frequency)

  const cronValue = buildCron(frequency === 'once' ? 'daily' : frequency, time, {
    minuteInterval, hourInterval, minuteOffset, selectedDays, monthDay, customCron,
  })

  const needsWorkspace = executionMode === 'new-session' && !editTask?.sourceSessionId && !folderPath.trim()
  const canSubmit =
    name.trim() &&
    prompt.trim() &&
    zoneValid &&
    !needsWorkspace &&
    (frequency !== 'once' || onceValid) &&
    (executionMode !== 'session' || !!targetSessionId) &&
    (frequency !== 'customCron' || isValidCron(customCron)) &&
    (frequency !== 'specificDays' || selectedDays.length > 0) &&
    (!notifyEnabled || notifyChannels.length > 0)

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      // Match the selector's visible default even if it was never opened. Only
      // standalone creations/conversions snapshot it; source edits keep inheritance.
      const needsStandaloneRuntime = executionMode === 'new-session' && (
        !editTask || (editTask.execution?.kind === 'session' && !editTask.sourceSessionId)
      )
      const providers = useProviderStore.getState()
      const settings = useSettingsStore.getState()
      const defaultRuntime = needsStandaloneRuntime && !model
        ? reconcileRuntimeSelection(resolveDefaultRuntimeSelection(
          providers.activeId, settings.activeProviderName, providers.providers, settings.currentModel?.id,
        ), {
          providers: providers.providers, activeId: providers.activeId, hasLoadedProviders: providers.hasLoadedProviders,
          currentModelId: settings.currentModel?.id, defaultEffortLevel: settings.effortLevel,
        })
        : undefined
      const schedule = frequency === 'once'
        ? { kind: 'once' as const, runAt: runAtIso!, timeZone }
        : { kind: 'cron' as const, expression: cronValue, timeZone }
      const scheduleChanged = !editTask || !editTask.schedule ||
        editTask.schedule.kind !== schedule.kind || editTask.schedule.timeZone !== schedule.timeZone ||
        (schedule.kind === 'once' && editTask.schedule.kind === 'once' && schedule.runAt !== editTask.schedule.runAt) ||
        (schedule.kind === 'cron' && editTask.schedule.kind === 'cron' && schedule.expression !== editTask.schedule.expression)
      const payload = {
        name: name.trim(),
        description: description.trim(),
        ...(!editTask || (frequency !== 'once' && cronValue !== editTask.cron) ? { cron: cronValue } : {}),
        prompt: prompt.trim(),
        ...(executionMode !== 'session' ? {
          ...(!editTask || needsStandaloneRuntime || model !== initialRuntime.model || providerId !== initialRuntime.providerId
            ? { model: model || defaultRuntime?.modelId || undefined, providerId: providerId === undefined ? defaultRuntime?.providerId : providerId }
            : {}),
          permissionMode: 'bypassPermissions',
          ...(!editTask || needsStandaloneRuntime || folderPath !== initialRuntime.folderPath
            ? { folderPath: folderPath.trim() || undefined }
            : {}),
          useWorktree: useWorktree || undefined,
        } : {}),
        ...(executionMode === 'legacy' ? {} : { execution: executionMode === 'session' ? { kind: 'session' as const, targetSessionId } : { kind: 'new-session' as const } }),
        ...(!scheduleChanged || (executionMode === 'legacy' && !editTask?.schedule && frequency !== 'once') ? {} : {
          schedule,
          recurring: frequency !== 'once',
        }),
        ...(revision !== undefined ? { revision } : {}),
        notificationPolicy: notifyEnabled ? notificationPolicy : 'none',
        notification: notifyEnabled && notifyChannels.length > 0
          ? { enabled: true, channels: notifyChannels }
          : { enabled: false, channels: [] as NotificationChannel[] },
      }
      if (isEdit) {
        await updateTask(editTask!.id, payload)
      } else {
        await createTask({ ...payload, cron: cronValue, enabled: true, recurring: frequency !== 'once' })
      }
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const cronPreview = frequency === 'once' ? `${t('scheduledChat.once')} · ${runAtIso ? formatTaskDate(runAtIso, timeZone) : t('scheduledChat.runAt')}` : frequency === 'customCron' && customCron.trim() && !isValidCron(customCron)
    ? t('newTask.invalidCron')
    : describeCron(cronValue, t)

  return (
    <Modal
      open={open}
      onClose={onClose}
      // 760px, per the handoff: the prompt editor's embedded toolbar puts a
      // permission chip, a folder chip and a model picker on one line, which
      // wraps into three rows at the 560px default.
      width={760}
      title={isEdit ? t('tasks.editTitle') : t('newTask.title')}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-4">
          {/* The human-readable schedule reads as the sentence the buttons are
              about to commit to, so it sits with them rather than in the body. */}
          <Clock size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="min-w-0 text-[13px] text-[var(--color-text-secondary)]">{cronPreview}</span>
          <div className="ml-auto flex shrink-0 gap-2">
            {editTask ? <Button variant="secondary" size="base" disabled={isSubmitting} onClick={async () => {
              setIsSubmitting(true)
              setSubmitError(null)
              try { await updateTask(editTask.id, { enabled: editTask.enabled === false, ...(editTask.revision === undefined ? {} : { revision: editTask.revision }) }); onClose() }
              catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)) }
              finally { setIsSubmitting(false) }
            }}>{editTask.enabled === false ? t('scheduledChat.resume') : t('scheduledChat.pause')}</Button> : null}
            <Button variant="secondary" size="base" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="base" onClick={handleSubmit} disabled={!canSubmit} loading={isSubmitting}>
              {isEdit ? t('tasks.saveChanges') : t('newTask.create')}
            </Button>
          </div>
        </div>
      }
    >
      {/* Info banner — the same light info strip the page uses for its
          desktop-online notice. */}
      <div className="mb-5 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-info-container)] px-3 py-2 text-[13px] leading-[1.5] text-[var(--color-on-info-container)]">
        <Info size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span>{t('newTask.localWarning')}</span>
      </div>

      <div className="flex flex-col gap-4">
        {submitError ? <p role="alert" className="text-[13px] text-[var(--color-error)]">{submitError}</p> : null}
        <Input
          label={t('newTask.name')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('newTask.namePlaceholder')}
        />

        <Input
          label={t('newTask.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('newTask.descPlaceholder')}
        />

        <SelectField
          label={t('scheduledChat.execution')}
          value={executionMode}
          onChange={setExecutionMode}
          options={[
            ...(isEdit && !editTask.execution ? [{ value: 'legacy' as const, label: t('scheduledChat.legacy') }] : []),
            { value: 'session' as const, label: t('scheduledChat.session') },
            { value: 'new-session' as const, label: t('scheduledChat.newChat') },
          ]}
        />
        {executionMode === 'session' ? <>
          <SelectField label={t('scheduledChat.runIn')} value={targetSessionId} onChange={setTargetSessionId} options={[
            { value: '', label: t('scheduledChat.selectSession') },
            ...(!sessions.some(session => session.id === targetSessionId) && targetSessionId ? [{ value: targetSessionId, label: targetSessionId }] : []),
            ...sessions.map(session => ({ value: session.id, label: session.title || t('tabs.untitled') })),
          ]} />
          <p className="text-[12px] text-[var(--color-text-secondary)]">{t('scheduledChat.inherited')}</p>
          <TextArea label={t('scheduledChat.prompt')} placeholder={t('newTask.promptPlaceholder')} value={prompt} onChange={event => setPrompt(event.target.value)} />
        </> : <PromptEditor
          value={prompt}
          onChange={setPrompt}
          placeholder={t('newTask.promptPlaceholder')}
          modelId={model}
          onModelChange={setModel}
          providerId={providerId}
          onProviderIdChange={setProviderId}
          folderPath={folderPath}
          onFolderPathChange={setFolderPath}
          useWorktree={useWorktree}
          onUseWorktreeChange={setUseWorktree}
        />}

        {needsWorkspace ? <p role="alert" className="text-xs text-[var(--color-error)]">{t('scheduledChat.workspaceRequired')}</p> : null}

        {/* Frequency, with the time of day beside it — the handoff pairs
            「每天」and「09:00」on one line because they are one sentence.
            The selects are `SelectField` rather than bare `<select>`: all seven
            native selects in the app shipped nameless, and the hand-rolled
            chevron needed `appearance-none` plus an absolutely positioned icon
            to reproduce what the platform control draws for free. */}
        <div className="flex flex-wrap items-end gap-2.5">
          <SelectField<FrequencyKey | 'once'>
            containerClassName="min-w-[220px] flex-1"
            label={t('newTask.frequency')}
            value={frequency}
            onChange={setFrequency}
            options={FREQUENCY_OPTIONS}
          />

          {/* Time picker — shown for daily, weekdays, specificDays, monthly.
              Named by `aria-label` rather than a visible label: the handoff puts
              one「频率」heading over both controls, and a second caption here
              would break that pairing. Same treatment `SelectField` gives its
              own `labelHidden` fields. */}
          {showTime && (
            <input
              type="time"
              aria-label={t('newTask.time')}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              // The shared field classes, so this sits flush with the
              // `SelectField` beside it in height, corner and focus ring.
              className={`${FIELD_BASE_CLASSES} ${FIELD_SIZE_CLASSES.lg} ${fieldStateClasses(false)} w-40 font-mono tabular-nums`}
            />
          )}
        </div>

        <Input label={t('scheduledChat.zone')} value={timeZone} onChange={event => setTimeZone(event.target.value)} error={!zoneValid ? t('scheduledChat.invalidTime') : undefined} />
        {frequency === 'once' ? <Input type="datetime-local" label={t('scheduledChat.runAt')} value={runAt} onChange={event => setRunAt(event.target.value)} error={runAt && !onceValid ? t('scheduledChat.invalidTime') : undefined} /> : null}

        {/* Sub-controls based on frequency */}
        {frequency === 'everyNMinutes' && (
          <SelectField
            label={t('newTask.everyNMinutes')}
            labelHidden
            value={String(minuteInterval)}
            onChange={(value) => setMinuteInterval(Number(value))}
            options={MINUTE_INTERVALS.map((n) => ({ value: String(n), label: t('newTask.intervalMinutes', { n }) }))}
          />
        )}

        {frequency === 'everyNHours' && (
          <div className="flex gap-2.5">
            <SelectField
              containerClassName="flex-1"
              label={t('newTask.everyNHours')}
              labelHidden
              value={String(hourInterval)}
              onChange={(value) => setHourInterval(Number(value))}
              options={HOUR_INTERVALS.map((n) => ({ value: String(n), label: t('newTask.intervalHours', { n }) }))}
            />
            <SelectField
              containerClassName="flex-1"
              label={t('newTask.atMinute', { m: '00' })}
              labelHidden
              value={String(minuteOffset)}
              onChange={(value) => setMinuteOffset(Number(value))}
              options={MINUTE_OFFSETS.map((m) => ({
                value: String(m),
                label: t('newTask.atMinute', { m: m.toString().padStart(2, '0') }),
              }))}
            />
          </div>
        )}

        {frequency === 'specificDays' && (
          <DayOfWeekPicker selected={selectedDays} onChange={setSelectedDays} />
        )}

        {frequency === 'monthly' && (
          <SelectField
            label={t('newTask.monthly')}
            labelHidden
            value={String(monthDay)}
            onChange={(value) => setMonthDay(Number(value))}
            options={Array.from({ length: 28 }, (_, i) => i + 1).map((d) => ({
              value: String(d),
              label: t('newTask.onMonthDay', { d }),
            }))}
          />
        )}

        {frequency === 'customCron' && (
          <Input
            aria-label={t('newTask.customCron')}
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder={t('newTask.cronFormatHint')}
            className="font-mono"
            hint={t('newTask.cronFormatHint')}
            // `error` gives the message `role="alert"` and points the field's
            // `aria-describedby` at it; the loose span it replaces was never
            // announced.
            error={customCron.trim() && !isValidCron(customCron) ? t('newTask.invalidCron') : undefined}
          />
        )}

        {/* Notification. The three hand-rolled checkboxes here were part of the
            19 across the app that varied in size, accent token and how the
            label was associated; `Checkbox` also carries the disabled styling
            the channel rows were spelling out by hand. */}
        <Card radius="lg" surface="lowest" padding="none" className="flex flex-col gap-3 px-4 py-3.5">
          <Checkbox
            label={t('newTask.notifyOnComplete')}
            description={t('newTask.notifyHint')}
            checked={notifyEnabled}
            onChange={(e) => {
              setNotifyEnabled(e.target.checked)
              if (e.target.checked && notifyChannels.length === 0) {
                setNotifyChannels(['desktop'])
              }
            }}
          />
          {notifyEnabled && (
            <div className="flex flex-col gap-2 pl-6">
              <SelectField<TaskNotificationPolicy> label={t('scheduledChat.policy')} value={notificationPolicy} onChange={setNotificationPolicy} options={[
                { value: 'important', label: t('scheduledChat.important') },
                { value: 'all', label: t('scheduledChat.all') },
                { value: 'failed', label: t('scheduledChat.failed') },
                { value: 'none', label: t('scheduledChat.none') },
              ]} />
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox
                  size="sm"
                  label={t('newTask.notifyDesktop')}
                  checked={notifyChannels.includes('desktop')}
                  onChange={(e) => {
                    setNotifyChannels((prev) =>
                      e.target.checked ? [...prev, 'desktop'] : prev.filter((c) => c !== 'desktop'),
                    )
                  }}
                />
                <Checkbox
                  size="sm"
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {t('settings.adapters.feishu')}
                      {!isFeishuConfigured && <Badge tone="warning">{t('newTask.notConfigured')}</Badge>}
                    </span>
                  }
                  checked={notifyChannels.includes('feishu')}
                  disabled={!isFeishuConfigured}
                  onChange={(e) => {
                    setNotifyChannels((prev) =>
                      e.target.checked ? [...prev, 'feishu'] : prev.filter((c) => c !== 'feishu'),
                    )
                  }}
                />
                <Checkbox
                  size="sm"
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {t('settings.adapters.telegram')}
                      {!isTelegramConfigured && <Badge tone="warning">{t('newTask.notConfigured')}</Badge>}
                    </span>
                  }
                  checked={notifyChannels.includes('telegram')}
                  disabled={!isTelegramConfigured}
                  onChange={(e) => {
                    setNotifyChannels((prev) =>
                      e.target.checked ? [...prev, 'telegram'] : prev.filter((c) => c !== 'telegram'),
                    )
                  }}
                />
              </div>
              {notifyChannels.length === 0 && (
                <Badge
                  tone="warning"
                  size="sm"
                  wrap
                  pill={false}
                  role="alert"
                  icon={<TriangleAlert size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />}
                >
                  {t('newTask.noChannelSelected')}
                </Badge>
              )}
            </div>
          )}
        </Card>
      </div>
    </Modal>
  )
}
