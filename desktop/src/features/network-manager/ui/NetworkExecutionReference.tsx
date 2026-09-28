import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import type { NetworkExecutionCatalog, NetworkManagerApi, NetworkPlan, NetworkProfile } from '../networkTypes'
import { profileParameterReference, safeReferenceValue, stageEvidenceKey, stageReferenceActions, type ReferenceStage } from '../executionReference'

type Props = {
  api: NetworkManagerApi
  stage: ReferenceStage
  profile: NetworkProfile
  plan?: NetworkPlan | null
  extra?: Record<string, unknown>
}

/** Read-only presentation. Source comes from the backend's compiled fixed script, not editable commands. */
export function NetworkExecutionReference({ api, stage, profile, plan, extra = {} }: Props) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<NetworkExecutionCatalog | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open || catalog) return
    let current = true
    setError(false)
    void api.executionCatalog().then(result => {
      if (!current) return
      if (result.ok) setCatalog(result.data)
      else setError(true)
    }).catch(() => { if (current) setError(true) })
    return () => { current = false }
  }, [api, open, catalog, retry])
  const rows = Object.entries(profileParameterReference).filter(([, entry]) => entry.stage === stage)
  const actionIds = new Set([...stageReferenceActions[stage], ...rows.flatMap(([, entry]) => entry.actions)])
  const titles = { read: 'networkManager.ref.read', probe: 'networkManager.ref.probe', write: 'networkManager.ref.write', launch: 'networkManager.ref.launch', save: 'networkManager.ref.save' } as const
  return <details className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-xs"
    data-testid={`network-reference-${stage}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-2 font-semibold">{t('networkManager.ref.title')}</summary>
    {open && <div className="space-y-3 border-t border-[var(--color-border)] p-3">
      <p className="leading-relaxed text-[var(--color-text-secondary)]">{t('networkManager.ref.disclaimer')}</p>
      {rows.length > 0 && <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left">
          <caption className="sr-only">{t('networkManager.ref.parameters')}</caption>
          <thead><tr><th className="w-[28%] p-2">{t('networkManager.ref.parameters')}</th><th className="w-[42%] p-2">{t('networkManager.ref.value')}</th><th className="p-2">{t('networkManager.ref.actions')}</th></tr></thead>
          <tbody>{rows.map(([key, entry]) => <tr key={key} className="border-t border-[var(--color-border)] align-top">
            <td className="break-words p-2">{t(entry.label)}<code className="mt-1 block break-all text-[10px]">{key}</code></td>
            <td className="whitespace-pre-wrap break-all p-2 font-mono">{safeReferenceValue(profile[key as keyof NetworkProfile]) || t('networkManager.ref.unset')}</td>
            <td className="break-words p-2 font-mono">{entry.actions.join(' · ')}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {Object.keys(extra).length > 0 && <div><h4 className="mb-1 font-semibold">{t('networkManager.ref.derived')}</h4><pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-[var(--color-border)] p-2">{safeReferenceValue(extra)}</pre></div>}
      <p className="leading-relaxed"><strong>{t('networkManager.ref.verify')}: </strong>{t(stageEvidenceKey[stage])}</p>
      {stage === 'plan' && <div>
        <h4 className="mb-1 font-semibold">{t('networkManager.ref.actualPlan')}</h4>
        {plan ? <pre data-testid="network-plan-execution" className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--color-border)] p-2">{safeReferenceValue({ planId: plan.id, expiresAt: plan.expiresAt, canApply: plan.canApply, execution: plan.execution ?? [], changes: plan.changes })}</pre>
          : <p>{t('networkManager.ref.planPending')}</p>}
      </div>}
      {error ? <div role="alert"><p>{t('networkManager.ref.loadError')}</p><Button size="xs" variant="secondary" onClick={() => setRetry(value => value + 1)}>{t('networkManager.ref.retry')}</Button></div>
        : !catalog ? <p>{t('networkManager.loading')}</p> : <>
          <p className="break-words font-mono text-[10px]">{catalog.executor}</p>
          {catalog.actions.filter(action => actionIds.has(action.id)).map(action => <details key={action.id} className="rounded border border-[var(--color-border)] p-2">
            <summary className="cursor-pointer break-words font-mono">{action.id} · {t(titles[action.kind])}</summary>
            <p className="mt-2 break-all">{action.source}</p>
            <p className="my-2 break-all font-mono">{action.functionName}</p>
            {action.script && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-surface)] p-2 text-[11px]">{action.script}</pre>}
          </details>)}
        </>}
    </div>}
  </details>
}
