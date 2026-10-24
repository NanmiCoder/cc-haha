import { useState } from 'react'
import { ExternalLink, MessageCircleQuestion } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { useChatStore } from '@/stores/chatStore'
import { PendingDecisionMarker } from '@/components/chat/PendingDecisionMarker'
import { safeDialogUrl, validElicitationContent, validElicitationValue, type ElicitationField, type OfficialSdkDialog as Dialog } from '../../../../src/shared/officialAgentSdkDialogs'

type Props = { sessionId?: string | null; requestId: string; dialog: Dialog; isPending: boolean; markerWhenPending?: boolean }

export function OfficialSdkDialog({ sessionId, requestId, dialog, isPending, markerWhenPending }: Props) {
  const t = useTranslation()
  const respond = useChatStore(state => state.respondToPermission)
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries((dialog.fields ?? []).flatMap(field => {
    if (field.default !== undefined) return [[field.name, field.default]]
    // Required empty text/multi-select is valid unless the schema sets a minimum.
    const empty = field.type === 'string' && !field.choices ? '' : field.type === 'array' ? [] : undefined
    return field.required && empty !== undefined && validElicitationValue(field, empty) ? [[field.name, empty]] : []
  })))
  const [invalid, setInvalid] = useState(false)
  const [opened, setOpened] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const url = safeDialogUrl(dialog.url)
  const title = dialog.nativeKind === 'refusal_fallback_prompt' ? t('sdkDialog.refusalTitle')
    : dialog.nativeKind === 'fable_overage_consent_prompt' ? t('sdkDialog.creditTitle') : dialog.title || t('sdkDialog.title')
  const credit = dialog.creditConsent
  const balance = typeof credit?.balanceCents === 'number' && credit.currency ? (() => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: credit.currency }).format(credit.balanceCents / 100) }
    catch { return undefined }
  })() : undefined

  function answer(result: Record<string, unknown>) {
    if (sessionId && isPending) respond(sessionId, requestId, true, { updatedInput: { sdkDialogResult: result } })
  }
  async function openPage() {
    if (!url || opening) return
    setOpening(true)
    setOpenFailed(false)
    try { await getDesktopHost().shell.open(url); setOpened(true) }
    catch { setOpenFailed(true) }
    finally { setOpening(false) }
  }
  function submit() {
    const content = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
    if (!dialog.fields || !validElicitationContent(dialog.fields, content)) { setInvalid(true); return }
    answer({ action: 'accept', content })
  }
  function fieldLabel(field: ElicitationField) { return `${field.title}${field.required ? ' *' : ''}` }
  function setField(name: string, value: unknown) { setValues(previous => ({ ...previous, [name]: value })); setInvalid(false) }
  function choiceLabel(value: string, label: string) {
    if (label === 'sdkDialog.retry') return t('sdkDialog.retry')
    if (label === 'sdkDialog.completed') return t('sdkDialog.completed')
    if (label === 'sdkDialog.continue') return t('sdkDialog.continue')
    if (label === 'sdkDialog.interrupt') return t('sdkDialog.interrupt')
    if (label === 'sdkDialog.useCredits') return t('sdkDialog.useCredits')
    if (label === 'sdkDialog.switchDefault') return t('sdkDialog.switchDefault')
    if (label === 'sdkDialog.cancel') return t('sdkDialog.cancel')
    if (label === 'sdkDialog.stop') return t('sdkDialog.interrupt')
    if (label === 'sdkDialog.editPrompt') return t('sdkDialog.editPrompt')
    return value === 'retry_fallback' ? t('sdkDialog.retryFallback', { model: label }) : label
  }

  if (!isPending) return <div role="group" aria-label={title} className="mb-4 flex items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3 text-sm text-[var(--color-text-secondary)]"><MessageCircleQuestion size={16} aria-hidden="true" />{title} · {t('permission.responded')}</div>
  if (markerWhenPending) return <PendingDecisionMarker title={title} />
  return (
    <section aria-label={title} className="mb-4 space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-outline)] bg-[var(--color-surface-container-lowest)] p-4 shadow-[var(--shadow-raised)]">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"><MessageCircleQuestion size={16} aria-hidden="true" />{title}</h3>
      {dialog.serverName && dialog.serverName !== title ? <p className="text-xs text-[var(--color-text-secondary)]">{t('sdkDialog.server', { server: dialog.serverName })}</p> : null}
      {dialog.refusal ? <p className="text-sm text-[var(--color-text-secondary)]">{t('sdkDialog.fallbackMessage', { original: dialog.refusal.originalModel, fallback: dialog.refusal.fallbackModel })}</p> : null}
      {credit ? <div className="space-y-2 text-sm text-[var(--color-text-secondary)]">
        <p>{t('sdkDialog.creditMessage', { model: credit.modelName })}</p>
        {balance ? <p>{t('sdkDialog.creditBalance', { balance })}</p> : null}
        {!credit.overagesEnabled ? <p>{t('sdkDialog.creditDisabled')}</p> : null}
      </div> : null}
      {dialog.message ? <p className="whitespace-pre-wrap break-words text-sm text-[var(--color-text-secondary)]">{dialog.message}</p> : null}
      {dialog.unsupportedSchema ? <p role="alert" className="text-sm text-[var(--color-error)]">{t('sdkDialog.unsupported')}</p> : null}
      {dialog.kind === 'elicitation' && dialog.mode === 'form' && !dialog.unsupportedSchema ? (dialog.fields ?? []).map(field => {
        const label = fieldLabel(field)
        if (field.type === 'array') return <fieldset key={field.name} className="space-y-2"><legend className="text-sm font-medium text-[var(--color-text-primary)]">{label}</legend>
          {field.description ? <p className="text-xs text-[var(--color-text-secondary)]">{field.description}</p> : null}
          {field.choices?.map(choice => <Checkbox key={choice.value} label={choice.label} checked={Array.isArray(values[field.name]) && (values[field.name] as string[]).includes(choice.value)} onChange={event => {
            const selected = Array.isArray(values[field.name]) ? values[field.name] as string[] : []
            setField(field.name, event.target.checked ? [...selected, choice.value] : selected.filter(value => value !== choice.value))
          }} />)}</fieldset>
        if (field.type === 'boolean' || field.choices) return <SelectField key={field.name} label={label} hint={field.description} value={values[field.name] === undefined ? '' : field.type === 'boolean' ? String(values[field.name]) : JSON.stringify(values[field.name])}
          options={[{ value: '', label: t('sdkDialog.select') }, ...(field.type === 'boolean' ? [{ value: 'true', label: t('sdkDialog.yes') }, { value: 'false', label: t('sdkDialog.no') }] : field.choices!.map(choice => ({ value: JSON.stringify(choice.value), label: choice.label })))]}
          onChange={value => setField(field.name, value === '' ? undefined : field.type === 'boolean' ? value === 'true' : JSON.parse(value))} />
        return <Input key={field.name} label={field.title} required={field.required} hint={field.description} autoComplete="off" value={values[field.name] === undefined ? '' : String(values[field.name])}
          type={field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'date' ? 'date' : 'text'}
          min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} step={field.type === 'integer' ? 1 : 'any'}
          onChange={event => setField(field.name, field.type === 'number' || field.type === 'integer' ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value)} />
      }) : null}
      {url ? <div className="space-y-2"><p className="break-all font-mono text-xs text-[var(--color-text-secondary)]">{url}</p>
        {dialog.mode === 'url' ? <p className="text-xs text-[var(--color-text-secondary)]">{t('sdkDialog.urlHint')}</p> : null}
        <Button variant="secondary" disabled={opening} icon={<ExternalLink size={14} aria-hidden="true" />} onClick={() => { void openPage() }}>{t('sdkDialog.openUrl')}</Button></div> : null}
      {invalid ? <p role="alert" className="text-sm text-[var(--color-error)]">{t('sdkDialog.invalid')}</p> : null}
      {openFailed ? <p role="alert" className="text-sm text-[var(--color-error)]">{t('sdkDialog.openFailed')}</p> : null}
      <div className="flex flex-wrap gap-2">
        {dialog.kind === 'choice' ? dialog.choices?.map(choice => <Button key={choice.value} variant="secondary" onClick={() => answer({ choice: choice.value })}>{choiceLabel(choice.value, choice.label)}</Button>)
          : <Button variant="primary" disabled={dialog.unsupportedSchema || dialog.mode === 'url' && !opened} onClick={() => dialog.mode === 'url' ? answer({ action: 'accept', openedUrl: url }) : submit()}>{dialog.mode === 'url' ? t('sdkDialog.completed') : t('sdkDialog.submit')}</Button>}
        {dialog.kind === 'elicitation' ? <Button variant="secondary" onClick={() => answer({ action: 'decline' })}>{t('sdkDialog.decline')}</Button> : null}
        {!dialog.choices?.some(choice => choice.value === 'cancelled') ? <Button variant="ghost" onClick={() => answer({ action: 'cancel' })}>{t('sdkDialog.cancel')}</Button> : null}
      </div>
    </section>
  )
}
