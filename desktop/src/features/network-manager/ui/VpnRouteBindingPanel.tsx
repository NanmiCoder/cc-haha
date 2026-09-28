import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation, type TranslationKey } from '@/i18n'
import { proxyBypassCovers, type NetworkManagerApi, type NetworkProfile, type NetworkResult, type NetworkSnapshot, type VpnRouteBatchInput, type VpnRouteBatchPlan, type VpnRouteBatchReport, type VpnRouteOptions, type VpnRoutePlan, type VpnRouteProbeInput, type VpnRouteProbeResult, type VpnRouteSelection } from '../networkTypes'
import { networkIssueKey } from './networkMessages'
import { NetworkExecutionReference } from './NetworkExecutionReference'

type Props = {
  api: NetworkManagerApi
  profile: NetworkProfile
  disabled: boolean
  defaultVpnName: string
  defaultVpnScope: 'allUsers' | 'currentUser'
}

type VpnIdentity = { name: string; scope: 'allUsers' | 'currentUser' }

function vpnKey(vpn: VpnIdentity): string {
  return JSON.stringify([vpn.scope, vpn.name])
}

/** Reject malformed lists before IPC; the service remains the authority for route safety. */
function parseDestinations(value: string): { destinations: string[]; error: 'empty' | 'format' | 'limit' | 'duplicate' | null; invalid?: string } {
  const destinations = value.replace(/\r/g, '').split(/[\n,;]/).map(item => item.trim()).filter(Boolean)
  if (destinations.length === 0) return { destinations, error: 'empty' }
  if (destinations.length > 32) return { destinations, error: 'limit' }
  const seen = new Set<string>()
  for (const destination of destinations) {
    const match = /^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?:\/(\d{1,2}))?$/.exec(destination)
    if (!match || match[1]!.split('.').some(part => Number(part) > 255) || (match[2] && (Number(match[2]) < 8 || Number(match[2]) > 32))) {
      return { destinations, error: 'format', invalid: destination }
    }
    const identity = `${match[1]}/${match[2] ?? '32'}`
    if (seen.has(identity)) return { destinations, error: 'duplicate', invalid: destination }
    seen.add(identity)
  }
  return { destinations, error: null }
}

const issueKeys: Record<string, TranslationKey> = {
  VPN_ROUTE_WINDOWS_REQUIRED: 'networkManager.vpnRouteIssueWindows',
  VPN_ROUTE_VPN_MISSING: 'networkManager.vpnRouteIssueMissing',
  VPN_ROUTE_VPN_DISCONNECTED: 'networkManager.vpnRouteIssueDisconnected',
  VPN_ROUTE_SPLIT_REQUIRED: 'networkManager.vpnRouteIssueSplit',
  VPN_ROUTE_ELEVATION_REQUIRED: 'networkManager.vpnRouteIssueElevation',
  VPN_ROUTE_CONFLICT: 'networkManager.vpnRouteIssueConflict',
  VPN_ROUTE_LOCAL_ADDRESS: 'networkManager.vpnRouteIssueLocal',
  VPN_ROUTE_ALREADY_BOUND: 'networkManager.vpnRouteIssueBound',
  VPN_ROUTE_NOT_SELECTED: 'networkManager.vpnRouteIssueNotSelected',
  VPN_ROUTE_INSPECTION_INCOMPLETE: 'networkManager.vpnRouteIssueInspection',
  VPN_ROUTE_DESTINATION_INVALID: 'networkManager.vpnRouteInvalidFormat',
  VPN_ROUTE_BATCH_LIMIT: 'networkManager.vpnRouteInvalidLimit',
  VPN_ROUTE_BATCH_OVERLAP: 'networkManager.vpnRouteIssueOverlap',
  VPN_ROUTE_BATCH_DUPLICATE: 'networkManager.vpnRouteInvalidDuplicate',
  VPN_ROUTE_ROLLBACK_FAILED: 'networkManager.vpnRouteIssueRollback',
  VPN_ROUTE_PROBE_INVALID: 'networkManager.vpnRouteProbeInvalid',
}

function Selection({ selected, label }: { selected: VpnRouteSelection | null | undefined; label: string }) {
  if (!selected) return null
  return <p className="break-words text-xs" data-testid="vpn-route-selection">
    {label}: {selected.target} → {selected.interfaceAlias} · {selected.source} · {selected.prefix}
  </p>
}

