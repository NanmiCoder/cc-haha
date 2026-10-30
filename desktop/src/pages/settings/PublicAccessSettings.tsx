import { useCallback, useEffect, useId, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { publicAccessApi, type PublicAccessServerStatus } from '@/api/publicAccess'
import { getDesktopHost } from '@/lib/desktopHost'
import { PUBLIC_ACCESS_CONSENT_VERSION, type DesktopPublicAccessStatus } from '@/lib/desktopHost/types'
import { DEFAULT_PUBLIC_ACCESS_PORT, isCloudflareTunnelToken, normalizePublicAccessOrigin } from '@/lib/desktopHost/publicAccessConfiguration'
import { copyTextToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/Button'
import { StatusDot } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useUIStore } from '@/stores/uiStore'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/i18n'

const CLOUDFLARE_DASHBOARD = 'https://dash.cloudflare.com/?to=/:account/tunnels'
const CLOUDFLARE_GUIDE = 'https://developers.cloudflare.com/tunnel/get-started/'

export function PublicAccessSettings() {
  const t = useTranslation()
  const host = getDesktopHost()
  const bridge = host.publicAccess
  const [status, setStatus] = useState<DesktopPublicAccessStatus | null>(null)
  const latestStatus = useRef<DesktopPublicAccessStatus | null>(null)
  const pairingRevision = useRef(0)
  const updateStatus = useCallback((next: DesktopPublicAccessStatus) => {
    const previous = latestStatus.current
    if (previous?.state === 'online' && (next.state !== 'online' || previous.publicUrl !== next.publicUrl)) pairingRevision.current += 1
    latestStatus.current = next
    setStatus(next)
  }, [])
  const [server, setServer] = useState<PublicAccessServerStatus | null>(null)
  const [mode, setMode] = useState<'quick' | 'named'>('quick')
  const [customUrl, setCustomUrl] = useState('')
  const [tunnelToken, setTunnelToken] = useState('')
  const [serviceCopied, setServiceCopied] = useState(false)
  const [localPort, setLocalPort] = useState(String(DEFAULT_PUBLIC_ACCESS_PORT))
  const portId = useId()
  const initialized = useRef(false)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const actionGeneration = useRef(0)
  const refreshSequence = useRef(0)
  const pendingPairing = useRef(false)
  const pairingOrigin = useRef<string | null>(null)
  const [error, setError] = useState(false)
  const [consent, setConsent] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  useEffect(() => {
    if (host.kind !== 'electron' || !bridge) return
    let active = true
    const refresh = async () => {
      const generation = actionGeneration.current
      const sequence = ++refreshSequence.current
      try {
        const [next, details] = await Promise.all([bridge.getStatus(), publicAccessApi.get()])
        if (active && generation === actionGeneration.current && sequence === refreshSequence.current) {
          if (!initialized.current) {
            initialized.current = true
            setMode(next.mode)
            setCustomUrl(next.customUrl ?? '')
            setLocalPort(String(next.localPort ?? DEFAULT_PUBLIC_ACCESS_PORT))
          }
          updateStatus(next)
          setServer(details)
        }
      } catch { if (active && generation === actionGeneration.current && sequence === refreshSequence.current) setError(true) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => { active = false; actionGeneration.current += 1; pendingPairing.current = false; clearInterval(timer) }
  }, [bridge, host.kind, updateStatus])
  useEffect(() => {
    if (!expiresAt) return
    const timer = setTimeout(() => { setQr(null); setExpiresAt(null) }, Math.max(0, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt])
  const run = useCallback(async (action: (generation: number) => Promise<unknown>) => {
    const generation = ++actionGeneration.current
    setBusy(true)
    setError(false)
    try {
      await action(generation)
      if (generation !== actionGeneration.current) return
      const [next, details] = await Promise.all([bridge.getStatus(), publicAccessApi.get()])
      if (generation === actionGeneration.current) { updateStatus(next); setServer(details) }
    } catch {
      if (generation === actionGeneration.current) {
        setError(true)
        try {
          const next = await bridge.getStatus()
          if (generation === actionGeneration.current) updateStatus(next)
        } catch { /* A later status poll can recover the connection controls. */ }
      }
    }
    finally {
      if (generation === actionGeneration.current) {
        // Discard polls started while this operation was still in flight.
        actionGeneration.current += 1
        setBusy(false)
      }
    }
  }, [bridge, updateStatus])
  const isCurrentPairing = useCallback((publicUrl: string, generation: number, revision: number) =>
    generation === actionGeneration.current && revision === pairingRevision.current && latestStatus.current?.state === 'online' && latestStatus.current.publicUrl === publicUrl, [])
  const showPairing = useCallback(async (publicUrl: string, generation: number) => {
    const revision = pairingRevision.current
    if (!isCurrentPairing(publicUrl, generation, revision)) return
    pairingOrigin.current = null
    setQr(null)
    setExpiresAt(null)
    const pair = await publicAccessApi.pairing()
    if (!isCurrentPairing(publicUrl, generation, revision)) return
    if (typeof pair.secret !== 'string' || !pair.secret || !Number.isFinite(pair.expiresAt) || pair.expiresAt <= Date.now()) throw new Error('Invalid pairing code')
    const url = new URL('/remote', publicUrl)
    url.hash = new URLSearchParams({ pair: pair.secret }).toString()
    const image = await QRCode.toDataURL(url.toString(), { margin: 1, width: 192 })
    if (!isCurrentPairing(publicUrl, generation, revision)) return
    const current = await bridge.getStatus()
    if (!isCurrentPairing(publicUrl, generation, revision) || current.state !== 'online' || current.publicUrl !== publicUrl || pair.expiresAt <= Date.now()) return
    pairingOrigin.current = publicUrl
    setQr(image)
    setExpiresAt(pair.expiresAt)
    return url.toString()
  }, [bridge, isCurrentPairing])
  useEffect(() => {
    if (status?.state !== 'online' || status.publicUrl !== pairingOrigin.current) {
      setQr(null)
      setExpiresAt(null)
    }
    if (busy || !pendingPairing.current || status?.state !== 'online' || !status.publicUrl) return
    pendingPairing.current = false
    void run((generation) => showPairing(status.publicUrl!, generation))
  }, [busy, status, run, showPairing])
  if (host.kind !== 'electron' || !bridge) return null
  const stop = async () => {
    if (stopping) return
    const generation = ++actionGeneration.current
    pendingPairing.current = false
    pairingOrigin.current = null
    setQr(null)
    setExpiresAt(null)
    setStopping(true)
    setBusy(true)
    setError(false)
    try {
      const next = await bridge.stop()
      if (generation !== actionGeneration.current) return
      updateStatus(next)
      const details = await publicAccessApi.get()
      if (generation === actionGeneration.current) setServer(details)
    } catch { if (generation === actionGeneration.current) setError(true) }
    finally {
      if (generation === actionGeneration.current) { actionGeneration.current += 1; setStopping(false); setBusy(false) }
    }
  }
  const normalizedUrl = normalizePublicAccessOrigin(customUrl) ?? ''
  const port = Number(localPort)
  const validPort = Number.isInteger(port) && port >= 1024 && port <= 65535
  const tokenDraft = tunnelToken.trim()
  const validToken = tokenDraft ? isCloudflareTunnelToken(tokenDraft) : status?.tokenSet === true
  const validConfiguration = validPort && (mode === 'quick' || (!!normalizedUrl && validToken))
  const configuration = { mode, customUrl: mode === 'quick' ? '' : normalizedUrl, localPort: port }
  const configurationChanged = configuration.mode !== status?.mode || configuration.customUrl !== (status?.customUrl ?? '') ||
    configuration.localPort !== (status?.localPort ?? DEFAULT_PUBLIC_ACCESS_PORT) || !!tunnelToken.trim() ||
    (status?.state === 'unconfigured' && status.error === 'configuration')
  const start = () => run(async (generation) => {
    if (!validConfiguration) return
    setConsent(false)
    if (configurationChanged) {
      const saved = await bridge.configure({ ...configuration, ...(mode === 'named' && tunnelToken.trim() ? { tunnelToken: tunnelToken.trim() } : {}) })
      if (generation !== actionGeneration.current) return
      if (saved.mode !== configuration.mode || saved.customUrl !== configuration.customUrl ||
          saved.localPort !== configuration.localPort || (mode === 'named' && !saved.tokenSet)) {
        throw new Error('Public access configuration was not saved')
      }
      setTunnelToken('')
      updateStatus(saved)
    }
    setQr(null)
    setExpiresAt(null)
    pendingPairing.current = true
    if (latestStatus.current) updateStatus({ ...latestStatus.current, state: 'connecting', phase: 'preparing', error: null })
    const next = await bridge.start(PUBLIC_ACCESS_CONSENT_VERSION)
    if (generation !== actionGeneration.current) return
    updateStatus(next)
  })
  const stateLabels = {
    unconfigured: t('publicAccess.unconfigured'), disabled: t('publicAccess.disabled'), connecting: t('publicAccess.connecting'),
    online: t('publicAccess.gatewayReady'), reconnecting: t('publicAccess.reconnecting'), failed: t('publicAccess.failed'),
  }
  const phaseLabels = {
    preparing: t('publicAccess.preparing'), connecting: t('publicAccess.connecting'), checking: t('publicAccess.checking'),
  }
  const errorLabels = {
    network: t('publicAccess.networkError'), configuration: t('publicAccess.customConfigurationError'), stop: t('publicAccess.stopError'), runtime: t('publicAccess.runtimeError'), proxy: t('publicAccess.proxyError'),
  }
  const online = status?.state === 'online'
  const stopUnconfirmed = status?.error === 'stop'
  const running = online || status?.state === 'connecting' || status?.state === 'reconnecting' || stopUnconfirmed
  const configured = status?.mode === 'quick' || (!!normalizePublicAccessOrigin(status?.customUrl) && status?.tokenSet === true)
  const privacy = t('publicAccess.privacy')
  const serviceUrl = `http://127.0.0.1:${localPort}`
  const statusLabel = status ? status.phase && (status.state === 'connecting' || status.state === 'reconnecting')
    ? phaseLabels[status.phase] : stateLabels[status.state] : t('common.loading')
  return <SettingsSection title={t('publicAccess.title')} description={t('publicAccess.intro')}>
    <div className="space-y-4">
      <SettingsGroup>
        <SettingsBlock className="space-y-3">
          <SegmentedControl
            label={t('publicAccess.method')}
            value={mode}
            onChange={setMode}
            items={[
              { value: 'quick', label: t('publicAccess.quick'), disabled: busy || running || !status },
              { value: 'named', label: t('publicAccess.named'), disabled: busy || running || !status },
            ]}
          />
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t(mode === 'quick' ? 'publicAccess.quickHint' : 'publicAccess.namedHint')}</p>
          {mode === 'quick' && <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">{t('publicAccess.quickAddressHint')}</p>}
          {status?.migrationRequired && <p role="status" className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.migrationNotice')}</p>}
        </SettingsBlock>
        {mode === 'named' && <>
          <SettingsBlock className="space-y-3">
            <h4 className="text-[13px] font-semibold text-[var(--color-text-primary)]">{t('publicAccess.namedGuide')}</h4>
            <ol className="list-decimal space-y-2 pl-4 text-xs leading-5 text-[var(--color-text-secondary)]">
              <li>{t('publicAccess.namedStepAccount')}</li>
              <li>{t('publicAccess.namedStepCreate')}</li>
              <li>{t('publicAccess.namedStepRoute')}</li>
              <li>{t('publicAccess.namedStepToken')}</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => host.shell.open(CLOUDFLARE_DASHBOARD))}>{t('publicAccess.namedControlPanel')}</Button>
              <Button size="base" variant="link" disabled={busy} onClick={() => void run(() => host.shell.open(CLOUDFLARE_GUIDE))}>{t('publicAccess.namedDocs')}</Button>
            </div>
          </SettingsBlock>
          <SettingsRow title={t('publicAccess.namedService')} description={t('publicAccess.namedServiceHint')}>
            <code className="break-all text-xs text-[var(--color-text-primary)]">{serviceUrl}</code>
            <Button size="base" variant="secondary" disabled={busy || stopping || !validPort} onClick={() => void run(async () => {
              if (!await copyTextToClipboard(serviceUrl)) throw new Error('copy')
              setServiceCopied(true)
            })}>{t(serviceCopied ? 'publicAccess.serviceCopied' : 'publicAccess.copyService')}</Button>
          </SettingsRow>
          <SettingsRow title={t('publicAccess.customUrl')} description={running ? t('publicAccess.stopToChange') : t('publicAccess.customHint')}>
            <Input
              aria-label={t('publicAccess.customUrl')}
              type="url"
              size="md"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://phone.example.com"
              containerClassName="w-full sm:w-[280px]"
              value={customUrl}
              error={customUrl && !normalizedUrl ? t('publicAccess.customUrlError') : undefined}
              disabled={busy || running || !status}
              onChange={(event) => setCustomUrl(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow title={t('publicAccess.namedToken')} description={status?.tokenSet ? t('publicAccess.namedTokenSaved') : t('publicAccess.namedTokenHint')}>
            <Input
              aria-label={t('publicAccess.namedToken')}
              type="password"
              size="md"
              autoComplete="new-password"
              spellCheck={false}
              containerClassName="w-full sm:w-[280px]"
              value={tunnelToken}
              error={tokenDraft && !validToken ? t('publicAccess.namedTokenError') : undefined}
              disabled={busy || running || !status}
              onChange={(event) => setTunnelToken(event.target.value)}
            />
          </SettingsRow>
        </>}
        <SettingsBlock>
          <details className="text-xs text-[var(--color-text-secondary)]">
            <summary className="cursor-pointer">{t('publicAccess.portSettings')}</summary>
            <div className="mt-2 max-w-[240px] space-y-2">
              <label htmlFor={portId}>{t('publicAccess.localPort')}</label>
              <Input id={portId} type="number" min={1024} max={65535} step={1} size="md" value={localPort}
                error={!validPort ? t('publicAccess.localPortError') : undefined} disabled={busy || running}
                onChange={(event) => { setLocalPort(event.target.value); setServiceCopied(false) }} />
            </div>
          </details>
        </SettingsBlock>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          title={(
            <span className="inline-flex items-center gap-2">
              <StatusDot tone={online ? 'success' : status?.state === 'failed' ? 'danger' : status?.state === 'connecting' || status?.state === 'reconnecting' ? 'info' : 'neutral'} />
              <span role="status">{statusLabel}</span>
            </span>
          )}
          description={online ? t('publicAccess.customStatusHint') : t('publicAccess.pairSetupHint')}
        >
          <Button size="base" disabled={busy || !status || !validConfiguration || running} onClick={() => { if (status?.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION && !configurationChanged) void start(); else setConsent(true) }}>{t('publicAccess.enable')}</Button>
          <Button size="base" variant="secondary" disabled={stopping || !status || status.state === 'unconfigured' || status.state === 'disabled'} onClick={() => void stop()}>{t('publicAccess.disable')}</Button>
        </SettingsRow>
        {(error || status?.error) && (
          <SettingsBlock>
            <p id="public-access-error" role="alert" className="text-xs text-[var(--color-error)]">{status?.error ? errorLabels[status.error] : t('publicAccess.genericError')}</p>
          </SettingsBlock>
        )}
        {online && status.publicUrl && (
          <SettingsBlock className="space-y-3">
            <p className="break-all rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)]">{status.publicUrl}/remote</p>
            <div className="flex flex-wrap gap-2">
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(async generation => {
                const publicUrl = status.publicUrl!
                const revision = pairingRevision.current
                const link = await showPairing(publicUrl, generation)
                if (link && isCurrentPairing(publicUrl, generation, revision) && !await copyTextToClipboard(link)) throw new Error('copy')
              })}>{t('publicAccess.copy')}</Button>
              <Button size="base" disabled={busy} onClick={() => void run((generation) => showPairing(status.publicUrl!, generation))}>{t('publicAccess.pairPhone')}</Button>
            </div>
            {qr && (
              <div className="flex flex-col items-start gap-2">
                <img src={qr} width={192} height={192} alt={t('publicAccess.qrAlt')} className="rounded-[var(--radius-md)] border border-[var(--color-border)]" />
                <p className="text-xs text-[var(--color-text-tertiary)]">{t('publicAccess.qrHint')}</p>
              </div>
            )}
          </SettingsBlock>
        )}
        {server?.pending.map((device) => (
          <SettingsRow key={device.id} title={`${t('publicAccess.pending')}: ${device.name}`} layout="inline">
            <Button size="base" disabled={busy} onClick={() => void run(() => publicAccessApi.approve(device.id))}>{t('publicAccess.approve')}</Button>
            <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => publicAccessApi.reject(device.id))}>{t('publicAccess.reject')}</Button>
          </SettingsRow>
        ))}
        {!!server?.devices.length && (
          <SettingsBlock className="pb-0">
            <h4 className="text-xs font-semibold text-[var(--color-text-tertiary)]">{t('publicAccess.devices')}</h4>
          </SettingsBlock>
        )}
        {server?.devices.map((device) => (
          <SettingsRow key={device.id} title={device.name} layout="inline">
            <Button size="base" variant="danger-ghost" disabled={busy} onClick={() => void run(() => publicAccessApi.revoke(device.id))}>{t('publicAccess.revoke')}</Button>
          </SettingsRow>
        ))}
        <SettingsSwitchRow
          title={t('publicAccess.autoStart')}
          description={t('publicAccess.autoStartHint')}
          checked={status?.autoStart ?? false}
          disabled={busy || stopUnconfirmed || !configured || configurationChanged || status?.consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION}
          onChange={(checked) => void run(() => bridge.setAutoStart(checked))}
        />
        <SettingsBlock className="space-y-2">
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.proxyHint')}</p>
          <Button size="base" variant="link" onClick={() => useUIStore.getState().setActiveSettingsTab('general')}>{t('publicAccess.proxySettings')}</Button>
          <details className="text-xs text-[var(--color-text-secondary)]">
            <summary className="cursor-pointer">{t('publicAccess.privacyTitle')}</summary>
            <p className="mt-2 whitespace-pre-line leading-6 text-[var(--color-text-tertiary)]">{privacy}</p>
          </details>
        </SettingsBlock>
      </SettingsGroup>
    </div>
    <ConfirmDialog open={consent} onClose={() => { if (!busy) setConsent(false) }} onConfirm={start} title={t('publicAccess.privacyTitle')} body={<p className="whitespace-pre-line">{privacy}</p>} confirmLabel={t('publicAccess.consent')} cancelLabel={t('common.cancel')} loading={busy} />
  </SettingsSection>
}
