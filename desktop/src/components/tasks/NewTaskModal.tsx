import { useState, useEffect } from 'react'
import { useTaskStore } from '../../stores/taskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useAdapterStore } from '../../stores/adapterStore'
import { Modal } from '../shared/Modal'
import { Input } from '../shared/Input'
import { Button } from '../shared/Button'
import { PromptEditor } from './PromptEditor'
import { DayOfWeekPicker } from './DayOfWeekPicker'
import { useTranslation } from '../../i18n'
import { describeCron, isValidCron, parseCron, type FrequencyKey } from '../../lib/cronDescribe'
import type { PermissionMode } from '../../types/settings'
import type { CronTask } from '../../types/task'

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
  const defaultWorkDir = activeSession?.workDir || ''
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
  const [permissionMode, setPermissionMode] = useState<PermissionMode>((editTask?.permissionMode as PermissionMode) || 'default')
  const [folderPath, setFolderPath] = useState(editTask?.folderPath || defaultWorkDir)
  const [useWorktree, setUseWorktree] = useState(editTask?.useWorktree || false)
  const [notifyEnabled, setNotifyEnabled] = useState(editTask?.notification?.enabled || false)
  const [notifyChannels, setNotifyChannels] = useState<('telegram' | 'feishu')[]>(editTask?.notification?.channels || [])
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
    (frequency !== 'specificDays' || selectedDays.length > 0)

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
        permissionMode: permissionMode !== 'default' ? permissionMode : undefined,
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

  const selectClass = 'w-full h-10 px-3 pr-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)] appearance-none cursor-pointer'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? t('tasks.editTitle') : t('newTask.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} loading={isSubmitting}>
            {isEdit ? t('tasks.saveChanges') : t('newTask.create')}
          </Button>
        </>
      }
    >
      {/* Info banner */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] mb-5">
        <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">info</span>
        <span className="text-xs text-[var(--color-text-secondary)]">
          {t('newTask.localWarning')}
        </span>
      </div>

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
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          modelId={model}
          onModelChange={setModel}
          folderPath={folderPath}
          onFolderPathChange={setFolderPath}
          useWorktree={useWorktree}
          onUseWorktreeChange={setUseWorktree}
        />

        {/* Frequency */}
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-[var(--color-text-primary)]">{t('newTask.frequency')}</label>
          <div className="relative">
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as FrequencyKey)}
              className={selectClass}
            >
              {FREQUENCY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
              expand_more
            </span>
          </div>
        </div>

        {/* Sub-controls based on frequency */}
        {frequency === 'everyNMinutes' && (
          <div className="relative">
            <select
              value={minuteInterval}
              onChange={(e) => setMinuteInterval(Number(e.target.value))}
              className={selectClass}
            >
              {MINUTE_INTERVALS.map((n) => (
                <option key={n} value={n}>{t('newTask.intervalMinutes', { n })}</option>
              ))}
            </select>
            <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
              expand_more
            </span>
          </div>
        )}

        {frequency === 'everyNHours' && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <select
                value={hourInterval}
                onChange={(e) => setHourInterval(Number(e.target.value))}
                className={selectClass}
              >
                {HOUR_INTERVALS.map((n) => (
                  <option key={n} value={n}>{t('newTask.intervalHours', { n })}</option>
                ))}
              </select>
              <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                expand_more
              </span>
            </div>
            <div className="relative flex-1">
              <select
                value={minuteOffset}
                onChange={(e) => setMinuteOffset(Number(e.target.value))}
                className={selectClass}
              >
                {MINUTE_OFFSETS.map((m) => (
                  <option key={m} value={m}>{t('newTask.atMinute', { m: m.toString().padStart(2, '0') })}</option>
                ))}
              </select>
              <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                expand_more
              </span>
            </div>
          </div>
        )}

        {frequency === 'specificDays' && (
          <DayOfWeekPicker selected={selectedDays} onChange={setSelectedDays} />
        )}

        {frequency === 'monthly' && (
          <div className="relative">
            <select
              value={monthDay}
              onChange={(e) => setMonthDay(Number(e.target.value))}
              className={selectClass}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{t('newTask.onMonthDay', { d })}</option>
              ))}
            </select>
            <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
              expand_more
            </span>
          </div>
        )}

        {frequency === 'customCron' && (
          <div className="flex flex-col gap-1">
            <input
              type="text"
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              placeholder={t('newTask.cronFormatHint')}
              className="w-full h-10 px-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-primary)] font-[var(--font-mono)] outline-none focus:border-[var(--color-border-focus)]"
            />
            <span className="text-xs text-[var(--color-text-tertiary)]">{t('newTask.cronFormatHint')}</span>
            {customCron.trim() && !isValidCron(customCron) && (
              <span className="text-xs text-[var(--color-error)]">{t('newTask.invalidCron')}</span>
            )}
          </div>
        )}

        {/* Time picker — shown for daily, weekdays, specificDays, monthly */}
        {showTime && (
          <div className="flex flex-col gap-1">
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-auto h-10 px-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
              style={{ maxWidth: 120 }}
            />
          </div>
        )}

        {/* Notification */}
        <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={notifyEnabled}
              onChange={(e) => setNotifyEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-border)] accent-[var(--color-brand)]"
            />
            <div>
              <span className="text-sm font-medium text-[var(--color-text-primary)]">{t('newTask.notifyOnComplete')}</span>
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('newTask.notifyHint')}</p>
            </div>
          </label>
          {notifyEnabled && (
            <div className="flex flex-col gap-2 pl-7">
              <div className="flex items-center gap-4">
                <label className={`flex items-center gap-2 ${isFeishuConfigured ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
                  <input
                    type="checkbox"
                    checked={notifyChannels.includes('feishu')}
                    disabled={!isFeishuConfigured}
                    onChange={(e) => {
                      setNotifyChannels((prev) =>
                        e.target.checked ? [...prev, 'feishu'] : prev.filter((c) => c !== 'feishu'),
                      )
                    }}
                    className="w-3.5 h-3.5 rounded border-[var(--color-border)] accent-[var(--color-brand)]"
                  />
                  <span className="text-sm text-[var(--color-text-primary)]">{t('settings.adapters.feishu')}</span>
                  {!isFeishuConfigured && (
                    <span className="text-[10px] text-[var(--color-warning)]">{t('newTask.notConfigured')}</span>
                  )}
                </label>
                <label className={`flex items-center gap-2 ${isTelegramConfigured ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
                  <input
                    type="checkbox"
                    checked={notifyChannels.includes('telegram')}
                    disabled={!isTelegramConfigured}
                    onChange={(e) => {
                      setNotifyChannels((prev) =>
                        e.target.checked ? [...prev, 'telegram'] : prev.filter((c) => c !== 'telegram'),
                      )
                    }}
                    className="w-3.5 h-3.5 rounded border-[var(--color-border)] accent-[var(--color-brand)]"
                  />
                  <span className="text-sm text-[var(--color-text-primary)]">{t('settings.adapters.telegram')}</span>
                  {!isTelegramConfigured && (
                    <span className="text-[10px] text-[var(--color-warning)]">{t('newTask.notConfigured')}</span>
                  )}
                </label>
              </div>
              {!isFeishuConfigured && !isTelegramConfigured && (
                <p className="text-xs text-[var(--color-warning)]">
                  <span className="material-symbols-outlined text-[12px] align-middle mr-1">warning</span>
                  {t('newTask.noChannelConfigured')}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Cron preview */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] text-xs text-[var(--color-text-secondary)]">
          <span className="material-symbols-outlined text-[16px]">schedule</span>
          <span>
            {frequency === 'customCron' && customCron.trim() && !isValidCron(customCron)
              ? t('newTask.invalidCron')
              : describeCron(cronValue, t)
            }
          </span>
        </div>

        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('newTask.delayNote')}
        </p>
      </div>
    </Modal>
  )
}
