import { Badge } from '@/components/ui/Badge'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { NetworkManagerApi, NetworkProfile } from '../networkTypes'
import type { useSakuraDiscovery } from '../useSakuraDiscovery'
import { SakuraRuntimeFields } from './SakuraRuntimeFields'
import { NetworkExecutionReference } from './NetworkExecutionReference'

export type NetworkProfileStage = 'physical' | 'vpn' | 'proxy' | 'containers'
export type NetworkStageState = 'passed' | 'failed'

type Props = {
  profile: NetworkProfile
  effectiveProfile?: NetworkProfile
  api?: NetworkManagerApi
  sakura?: ReturnType<typeof useSakuraDiscovery>
  disabled: boolean
  previewDisabled?: boolean
  activeStage?: NetworkProfileStage
  stageStates?: Partial<Record<NetworkProfileStage, NetworkStageState>>
  registerSection?: (stage: NetworkProfileStage, node: HTMLElement | null) => void
  onStageFocus?: (stage: NetworkProfileStage) => void
  onChange: (profile: NetworkProfile) => void
  onLogin: (target: 'vpn' | 'sakura') => void
  onPick: (field: 'proxyConfigPath' | 'sakuraExecutable') => void
  onValidate?: (stage: NetworkProfileStage) => void
  onPreview?: (stage: 'physical' | 'vpn' | 'containers') => void
  vpnRoutePanel?: ReactNode
}

const hintClass = 'text-xs leading-relaxed text-[var(--color-text-secondary)]'

