import { useState, useEffect } from 'react'
import { useTaskStore } from '../../stores/taskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useAdapterStore } from '../../stores/adapterStore'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { Button } from '@/components/ui/Button'
import { PromptEditor } from './PromptEditor'
import { DayOfWeekPicker } from './DayOfWeekPicker'
import { useTranslation } from '../../i18n'
import { describeCron, isValidCron, parseCron, type FrequencyKey } from '../../lib/cronDescribe'
import { getSessionSeedWorkDir } from '../../lib/sessionWorkspace'
import type { CronTask } from '../../types/task'

type NotificationChannel = 'desktop' | 'telegram' | 'feishu'

type Props = {
  open: boolean
  onClose: () => void
  editTask?: CronTask
}

const MINUTE_INTERVALS = [5, 10, 15, 20, 30]
const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12]
const MINUTE_OFFSETS = [0, 15, 30, 45]

function buildCron(
  freq: FrequencyKey,
  time: string,
  opts: {
    minuteInterval: number
    hourInterval: number
    minuteOffset: number
    selectedDays: number[]
    monthDay: number
    customCron: string
  },
): string {
  const [hours, minutes] = time.split(':').map(Number)
  switch (freq) {
    case 'everyNMinutes':
      return `*/${opts.minuteInterval} * * * *`
    case 'everyNHours':
      return `${opts.minuteOffset} */${opts.hourInterval} * * *`
    case 'daily':
      return `${minutes} ${hours} * * *`
    case 'weekdays':
      return `${minutes} ${hours} * * 1-5`
    case 'specificDays':
      return `${minutes} ${hours} * * ${[...opts.selectedDays].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${minutes} ${hours} ${opts.monthDay} * *`
    case 'customCron':
      return opts.customCron.trim()
  }
}

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

  const FREQUENCY_OPTIONS: Array<{ value: FrequencyKey; label: string }> = [
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
  const [frequency, setFrequency] = useState<FrequencyKey>(parsed?.frequency || 'daily')
  const [time, setTime] = useState(parsed?.time || '09:00')
  const [model, setModel] = useState(editTask?.model || '')
  const [providerId, setProviderId] = useState<string | null | undefined>(editTask?.providerId)
  const [folderPath, setFolderPath] = useState(editTask?.folderPath || defaultWorkDir)
  const [useWorktree, setUseWorktree] = useState(editTask?.useWorktree || false)
  const [notifyEnabled, setNotifyEnabled] = useState(editTask?.notification?.enabled || false)
  const [notifyChannels, setNotifyChannels] = useState<NotificationChannel[]>(editTask?.notification?.channels || [])
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Enhanced scheduling state
  const [minuteInterval, setMinuteInterval] = useState(parsed?.minuteInterval || 15)
  const [hourInterval, setHourInterval] = useState(parsed?.hourInterval || 1)
  const [minuteOffset, setMinuteOffset] = useState(parsed?.minuteOffset || 0)
  const [selectedDays, setSelectedDays] = useState<number[]>(parsed?.selectedDays || [1])
  const [monthDay, setMonthDay] = useState(parsed?.monthDay || 1)
  const [customCron, setCustomCron] = useState(parsed?.customCron || '0 9 * * *')

  const showTime = ['daily', 'weekdays', 'specificDays', 'monthly'].includes(frequency)

  const cronValue = buildCron(frequency, time, {
    minuteInterval, hourInterval, minuteOffset, selectedDays, monthDay, customCron,
  })

  const canSubmit =
    name.trim() &&
    description.trim() &&
    prompt.trim() &&
    (frequency !== 'customCron' || isValidCron(customCron)) &&
    (frequency !== 'specificDays' || selectedDays.length > 0) &&
    (!notifyEnabled || notifyChannels.length > 0)

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        cron: cronValue,
        prompt: prompt.trim(),
        model: model || undefined,
        providerId,
        permissionMode: 'bypassPermissions',
        folderPath: folderPath.trim() || undefined,
        useWorktree: useWorktree || undefined,
        notification: notifyEnabled && notifyChannels.length > 0
          ? { enabled: true, channels: notifyChannels }
          : undefined,
      }
      if (isEdit) {
        await updateTask(editTask!.id, payload)
      } else {
        await createTask({ ...payload, enabled: true, recurring: true })
      }
      onClose()
    } catch (err) {
      console.error(`Failed to ${isEdit ? 'update' : 'create'} task:`, err)
    } finally {
      setIsSubmitting(false)
    }
  }

  const cronPreview = frequency === 'customCron' && customCron.trim() && !isValidCron(customCron)
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
        <div className="flex w-full flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] pt-4">
          {/* The human-readable schedule reads as the sentence the buttons are
              about to commit to, so it sits with them rather than in the body. */}
          <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-secondary)]">schedule</span>
          <span className="min-w-0 text-[13.5px] text-[var(--color-text-secondary)]">{cronPreview}</span>
          <div className="ml-auto flex shrink-0 gap-2.5">
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button onClick={handleSubmit} disabled={!canSubmit} loading={isSubmitting}>
              {isEdit ? t('tasks.saveChanges') : t('newTask.create')}
            </Button>
          </div>
        </div>
      }
    >
      {/* Info banner */}
      <Card radius="md" surface="low" padding="none" className="mb-5 flex items-center gap-2.5 px-[15px] py-[11px]">
        <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-secondary)]">info</span>
        <span className="text-[13.5px] text-[var(--color-text-secondary)]">
          {t('newTask.localWarning')}
        </span>
      </Card>

      <div className="flex flex-col gap-4">
        <Input
          label={t('newTask.name')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('newTask.namePlaceholder')}
        />

        <Input
          label={t('newTask.description')}
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('newTask.descPlaceholder')}
        />

        {/* Prompt editor with embedded controls */}
        <PromptEditor
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
        />

        {/* Frequency, with the time of day beside it — the handoff pairs
            「每天」and「09:00」on one line because they are one sentence.
            The selects are `SelectField` rather than bare `<select>`: all seven
            native selects in the app shipped nameless, and the hand-rolled
            chevron needed `appearance-none` plus an absolutely positioned icon
            to reproduce what the platform control draws for free. */}
        <div className="flex flex-wrap items-end gap-2.5">
          <SelectField<FrequencyKey>
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
              className="h-10 w-40 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 font-mono text-sm tabular-nums text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)]"
            />
          )}
        </div>

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
        <Card radius="lg" padding="none" className="flex flex-col gap-3 px-[18px] py-[15px]">
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
                  bordered
                  pill={false}
                  role="alert"
                  icon={<span aria-hidden="true" className="material-symbols-outlined text-[13px]">warning</span>}
                >
                  {t('newTask.noChannelSelected')}
                </Badge>
              )}
            </div>
          )}
        </Card>

        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('newTask.delayNote')}
        </p>
      </div>
    </Modal>
  )
}
