import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { getDesktopHost } from '@/lib/desktopHost'
import { useTranslation } from '@/i18n'
import type { ProcessInspection, ProcessKind, ProcessProbe } from '../../api/hostToolsApi'

export type ProcessInspectionTarget = { hostId: string; connectionId: string; generation: number; pid: number; startTime: string; processKind: ProcessKind; probe: ProcessProbe }

export function ProcessInspectionModal({ target, onClose }: { target: ProcessInspectionTarget; onClose: () => void }) {
  const t = useTranslation()
  const tabId = useId()
  const probes: ProcessProbe[] = ['top', 'ports', 'connections']
  const navigateTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'))
    const current = tabs.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    tabs[next]?.focus()
    setProbe(probes[next]!)
  }
  const [probe, setProbe] = useState(target.probe)
  const [nonce, setNonce] = useState(0)
  const [result, setResult] = useState<ProcessInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let alive = true
    let requestId: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const api = getDesktopHost().hostManagement
    setResult(null); setError(null)
    const load = async () => {
      const id = crypto.randomUUID()
      requestId = id; setLoading(true)
      let retry = true
      try {
        const reply = await api.hostTools({ action: 'inspectProcess', ...target, probe, requestId: id })
        if (!alive) return
        if (!reply.ok) throw new Error(reply.error.code)
        if (reply.data.kind !== 'processInspection' || reply.data.pid !== target.pid || reply.data.probe !== probe || reply.data.processKind !== target.processKind) throw new Error('PROCESS_RESPONSE_INVALID')
        setResult(reply.data); setError(null)
      } catch (failure) {
        if (!alive) return
        const code = failure instanceof Error ? failure.message : 'PROCESS_QUERY_FAILED'
        setResult(null); setError(code)
        retry = !['PROCESS_CHANGED', 'PROCESS_EXITED', 'DISCONNECTED', 'STALE_GENERATION', 'PROCESS_PERMISSION_DENIED', 'PROCESS_TOOL_UNAVAILABLE', 'PROCESS_NAMESPACE_UNAVAILABLE'].includes(code)
      } finally {
        if (requestId === id) requestId = null
        if (alive) { setLoading(false); if (retry) timer = setTimeout(() => void load(), 5000) }
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      if (requestId) void api.hostTools({ action: 'cancelJava', requestId }).catch(() => undefined)
    }
  }, [target, probe, nonce])
  const label = (value: ProcessProbe) => t(`managedResources.process.${value}`)
  return <Modal open onClose={onClose} closeLabel={t('common.close')} title={`${t('managedResources.process.inspection')} · PID ${target.pid}`} width={960}>
    <div className="space-y-3" data-testid="process-inspection">
      <div className="flex items-center gap-2" role="tablist" aria-label={t('managedResources.process.inspection')} onKeyDown={navigateTabs}>
        {probes.map(value => <Button key={value} role="tab" aria-selected={probe === value}
          id={`${tabId}-${value}`} aria-controls={`${tabId}-panel`} tabIndex={probe === value ? 0 : -1}
          size="sm" variant={probe === value ? 'tonal' : 'ghost'} onClick={() => setProbe(value)}>{label(value)}</Button>)}
        <Button size="sm" variant="secondary" className="ml-auto" disabled={loading} onClick={() => setNonce(value => value + 1)}>{t('managedResources.appOperations.refresh')}</Button>
      </div>
      <p className="text-xs text-[var(--color-text-tertiary)]">{t('managedResources.process.inspectionHelp')}</p>
      <p role="status" className="text-xs">{loading ? t('managedResources.process.loading') : result ? new Date(result.sampledAt).toLocaleTimeString() : ''}</p>
      {error && <p role="alert" className="text-xs text-[var(--color-error)]">{t('managedResources.process.failed')}: {error}</p>}
      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${probe}`}>
      {result && <pre className="max-h-[55vh] overflow-auto whitespace-pre rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-3 text-xs" tabIndex={0}>{result.text || t('managedResources.process.noSockets')}</pre>}
      {result?.truncated && <p className="text-xs">{t('managedResources.process.truncated')}</p>}
      </div>
    </div>
  </Modal>
}