function PlanItem({ item, t }: { item: VpnRoutePlan; t: ReturnType<typeof useTranslation> }) {
  const conflictsLabel = t('networkManager.vpnRouteConflicts')
  const issuesLabel = t('networkManager.vpnRouteIssues')
  return <div className="space-y-1 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2" role="group" aria-label={item.destination}>
    <p className="break-words text-xs font-medium">{item.destination}</p>
    {item.alreadyBound && <Badge tone={item.issues.includes('VPN_ROUTE_NOT_SELECTED') ? 'warning' : 'success'}>{t('networkManager.vpnRouteAlreadyBound')}</Badge>}
    {!item.canApply && !item.alreadyBound && <Badge tone="warning">{t('networkManager.vpnRouteBlocked')}</Badge>}
    <Selection selected={item.selected} label={t('networkManager.vpnRouteSelected')} />
    {item.conflicts.length > 0 && <div className="space-y-1 text-xs" role="group" aria-label={conflictsLabel}>
      <p className="font-medium">{conflictsLabel}</p>
      {item.conflicts.map((conflict, index) => <p className="break-words" key={`${conflict.prefix}-${conflict.interfaceAlias}-${index}`}>
        {conflict.prefix} → {conflict.interfaceAlias} ({conflict.store})
      </p>)}
    </div>}
    {item.issues.length > 0 && <div className="space-y-1 text-xs" role="group" aria-label={issuesLabel}>
      <p className="font-medium">{issuesLabel}</p>
      {item.issues.map((issue, index) => <p className="break-words text-[var(--color-error)]" key={`${issue}-${index}`}>
        {issueKeys[issue] ? t(issueKeys[issue]) : issue}
      </p>)}
    </div>}
  </div>
}

