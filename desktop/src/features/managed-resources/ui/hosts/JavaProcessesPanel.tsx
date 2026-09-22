import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { IconButton } from '@/components/ui/IconButton'
import { getDesktopHost } from '@/lib/desktopHost'
import { useTranslation } from '@/i18n'
import type { Host } from '../../types/resourceTypes'
import type { JavaProcess, ProcessKind, ProcessProbe } from '../../api/hostToolsApi'
import { ProcessInspectionModal, type ProcessInspectionTarget } from './ProcessInspectionModal'
import { useHostSshStore } from '../../stores/hostSshStore'
import { useHostToolsPreferences } from './useHostToolsPreferences'

type JavaProcessesPanelProps = { host: Host; onConnect: () => void; processKind?: ProcessKind }

export function JavaProcessesPanel(props: JavaProcessesPanelProps) {
  // Changing hosts must reset drafts before the new host's preferences arrive.
  return <HostJavaProcessesPanel key={`${props.host.id}:${props.processKind ?? 'java'}`} {...props} />
}

function HostJavaProcessesPanel({ host, onConnect, processKind = 'java' }: JavaProcessesPanelProps) {
  const t = useTranslation()
  const ssh = useHostSshStore(state => state.byHostId[host.id])
  const config = useHostToolsPreferences({ hostId: host.id, ...(processKind !== 'java' ? { processKind } : {}) })
  const [inspection, setInspection] = useState<ProcessInspectionTarget | null>(null)
  const [rows, setRows] = useState<JavaProcess[]>([])
  const [draftQuery, setDraftQuery] = useState<string | null>(null)
  const composing = useRef(false)
  const query = draftQuery ?? config.preferences.lastJavaSearch
  const updateQuery = (value: string) => {
    setDraftQuery(value)
    // Submit from the user event, not an effect/debounce: leaving the tab must
    // not drop its last input. The main repository serializes atomic writes.
    if (!composing.current) void config.save({ lastJavaSearch: value })
  }
  const [nonce, setNonce] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sampledAt, setSampledAt] = useState('')
  const [unreadable, setUnreadable] = useState(0)
  const connectionId = ssh?.connectionId
  const generation = ssh?.generation
  const connected = ssh?.status === 'ready' && Boolean(connectionId)
  useEffect(() => {
    setRows([]); setError(null); setSampledAt(''); setUnreadable(0)
    if (!connected || !connectionId || generation === undefined) { setLoading(false); return }
    let alive = true
    let requestId: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const api = getDesktopHost().hostManagement
    const load = async () => {
      const id = crypto.randomUUID()
      requestId = id
      setLoading(true)
      try {
        const result = await api.hostTools(processKind === 'java'
          ? { action: 'listJava', hostId: host.id, connectionId, generation, requestId: id }
          : { action: 'listProcesses', processKind, hostId: host.id, connectionId, generation, requestId: id })
        if (!alive) return
        if (!result.ok) throw new Error(result.error.code)
        if (!(processKind === 'java' && result.data.kind === 'java') && !(result.data.kind === 'processes' && result.data.processKind === processKind)) throw new Error('INVALID_RESPONSE')
        setRows(result.data.processes); setSampledAt(result.data.sampledAt); setUnreadable(result.data.unreadable); setError(null)
      } catch (failure) {
        if (alive) { setRows([]); setError(failure instanceof Error ? failure.message : 'PROCESS_QUERY_FAILED') }
      } finally {
        if (requestId === id) requestId = null
        if (alive) { setLoading(false); timer = setTimeout(() => void load(), 5000) }
      }
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      if (requestId) void api.hostTools({ action: 'cancelJava', requestId }).catch(() => undefined)
    }
  }, [host.id, connected, connectionId, generation, nonce, processKind])
  const normalized = query.trim().normalize('NFC').toLowerCase()
  const filtered = useMemo(() => {
    // Split only for matching; persist the original query and saved keyword intact.
    const terms = [...new Set(normalized.split(/\s+/u).filter(Boolean))]
    if (terms.length === 0) return rows
    return rows.filter(row => {
      const text = `${row.pid} ${row.commandLine} ${row.xmx ?? ''} ${row.xms ?? ''}`.normalize('NFC').toLowerCase()
      return terms.some(term => text.includes(term))
    })
  }, [rows, normalized])
  if (!connected) return <div className="flex items-center gap-2 py-3 text-xs"><span>{t('managedResources.appOperations.connectFirst')}</span><Button size="xs" variant="secondary" onClick={onConnect}>{t('managedResources.appOperations.connect')}</Button></div>
  const openInspection = (row: JavaProcess, probe: ProcessProbe) => {
    if (!row.startTime || !connectionId || generation === undefined) return
    setInspection({ hostId: host.id, connectionId, generation, pid: row.pid, startTime: row.startTime, processKind, probe })
  }
  return <section className="min-w-0 space-y-3" aria-label={processKind === 'java' ? t('managedResources.hostTools.javaProcesses') : t(`managedResources.process.${processKind}`)} data-testid={`${processKind}-processes-panel`}>
    <div className="flex flex-wrap items-center gap-2">
      <Search size={14} aria-hidden="true" />
      <Input type="search" size="sm" maxLength={120} value={query} disabled={!config.ready} aria-label={t('managedResources.hostTools.processSearch')} placeholder={t('managedResources.hostTools.processSearch')}
        containerClassName="min-w-0 flex-1" onChange={event => updateQuery(event.currentTarget.value)} autoComplete="off" spellCheck={false}
        aria-describedby={`java-search-help-${host.id}`}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={event => { composing.current = false; updateQuery(event.currentTarget.value) }}
        onBlur={event => {
          // Retry a failed write only. A redundant blur write would disable the
          // Save keyword button between mouse-down and its ensuing click.
          if (config.ready && config.error && !composing.current && event.currentTarget.value !== config.preferences.lastJavaSearch) {
            void config.save({ lastJavaSearch: event.currentTarget.value })
          }
        }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') event.preventDefault()
        }} />
      <Button size="xs" variant="secondary" disabled={!query.trim() || !config.ready || config.saving || config.preferences.javaKeywords.includes(query.trim())}
        onClick={() => void config.save({ addJavaKeyword: query.trim() })}>{t('managedResources.hostTools.saveKeyword')}</Button>
      <Button size="xs" variant="secondary" icon={<RefreshCw size={12} />} disabled={loading} onClick={() => setNonce(value => value + 1)}>{t('managedResources.appOperations.refresh')}</Button>
    </div>
    <p id={`java-search-help-${host.id}`} className="text-[11px] text-[var(--color-text-tertiary)]">{t('managedResources.hostTools.processSearchHelp')}</p>
    {config.preferences.javaKeywords.length > 0 && <div className="flex flex-wrap items-center gap-2" aria-label={t('managedResources.hostTools.savedKeywords')}>
      <span className="text-xs text-[var(--color-text-tertiary)]">{t('managedResources.hostTools.savedKeywords')}</span>
      {config.preferences.javaKeywords.map(keyword => <div key={keyword} className="flex items-center rounded border border-[var(--color-border)]">
        <Button size="xs" variant="ghost" disabled={!config.ready} onClick={() => updateQuery(keyword)}>{keyword}</Button>
        <IconButton size="2xs" icon={<X size={10} />} label={`${t('managedResources.hostTools.removeKeyword')}: ${keyword}`} disabled={config.saving} onClick={() => void config.save({ removeJavaKeyword: keyword })} />
      </div>)}
    </div>}
    <p className="text-[11px] text-[var(--color-text-tertiary)]">{processKind === 'java' ? t('managedResources.hostTools.processHelp') : t('managedResources.process.listHelp')}</p>
    <div role="status" className="text-xs text-[var(--color-text-secondary)]">{loading ? t('managedResources.appOperations.loading') : `${filtered.length} / ${rows.length}`}{sampledAt && ` · ${new Date(sampledAt).toLocaleTimeString()}`}</div>
    {unreadable > 0 && <p className="text-xs text-[var(--color-text-secondary)]">{t('managedResources.hostTools.unreadable', { count: unreadable })}</p>}
    {(error || config.error) && <p role="alert" className="text-xs text-[var(--color-error)]">{error || config.error}</p>}
    <div className="max-h-[65vh] overflow-auto rounded border border-[var(--color-border)]">
      <table className="w-full min-w-[540px] table-fixed text-left text-xs">
        <thead className="sticky top-0 bg-[var(--color-surface-container)]"><tr>
          <th scope="col" className="w-20 p-2">PID</th><th scope="col" className="p-2">{t('managedResources.hostTools.commandLine')}</th>{processKind === 'java' && <th scope="col" className="w-32 p-2">Xmx / Xms</th>}<th scope="col" className="w-36 p-2">{t('managedResources.process.actions')}</th>
        </tr></thead>
        <tbody>{filtered.map(row => <tr key={row.pid} className="border-t border-[var(--color-border)]" data-java-pid={row.pid} data-process-kind={processKind}>
          <td className="p-2 align-top font-mono">{row.pid}</td><td className="whitespace-pre-wrap break-all p-2 align-top font-mono">{row.commandLine}</td>
          {processKind === 'java' && <td className="p-2 align-top font-mono"><div>Xmx: <span>{row.xmx ?? t('managedResources.hostTools.notSpecified')}</span></div><div>Xms: <span>{row.xms ?? t('managedResources.hostTools.notSpecified')}</span></div></td>}
          <td className="p-2 align-top"><div className="flex flex-wrap gap-1">{(['top', 'ports', 'connections'] as const).map(probe => <Button key={probe} size="xs" variant="secondary" disabled={!row.startTime} aria-label={`${t(`managedResources.process.${probe}`)}: ${row.pid}`} onClick={() => openInspection(row, probe)}>{t(`managedResources.process.${probe}`)}</Button>)}</div></td>
        </tr>)}</tbody>
      </table>
      {!loading && !error && filtered.length === 0 && <p className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">{processKind === 'java' ? t('managedResources.hostTools.noProcesses') : t('managedResources.process.empty')}</p>}
    </div>
    {inspection && inspection.connectionId === connectionId && inspection.generation === generation && <ProcessInspectionModal target={inspection} onClose={() => setInspection(null)} />}
  </section>
}
