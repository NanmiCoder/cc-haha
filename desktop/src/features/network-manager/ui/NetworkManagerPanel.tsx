import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTranslation, type TranslationKey } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import type { Host } from '@/features/managed-resources/types/resourceTypes'
import { proxyBypassCovers, type NetworkApplyReport, type NetworkManagerApi, type NetworkPlan, type NetworkProbe, type NetworkProfile, type NetworkProfilesDocument, type NetworkResult, type NetworkSnapshot } from '../networkTypes'
import { NetworkProfileFields, type NetworkProfileStage, type NetworkStageState } from './NetworkProfileFields'
import { NetworkResults } from './NetworkResults'
import { VpnRouteBindingPanel } from './VpnRouteBindingPanel'
import { networkIssueKey } from './networkMessages'
import { useSakuraDiscovery } from '../useSakuraDiscovery'
import { effectiveNetworkProfile } from '../executionReference'
import { NetworkExecutionReference } from './NetworkExecutionReference'

type Props = { api: NetworkManagerApi }
type NetworkManagerStage = NetworkProfileStage | 'plan' | 'verify'

function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return current
    current = current.parentElement
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

export function NetworkManagerPanel({ api }: Props) {
  const t = useTranslation()
  const [document, setDocument] = useState<NetworkProfilesDocument | null>(null)
  const [draft, setDraft] = useState<NetworkProfile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null)
  const [plan, setPlan] = useState<NetworkPlan | null>(null)
  const [report, setReport] = useState<NetworkApplyReport | null>(null)
  const [probes, setProbes] = useState<NetworkProbe[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [hostError, setHostError] = useState(false)
  const [hostId, setHostId] = useState('')
  const [stageStates, setStageStates] = useState<Partial<Record<NetworkProfileStage, NetworkStageState>>>({})
  const [activeStage, setActiveStage] = useState<NetworkManagerStage>('physical')
  const stageSections = useRef<Partial<Record<NetworkManagerStage, HTMLElement | null>>>({})
  const stageNavButtons = useRef<Partial<Record<NetworkManagerStage, HTMLButtonElement | null>>>({})
  const sakura = useSakuraDiscovery(api, draft?.proxyPort)
  const effectiveProfile = draft ? effectiveNetworkProfile(draft, sakura.discovery) : null
  const autoResolved = !!draft && !!effectiveProfile && (draft.proxyConfigPath !== effectiveProfile.proxyConfigPath || draft.sakuraExecutable !== effectiveProfile.sakuraExecutable)
  useEffect(() => {
    setSnapshot(null)
    setPlan(null)
    setReport(null)
    setProbes([])
    setStageStates({})
  }, [sakura.discovery])

  function unwrap<T>(result: NetworkResult<T>): T {
    if (!result.ok) {
      const key = networkIssueKey(result.error.code)
      throw new Error(`${key ? t(key) : t('networkManager.error')} (${result.error.code})`)
    }
    return result.data
  }
  function clearEvidence() {
    setSnapshot(null)
    setPlan(null)
    setReport(null)
    setProbes([])
    setNotice('')
    setError('')
    setStageStates({})
  }
  async function run(operation: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await operation() } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('networkManager.error'))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function refreshHosts() {
    try {
      const result = await getDesktopHost().hostManagement.listHosts()
      if (!mounted.current) return
      setHostError(!result.ok)
      if (result.ok) {
        setHosts(result.data)
        setHostId(previous => result.data.some(host => host.id === previous) ? previous : '')
      }
    } catch { if (mounted.current) setHostError(true) }
  }
  useEffect(() => {
    mounted.current = true
    void run(async () => {
      const value = unwrap(await api.list())
      if (!mounted.current) return
      setDocument(value)
      setDraft(value.profiles[0] ?? null)
      await refreshHosts()
    })
    return () => { mounted.current = false }
    // The API is stable for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  function edit(profile: NetworkProfile) {
    clearEvidence()
    setDraft(profile)
    setDirty(true)
  }
  function profileName(profile: NetworkProfile) {
    return profile.name || t(profile.mode === 'home' ? 'networkManager.home' : 'networkManager.work')
  }
  function registerStageSection(stage: NetworkManagerStage, node: HTMLElement | null) {
    stageSections.current[stage] = node
  }
  function selectStage(stage: NetworkManagerStage) {
    setActiveStage(stage)
    const section = stageSections.current[stage]
    const navButton = stageNavButtons.current[stage]
    if (!section || !navButton) return
    const scrollParent = findScrollParent(section)
    if (!scrollParent || typeof scrollParent.scrollTo !== 'function') {
      section.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
      return
    }
    const navTop = navButton.getBoundingClientRect().top
    const sectionTop = section.getBoundingClientRect().top
    const targetTop = scrollParent.scrollTop + (sectionTop - navTop)
    const maxTop = Math.max(0, scrollParent.scrollHeight - scrollParent.clientHeight)
    scrollParent.scrollTo({ top: Math.max(0, Math.min(targetTop, maxTop)), behavior: 'smooth' })
  }
  function stageSectionClass(stage: NetworkManagerStage) {
    return [
      'scroll-mt-3 space-y-3 rounded-[var(--radius-lg)] border bg-[var(--color-surface)] p-4 transition-colors',
      activeStage === stage
        ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-container-low)]'
        : 'border-[var(--color-border)]',
    ].join(' ')
  }
  function isProfileStage(stage: NetworkManagerStage): stage is NetworkProfileStage {
    return stage === 'physical' || stage === 'vpn' || stage === 'proxy' || stage === 'containers'
  }
  const navigationStages: Array<{ id: NetworkManagerStage; label: TranslationKey }> = [
    { id: 'physical', label: 'networkManager.physical' },
    { id: 'vpn', label: 'networkManager.vpn' },
    { id: 'proxy', label: 'networkManager.proxy' },
    { id: 'containers', label: 'networkManager.containers' },
    { id: 'plan', label: 'networkManager.plan' },
    { id: 'verify', label: 'networkManager.verify' },
  ]
  function stagePasses(stage: Exclude<NetworkProfileStage, 'containers'>, next: NetworkSnapshot) {
    const gatewayRoute = next.selectedRoutes.find(route => route.target === draft?.gatewayAddress)
    if (stage === 'physical') return next.interfaces.some(item => item.physical && item.connected) && Boolean(gatewayRoute)
    if (stage === 'vpn') {
      if (draft?.mode === 'work') return Boolean(gatewayRoute)
      return next.vpn.exists && next.vpn.connected
        && next.vpn.routePrefixes.includes(draft?.managementPrefix ?? '')
        && gatewayRoute?.interfaceAlias === draft?.vpnName
    }
    const desiredBypass = [draft?.managementPrefix, ...(draft?.containerEnabled ? [draft.containerPrefix] : [])].filter(Boolean)
    return next.proxy.available && next.proxy.mode === 'rule'
      && desiredBypass.every(prefix => proxyBypassCovers(next.proxy.bypassPrefixes, prefix!))
  }

  async function validateStage(stage: NetworkProfileStage) {
    if (!draft) return
    setSnapshot(null)
    setPlan(null)
    setReport(null)
    setProbes([])
    setNotice('')
    setError('')
    await run(async () => {
      if (stage === 'containers') {
        const all = unwrap(await api.verify(effectiveProfile ?? draft))
        const filtered = all.filter(probe => probe.target === draft.containerProbeAddress
          || probe.target === draft.tunnelName
          || (probe.target === draft.gatewayAddress && probe.port === draft.relayPort))
        setProbes(filtered)
        setStageStates(previous => ({ ...previous, containers: filtered.length > 0 && filtered.every(probe => probe.ok) ? 'passed' : 'failed' }))
        return
      }
      const next = unwrap(await api.inspect(effectiveProfile ?? draft))
      setSnapshot(next)
      setStageStates(previous => ({ ...previous, [stage]: stagePasses(stage, next) ? 'passed' : 'failed' }))
    })
  }

  async function previewStage(_stage: 'physical' | 'vpn' | 'containers') {
    if (!draft) return
    setSnapshot(null)
    setPlan(null)
    setReport(null)
    setProbes([])
    setNotice('')
    setError('')
    await run(async () => {
      const next = unwrap(await api.plan(effectiveProfile ?? draft))
      setSnapshot(next.snapshot)
      setPlan(next.plan)
    })
  }
  async function login(target: 'vpn' | 'sakura') {
    if (!draft) return
    if (target === 'sakura' && sakura.discovery?.running) { sakura.refresh(); return }
    clearEvidence()
    await run(async () => {
      unwrap(await api.login(target, effectiveProfile ?? draft))
      setNotice(t('networkManager.opened'))
      if (target === 'sakura') sakura.refresh()
    })
  }

  if (!document || !draft) return <div className="space-y-3 text-sm">
    {error ? <p role="alert" className="text-[var(--color-error)]">{error}</p> : <p>{t('networkManager.loading')}</p>}
  </div>

  return <div className="space-y-4 text-[var(--color-text-primary)]" data-testid="network-manager-panel" aria-busy={busy}>
    <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">{t('networkManager.intro')}</p>
    <div className="flex flex-wrap items-end gap-3">
      <SelectField label={t('networkManager.profile')} value={draft.id} size="md" disabled={busy}
        containerClassName="min-w-48 flex-1"
        options={[...document.profiles.map(profile => ({ value: profile.id, label: profileName(profile) })),
          ...(!document.profiles.some(profile => profile.id === draft.id) ? [{ value: draft.id, label: profileName(draft) }] : [])]}
        onChange={id => {
          const selected = document.profiles.find(profile => profile.id === id)
          if (selected) { clearEvidence(); setDraft(selected); setDirty(false) }
        }} />
      <Button size="base" variant="secondary" disabled={busy} onClick={() => edit({ ...draft, id: crypto.randomUUID(), name: `${profileName(draft)} ${t('networkManager.copySuffix')}` })}>{t('networkManager.copy')}</Button>
    </div>
    <div className="grid items-end gap-3 sm:grid-cols-2">
      <Input label={t('networkManager.name')} value={draft.name} placeholder={profileName(draft)} disabled={busy} size="md" onChange={event => edit({ ...draft, name: event.target.value })} />
      <SegmentedControl label={t('networkManager.profile')} value={draft.mode}
        items={[{ value: 'home', label: t('networkManager.home'), disabled: busy }, { value: 'work', label: t('networkManager.work'), disabled: busy }]}
        onChange={mode => edit({ ...draft, mode })} />
    </div>
    <NetworkExecutionReference api={api} stage="profile" profile={effectiveProfile ?? draft} extra={{ expectedRevision: document.revision }} />
    <div className="grid gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
      <nav className="h-fit overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2 lg:sticky lg:top-0"
        aria-label={t('networkManager.stages')}>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
          {navigationStages.map((stage, index) => {
            const active = activeStage === stage.id
            return <button key={stage.id} type="button" aria-current={active ? 'step' : undefined}
              ref={node => { stageNavButtons.current[stage.id] = node }}
              data-testid={`network-stage-${stage.id}`}
              onClick={() => selectStage(stage.id)}
              className={`flex min-w-0 items-center gap-3 rounded-[var(--radius-md)] border-l-2 px-3 py-2.5 text-left transition-colors ${active
                ? 'border-[var(--color-brand)] bg-[var(--color-surface)] text-[var(--color-text-primary)]'
                : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text-primary)]'}`}>
              <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${active
                ? 'bg-[var(--color-brand)] text-white'
                : 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'}`}>{index + 1}</span>
              <span className="min-w-0 truncate text-sm font-semibold">{t(stage.label).replace(/^\d+\s*·\s*/, '')}</span>
            </button>
          })}
        </div>
      </nav>

      <div className="min-w-0 space-y-4 pb-[45vh]">
        <NetworkProfileFields profile={draft} disabled={busy} previewDisabled={dirty || sakura.detecting}
          api={api} effectiveProfile={effectiveProfile ?? draft} sakura={sakura}
          activeStage={isProfileStage(activeStage) ? activeStage : undefined}
          stageStates={stageStates}
          registerSection={registerStageSection}
          onStageFocus={setActiveStage}
          onChange={edit}
          onLogin={target => void login(target)}
          onValidate={stage => void validateStage(stage)}
          onPreview={stage => void previewStage(stage)}
          vpnRoutePanel={<VpnRouteBindingPanel api={api} disabled={busy} profile={effectiveProfile ?? draft}
            defaultVpnName={draft.vpnName} defaultVpnScope={draft.vpnScope} />}
          onPick={field => void run(async () => {
            const selected = await getDesktopHost().dialogs.open({ multiple: false, title: t(field === 'proxyConfigPath' ? 'networkManager.chooseConfig' : 'networkManager.chooseExecutable'), filters: [{ name: field === 'proxyConfigPath' ? 'YAML' : 'EXE', extensions: field === 'proxyConfigPath' ? ['yaml', 'yml'] : ['exe'] }] })
            const path = Array.isArray(selected) ? selected[0] : selected
            if (path) edit({ ...draft, [field]: path })
          })} />

        <div className="flex flex-wrap items-center gap-2">
          <Button size="base" variant="secondary" disabled={busy || sakura.detecting || (!dirty && !autoResolved)} onClick={() => void run(async () => {
            const next = unwrap(await api.save(effectiveProfile ?? draft, document.revision))
            setDocument(next)
            setDraft(next.profiles.find(profile => profile.id === draft.id) ?? draft)
            setDirty(false)
            clearEvidence()
            setNotice(t('networkManager.saved'))
          })}>{t('networkManager.save')}</Button>
          <Badge tone={dirty ? 'warning' : 'neutral'} wrap>{t(dirty ? 'networkManager.dirty' : 'networkManager.configured')}</Badge>
        </div>

        <section ref={node => registerStageSection('plan', node)} className={stageSectionClass('plan')} onFocusCapture={() => setActiveStage('plan')}>
          <h3 className="text-sm font-semibold">{t('networkManager.plan')}</h3>
          <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.rollbackHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
              clearEvidence()
              void run(async () => setSnapshot(unwrap(await api.inspect(effectiveProfile ?? draft))))
            }}>{t('networkManager.inspect')}</Button>
            <Button size="sm" variant="secondary" disabled={busy || dirty || sakura.detecting} onClick={() => {
              clearEvidence()
              void run(async () => {
                const next = unwrap(await api.plan(effectiveProfile ?? draft))
                setSnapshot(next.snapshot)
                setPlan(next.plan)
              })
            }}>{t('networkManager.preview')}</Button>
            <Button size="sm" disabled={busy || dirty || sakura.detecting || !plan?.canApply || plan.changes.length === 0} onClick={() => void run(async () => {
              if (!plan) return
              const planId = plan.id
              setPlan(null)
              setReport(null)
              setProbes([])
              const next = unwrap(await api.apply(planId))
              setReport(next)
              setProbes(next.probes)
              setNotice(t(next.status === 'applied' ? 'networkManager.applied' : next.status === 'rolled-back' ? 'networkManager.rolledBack' : next.status === 'rollback-conflict' ? 'networkManager.rollbackConflict' : 'networkManager.failed'))
            })}>{t('networkManager.apply')}</Button>
            {snapshot?.issues.some(issue => issue.includes('RECOVERY_REQUIRED')) && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => {
              const next = unwrap(await api.recover())
              setReport(next)
              setSnapshot(null)
              setPlan(null)
              setProbes([])
            })}>{t('networkManager.rollback')}</Button>}
            <Button size="sm" variant="secondary" disabled={busy || dirty || sakura.detecting} onClick={() => void run(async () => {
              setProbes([])
              setProbes(unwrap(await api.verify(effectiveProfile ?? draft)))
            })}>{t('networkManager.verifyAll')}</Button>
          </div>
          {!plan && !snapshot && <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.noPlan')}</p>}
          <NetworkExecutionReference api={api} stage="plan" profile={effectiveProfile ?? draft} plan={plan} />
        </section>

        <NetworkResults snapshot={snapshot} plan={plan} report={report} probes={probes} />

        <section ref={node => registerStageSection('verify', node)} className={stageSectionClass('verify')} onFocusCapture={() => setActiveStage('verify')}>
          <h3 className="text-sm font-semibold">{t('networkManager.verify')}</h3>
          <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.verifyHint')}</p>
          {hostError ? <p role="alert" className="text-sm text-[var(--color-error)]">{t('networkManager.hostError')}</p> : !hosts.length && <p className="text-sm">{t('networkManager.noHosts')}</p>}
          <SelectField label={t('networkManager.host')} value={hostId} disabled={busy || hostError} size="md"
            options={[{ value: '', label: t('networkManager.selectHost') }, ...hosts.map(host => ({ value: host.id, label: `${host.name} · ${host.address}:${host.port}` }))]}
            onChange={value => { setHostId(value); setProbes([]) }} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !hostId || hostError} onClick={() => void run(async () => {
              setProbes([])
              setProbes([unwrap(await api.probeHost(hostId))])
            })}>{t('networkManager.testHost')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(refreshHosts)}>{t('networkManager.refreshHosts')}</Button>
          </div>
          <NetworkExecutionReference api={api} stage="verify" profile={effectiveProfile ?? draft} extra={{ hostId, address: hosts.find(host => host.id === hostId)?.address ?? '', port: hosts.find(host => host.id === hostId)?.port ?? null }} />
        </section>

        {notice && <p role="status" className="text-sm text-[var(--color-text-secondary)]">{notice}</p>}
        {error && <p role="alert" className="break-words text-sm text-[var(--color-error)]">{error}</p>}
      </div>
    </div>
  </div>
}
