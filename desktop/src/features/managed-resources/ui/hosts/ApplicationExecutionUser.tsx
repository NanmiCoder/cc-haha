import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useTranslation } from '@/i18n'
import { ExecutionUserSchema } from '../../api/hostToolsApi'

export function ApplicationExecutionUser({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (value: string) => Promise<boolean> }) {
  const t = useTranslation()
  const [draft, setDraft] = useState(value)
  const id = useId()
  useEffect(() => setDraft(value), [value])
  const normalized = draft.trim()
  const valid = ExecutionUserSchema.safeParse(normalized).success
  return <div className="mb-2 shrink-0 space-y-1" data-testid="application-execution-user">
    <label htmlFor={id} className="text-xs text-[var(--color-text-secondary)]">{t('managedResources.hostTools.executionUser')}</label>
    <div className="flex min-w-0 items-center gap-1">
      <Input id={id} size="sm" maxLength={64} value={draft} placeholder={t('managedResources.hostTools.currentUser')} containerClassName="min-w-0 flex-1"
        disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault() }} />
      <Button size="xs" variant="secondary" disabled={disabled || !valid || normalized === value} onClick={() => void onSave(normalized)}>{t('common.save')}</Button>
    </div>
    <p className="text-[10px] text-[var(--color-text-tertiary)]">{t('managedResources.hostTools.executionHelp')}</p>
    {!valid && <p role="alert" className="text-xs text-[var(--color-error)]">{t('managedResources.hostTools.invalidUser')}</p>}
  </div>
}