export function VpnRouteBindingPanel({ api, profile, disabled, defaultVpnName, defaultVpnScope }: Props) {
  const t = useTranslation()
  const [options, setOptions] = useState<VpnRouteOptions | null>(null)
  const [vpn, setVpn] = useState(vpnKey({ name: defaultVpnName, scope: defaultVpnScope }))
  const [destinationText, setDestinationText] = useState('')
  const [plan, setPlan] = useState<VpnRouteBatchPlan | null>(null)
  const [reviewedPlanId, setReviewedPlanId] = useState('')
  const [report, setReport] = useState<VpnRouteBatchReport | null>(null)
  const [error, setError] = useState('')
  const [probeAddress, setProbeAddress] = useState('')
  const [probePort, setProbePort] = useState('80')
  const [probeProtocol, setProbeProtocol] = useState<'tcp' | 'http' | 'https'>('http')
  const [probeResult, setProbeResult] = useState<VpnRouteProbeResult | null>(null)
  const [measurement, setMeasurement] = useState<{ snapshot: NetworkSnapshot; targets: VpnRouteBatchPlan | null; checkedAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const currentVpn = options?.vpns.find(item => vpnKey(item) === vpn)

  function unwrap<T>(result: NetworkResult<T>): T {
    if (result.ok) return result.data
    const key = issueKeys[result.error.code] ?? networkIssueKey(result.error.code)
    throw new Error(`${key ? t(key) : t('networkManager.error')} (${result.error.code})`)
  }

  async function run(operation: () => Promise<void>) {
    if (busy || disabled) return
    setBusy(true)
    setError('')
    try { await operation() } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('networkManager.error'))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setVpn(vpnKey({ name: defaultVpnName, scope: defaultVpnScope }))
    setPlan(null)
    setReviewedPlanId('')
    setReport(null)
  }, [defaultVpnName, defaultVpnScope])

  useEffect(() => {
    setMeasurement(null)
  }, [profile.id, profile.gatewayAddress, profile.managementPrefix, profile.proxyConfigPath])

  useEffect(() => {
    let active = true
    void api.vpnRouteOptions().then(result => {
      if (active) {
        if (result.ok) {
          setOptions(result.data)
          setVpn(previous => result.data.vpns.some(item => vpnKey(item) === previous)
            ? previous : result.data.vpns[0] ? vpnKey(result.data.vpns[0]) : '')
        }
        else setError(`${t('networkManager.vpnRouteLoadError')} (${result.error.code})`)
      }
    }).catch(() => { if (active) setError(t('networkManager.vpnRouteLoadError')) })
    return () => { active = false }
  }, [api, t])

  function clearReview() {
    setPlan(null)
    setReviewedPlanId('')
    setReport(null)
    setError('')
    setProbeResult(null)
    setMeasurement(null)
  }

  function probeInput(): VpnRouteProbeInput | null {
    if (!currentVpn) {
      setError(t('networkManager.vpnRouteNoVpn'))
      return null
    }
    const address = probeAddress.trim()
    const parsed = parseDestinations(address)
    if (parsed.error || parsed.destinations.length !== 1 || address.includes('/')) {
      setError(t('networkManager.vpnRouteProbeInvalid'))
      return null
    }
    const port = Number(probePort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t('networkManager.vpnRouteProbePortInvalid'))
      return null
    }
    return { address, port, protocol: probeProtocol, vpnName: currentVpn.name, vpnScope: currentVpn.scope }
  }

  async function runProbe() {
    const input = probeInput()
    if (!input) return
    setProbeResult(unwrap(await api.vpnRouteProbe(input)))
  }

  function batchInput(): VpnRouteBatchInput | null {
    const parsed = parseDestinations(destinationText)
    if (parsed.error) {
      const key: TranslationKey = parsed.error === 'empty' ? 'networkManager.vpnRouteInvalidEmpty'
        : parsed.error === 'limit' ? 'networkManager.vpnRouteInvalidLimit'
          : parsed.error === 'duplicate' ? 'networkManager.vpnRouteInvalidDuplicate' : 'networkManager.vpnRouteInvalidFormat'
      setError(t(key, { value: parsed.invalid ?? '' }))
      return null
    }
    if (!currentVpn) {
      setError(t('networkManager.vpnRouteNoVpn'))
      return null
    }
    return { destinations: parsed.destinations, vpnName: currentVpn.name, vpnScope: currentVpn.scope }
  }

  const canApply = Boolean(plan?.canApply && plan.id === reviewedPlanId && !report)
  const gatewayRoute = measurement?.snapshot.selectedRoutes.find(route => route.target === profile.gatewayAddress)
  const direct10 = measurement && measurement.snapshot.proxy.available && measurement.snapshot.proxy.mode === 'rule'
    && proxyBypassCovers(measurement.snapshot.proxy.bypassPrefixes, '10.0.0.0/8')
  return <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" role="region" aria-label={t('networkManager.vpnRouteTitle')}>
    <h4 className="text-sm font-semibold">{t('networkManager.vpnRouteTitle')}</h4>
    <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{t('networkManager.vpnRouteHint')}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <TextArea label={t('networkManager.vpnRouteDestination')} placeholder={'10.0.0.199\n10.204.19.0/24'}
        value={destinationText} rows={3} disabled={disabled || busy} onChange={event => {
          const value = event.target.value
          setDestinationText(value)
          clearReview()
          if (!probeAddress) {
            const firstAddress = value.replace(/\r/g, '').split(/[\n,;]/).map(item => item.trim()).find(item => /^(?:\d{1,3}\.){3}\d{1,3}(?:\/32)?$/.test(item))
            if (firstAddress) setProbeAddress(firstAddress.replace(/\/32$/, ''))
          }
        }}
        hint={t('networkManager.vpnRouteListHint')} />
      <SelectField label={t('networkManager.vpnRouteVpn')} value={vpn} size="md" disabled={disabled || busy || !options}
        options={(options?.vpns ?? []).map(item => ({
          value: vpnKey(item),
          label: `${item.name} · ${t(item.scope === 'allUsers' ? 'networkManager.allUsers' : 'networkManager.currentUser')}${item.connected ? ` · ${t('networkManager.vpnRouteConnected')}` : ''}`,
        }))}
        onChange={value => { setVpn(value); clearReview() }} />
    </div>
    {options && options.vpns.length === 0 && <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.vpnRouteNoVpn')}</p>}
    {currentVpn && <p className="text-xs text-[var(--color-text-secondary)]">
      {t(currentVpn.connected ? 'networkManager.vpnRouteConnected' : 'networkManager.vpnRouteDisconnected')} · {t(currentVpn.splitTunneling ? 'networkManager.vpnRouteSplitOn' : 'networkManager.vpnRouteSplitOff')}
    </p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={disabled || busy || !currentVpn} onClick={() => void run(async () => {
        const input = batchInput()
        if (!input) return
        setReport(null)
        setPlan(null)
        setReviewedPlanId('')
        const next = unwrap(await api.vpnRouteBatchPreview(input))
        setPlan(next)
        setReviewedPlanId(next.id)
      })}>{t('networkManager.vpnRoutePreview')}</Button>
      <Button size="sm" disabled={disabled || busy || !canApply} onClick={() => void run(async () => {
        if (!plan) return
        const planId = plan.id
        setPlan(null)
        setReviewedPlanId('')
        setReport(unwrap(await api.vpnRouteBatchApply(planId)))
        if (probeAddress.trim()) await runProbe()
      })}>{t('networkManager.vpnRouteApply')}</Button>
      <Button size="sm" variant="secondary" disabled={disabled || busy || !currentVpn} onClick={() => void run(async () => {
        const input = batchInput()
        if (!input) return
        setReport(null)
        setPlan(null)
        setReviewedPlanId('')
        setPlan(unwrap(await api.vpnRouteBatchVerify(input)))
      })}>{t('networkManager.vpnRouteVerify')}</Button>
      <Button size="sm" variant="secondary" disabled={disabled || busy} onClick={() => void run(async () => {
        const refreshedOptions = unwrap(await api.vpnRouteOptions())
        setOptions(refreshedOptions)
        setVpn(previous => refreshedOptions.vpns.some(item => vpnKey(item) === previous)
          ? previous : refreshedOptions.vpns[0] ? vpnKey(refreshedOptions.vpns[0]) : '')
        const observed = unwrap(await api.inspect(profile))
        setMeasurement({ snapshot: observed, targets: null, checkedAt: new Date().toISOString() })
        const parsed = parseDestinations(destinationText)
        if (parsed.error === 'empty') return
        const input = batchInput()
        if (!input) return
        const targets = unwrap(await api.vpnRouteBatchVerify(input))
        setMeasurement({ snapshot: observed, targets, checkedAt: new Date().toISOString() })
      })}>{t('networkManager.vpnRouteMeasureRefresh')}</Button>
    </div>
    {measurement && <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2 text-xs" role="group" aria-label={t('networkManager.vpnRouteMeasureTitle')}>
      <p className="font-medium">{t('networkManager.vpnRouteMeasureTitle')}</p>
      <p className="text-[var(--color-text-secondary)]">{t('networkManager.vpnRouteMeasuredAt')}: {new Date(measurement.snapshot.collectedAt).toLocaleString()} · {t('networkManager.vpnRouteTargetCheckedAt')}: {new Date(measurement.checkedAt).toLocaleString()}</p>
      <div className="space-y-1" role="group" aria-label={t('networkManager.vpnRouteGatewayMeasurement')}>
        <p className="font-medium">{t('networkManager.vpnRouteGatewayMeasurement')}: {profile.gatewayAddress}</p>
        <p>{t('networkManager.vpnRouteOsLayer')}: {gatewayRoute
          ? `${gatewayRoute.interfaceAlias} · ${gatewayRoute.source} · ${gatewayRoute.prefix}`
          : t('networkManager.vpnRouteNoSelection')}</p>
      </div>
      <div className="space-y-1" role="group" aria-label={t('networkManager.vpnRouteTargetsMeasurement')}>
        <p className="font-medium">{t('networkManager.vpnRouteTargetsMeasurement')}</p>
        {measurement.targets
          ? measurement.targets.items.map((item, index) => <p key={`${item.destination}-${index}`} className="break-words">
            {item.destination}: {t('networkManager.vpnRouteOsLayer')}: {item.selected
              ? `${item.selected.interfaceAlias} · ${item.selected.source} · ${item.selected.prefix}`
              : t('networkManager.vpnRouteNoSelection')}
          </p>)
          : <p>{t('networkManager.vpnRouteNoTargetsMeasured')}</p>}
      </div>
      <div className="space-y-1" role="group" aria-label={t('networkManager.vpnRouteProxyMeasurement')}>
        <p className="font-medium">{t('networkManager.vpnRouteProxyMeasurement')}: 10.0.0.0/8</p>
        <p>{t('networkManager.vpnRouteProxyLayer')}: {measurement.snapshot.proxy.available
          ? t(direct10 ? 'networkManager.vpnRouteProxyDirect' : 'networkManager.vpnRouteProxyNotDirect')
          : t(profile.proxyConfigPath ? 'networkManager.vpnRouteProxyUnavailable' : 'networkManager.vpnRouteProxyConfigMissing')}</p>
        {measurement.snapshot.proxy.available && <p>{t('networkManager.vpnRouteProxyMode')}: {measurement.snapshot.proxy.mode} · TUN {measurement.snapshot.proxy.tunEnabled ? 'on' : 'off'}</p>}
      </div>
    </div>}
    <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2">
      <p className="text-xs font-medium">{t('networkManager.vpnRouteProbeTitle')}</p>
      <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.vpnRouteProbeHint')}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input label={t('networkManager.vpnRouteProbeAddress')} placeholder="10.0.0.199"
          value={probeAddress} disabled={disabled || busy} onChange={event => { setProbeAddress(event.target.value); setProbeResult(null) }} />
        <Input label={t('networkManager.vpnRouteProbePort')} type="number" min={1} max={65535}
          value={probePort} disabled={disabled || busy} onChange={event => { setProbePort(event.target.value); setProbeResult(null) }} />
        <SelectField label={t('networkManager.vpnRouteProbeProtocol')} value={probeProtocol} size="md" disabled={disabled || busy}
          options={[{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }, { value: 'tcp', label: 'TCP' }]}
          onChange={value => { setProbeProtocol(value as 'tcp' | 'http' | 'https'); setProbeResult(null) }} />
      </div>
      <Button size="sm" variant="secondary" disabled={disabled || busy || !currentVpn} onClick={() => void run(runProbe)}>
        {t('networkManager.vpnRouteProbeButton')}
      </Button>
      {probeResult && <div className="space-y-1 text-xs" role="status">
        <p>{t(probeResult.viaVpn ? 'networkManager.vpnRouteProbeViaVpn' : 'networkManager.vpnRouteProbeOtherRoute')}</p>
        <Selection selected={probeResult.selected} label={t('networkManager.vpnRouteSelected')} />
        {probeResult.probe && <p data-testid="vpn-route-probe-result">
          {t(probeResult.probe.ok ? 'networkManager.vpnRouteProbeSuccess' : 'networkManager.vpnRouteProbeFailed')}
          {probeResult.probe.statusCode ? ` · HTTP ${probeResult.probe.statusCode}` : ''}
          {' · '}{probeResult.probe.detail}
        </p>}
        {probeResult.issues.map((issue, index) => <p className="text-[var(--color-error)]" key={`${issue}-${index}`}>
          {issueKeys[issue] ? t(issueKeys[issue]) : issue}
        </p>)}
      </div>}
    </div>
    {plan && <div className="space-y-2 text-xs" role="status">
      <p>{t('networkManager.vpnRoutePlan')}: {t('networkManager.vpnRouteCount', { count: plan.items.length })} → {plan.vpnName}</p>
      {!plan.canApply && <Badge tone="warning">{t('networkManager.vpnRouteBlocked')}</Badge>}
      {plan.expiresAt && <p className="text-[var(--color-text-secondary)]">{t('networkManager.vpnRouteExpires')}: {new Date(plan.expiresAt).toLocaleString()}</p>}
      {plan.items.map((item, index) => <PlanItem key={`${item.destination}-${index}`} item={item} t={t} />)}
    </div>}
    {report && <div className="space-y-2 text-xs" role="status">
      <p>{t(report.status === 'applied' ? 'networkManager.vpnRouteApplied' : report.status === 'rolled-back' ? 'networkManager.vpnRouteRolledBack' : 'networkManager.vpnRouteRollbackConflict')}</p>
      {report.destinations.map((destination, index) => <div key={`${destination}-${index}`} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2" role="group" aria-label={destination}>
        <p className="break-words font-medium">{destination}</p>
        <Selection selected={report.selected[index]} label={t('networkManager.vpnRouteSelected')} />
      </div>)}
    </div>}
    {(report?.issues ?? plan?.issues ?? []).length > 0 && <div className="space-y-1 text-xs" role="group" aria-label={t('networkManager.vpnRouteIssues')}>
      <p className="font-medium">{t('networkManager.vpnRouteIssues')}</p>
      {(report?.issues ?? plan?.issues ?? []).map((issue, index) => <p className="break-words text-xs text-[var(--color-error)]" key={`${issue}-${index}`}>
        {issueKeys[issue] ? t(issueKeys[issue]) : issue}
      </p>)}
    </div>}
    <NetworkExecutionReference api={api} stage="binding" profile={profile} extra={{
      destinations: parseDestinations(destinationText).destinations,
      vpnName: currentVpn?.name ?? '', vpnScope: currentVpn?.scope ?? '',
      address: probeAddress, port: probePort, protocol: probeProtocol,
      reviewedPlanId, expiresAt: plan?.expiresAt ?? '', routeMetric: 1,
      activeInterface: measurement?.snapshot.selectedRoutes ?? [],
    }} />
    {error && <p className="break-words text-xs text-[var(--color-error)]" role="alert">{error}</p>}
  </div>
}