export function NetworkProfileFields({
  profile,
  effectiveProfile = profile,
  api,
  sakura,
  disabled,
  previewDisabled = false,
  activeStage,
  stageStates = {},
  registerSection,
  onStageFocus,
  onChange,
  onLogin,
  onPick,
  onValidate,
  onPreview,
  vpnRoutePanel,
}: Props) {
  const t = useTranslation()

  function field(key: keyof NetworkProfile, label: TranslationKey, numeric = false) {
    return <Input key={key} label={t(label)} value={String(profile[key])} disabled={disabled} size="md"
      type={numeric ? 'number' : 'text'} min={numeric ? 1 : undefined} max={numeric ? 65535 : undefined}
      onChange={event => onChange({ ...profile, [key]: numeric ? Number(event.target.value) : event.target.value })} />
  }

  function status(stage: NetworkProfileStage) {
    const state = stageStates[stage]
    if (!state) return null
    return <Badge tone={state === 'passed' ? 'success' : 'danger'}>{t(state === 'passed' ? 'networkManager.stagePassed' : 'networkManager.stageFailed')}</Badge>
  }

  function sectionClass(stage: NetworkProfileStage) {
    return [
      'scroll-mt-3 space-y-3 rounded-[var(--radius-lg)] border bg-[var(--color-surface)] p-4 transition-colors',
      activeStage === stage
        ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-container-low)]'
        : 'border-[var(--color-border)]',
    ].join(' ')
  }

  const reference = (stage: NetworkProfileStage) => api && <NetworkExecutionReference api={api} stage={stage} profile={effectiveProfile}
    extra={stage === 'proxy' && sakura?.discovery?.selected ? { source: 'process-argument', ...sakura.discovery.selected }
      : stage === 'containers' ? { serviceName: `WireGuardTunnel$${profile.tunnelName}`, interfaceIndex: 'Find-NetRoute → InterfaceIndex (runtime)', mode: profile.mode } : { mode: profile.mode }} />

  return <div className="min-w-0 space-y-3">
    <section ref={node => registerSection?.('physical', node)} className={sectionClass('physical')} onFocusCapture={() => onStageFocus?.('physical')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.physical')}</h3>
        {status('physical')}
      </div>
      <p className={hintClass}>{t('networkManager.physicalHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('managementPrefix', 'networkManager.corporatePrefix')}
        {field('gatewayAddress', 'networkManager.gateway')}
        {field('gatewayPort', 'networkManager.gatewayPort', true)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('physical')}>{t('networkManager.validatePhysical')}</Button>
        <Button size="sm" disabled={disabled || previewDisabled} onClick={() => onPreview?.('physical')}>{t('networkManager.previewRoute')}</Button>
      </div>
      {reference('physical')}
    </section>

    <section ref={node => registerSection?.('vpn', node)} className={sectionClass('vpn')} onFocusCapture={() => onStageFocus?.('vpn')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.vpn')}</h3>
        {status('vpn')}
      </div>
      <p className={hintClass}>{t(profile.mode === 'home' ? 'networkManager.vpnHint' : 'networkManager.workHint')}</p>
      {profile.mode === 'home' ? <>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('vpnName', 'networkManager.vpnName')}
          <SelectField label={t('networkManager.vpnScope')} value={profile.vpnScope} size="md" disabled={disabled}
            options={[{ value: 'allUsers', label: t('networkManager.allUsers') }, { value: 'currentUser', label: t('networkManager.currentUser') }]}
            onChange={vpnScope => onChange({ ...profile, vpnScope })} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('vpn')}>{t('networkManager.validateVpn')}</Button>
          <Button size="sm" disabled={disabled} onClick={() => onLogin('vpn')}>{t('networkManager.loginVpn')}</Button>
        </div>
      </> : <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('vpn')}>{t('networkManager.validateVpn')}</Button>
        <Button size="sm" disabled={disabled || previewDisabled} onClick={() => onPreview?.('vpn')}>{t('networkManager.previewRoute')}</Button>
      </div>}
      {reference('vpn')}
      {vpnRoutePanel}
    </section>

    <section ref={node => registerSection?.('proxy', node)} className={sectionClass('proxy')} onFocusCapture={() => onStageFocus?.('proxy')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.proxy')}</h3>
        {status('proxy')}
      </div>
      <p className={hintClass}>{t('networkManager.proxyHint')}</p>
      <SakuraRuntimeFields profile={profile} discovery={sakura?.discovery ?? null} detecting={sakura?.detecting ?? false}
        error={sakura?.error ?? false} disabled={disabled} onRefresh={() => sakura?.refresh()} onChange={onChange} onPick={onPick} />
      <div className="grid gap-3 sm:grid-cols-2">
        {field('proxyPort', 'networkManager.proxyEndpoint', true)}
        {field('externalProbeUrl', 'networkManager.proxyProbe')}
      </div>
      {!sakura?.discovery?.selected && <p className={hintClass}>{t('networkManager.configHint')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('proxy')}>{t('networkManager.validateProxy')}</Button>
        <Button size="sm" disabled={disabled || sakura?.detecting || sakura?.discovery?.running} onClick={() => onLogin('sakura')}>{t('networkManager.startSakura')}</Button>
      </div>
      {reference('proxy')}
    </section>

    <section ref={node => registerSection?.('containers', node)} className={sectionClass('containers')} onFocusCapture={() => onStageFocus?.('containers')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.containers')}</h3>
        {status('containers')}
      </div>
      <p className={hintClass}>{t('networkManager.containerHint')}</p>
      <p className={hintClass}>{t('networkManager.deployedHint')}</p>
      <Checkbox label={t('networkManager.containerEnabled')} checked={profile.containerEnabled} disabled={disabled}
        onChange={event => onChange({ ...profile, containerEnabled: event.target.checked })} />
      {profile.containerEnabled && <div className="grid gap-3 sm:grid-cols-2">
        {field('containerPrefix', 'networkManager.prefix')}
        {field('containerProbeAddress', 'networkManager.probeAddress')}
        {field('containerProbePort', 'networkManager.probePort', true)}
        <Input label={t('networkManager.tunnel')} hint={t('networkManager.tunnelHint')} value={profile.tunnelName} disabled={disabled} size="md" onChange={event => onChange({ ...profile, tunnelName: event.target.value })} />
        <Input label={t('networkManager.service')} hint={t('networkManager.taskHint')} value={profile.relayTaskName} disabled={disabled} size="md" onChange={event => onChange({ ...profile, relayTaskName: event.target.value })} />
        {profile.mode === 'home' && <>
          {field('relayPort', 'networkManager.relayPort', true)}
          <Input label={t('networkManager.expectedSource')} hint={t('networkManager.expectedSourceHint')} value={profile.expectedRelaySource}
            disabled={disabled} size="md" onChange={event => onChange({ ...profile, expectedRelaySource: event.target.value })} />
        </>}
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled || !profile.containerEnabled} onClick={() => onValidate?.('containers')}>{t('networkManager.validateContainers')}</Button>
        <Button size="sm" disabled={disabled || previewDisabled || !profile.containerEnabled} onClick={() => onPreview?.('containers')}>{t('networkManager.previewContainer')}</Button>
      </div>
      {reference('containers')}
    </section>
  </div>
}
