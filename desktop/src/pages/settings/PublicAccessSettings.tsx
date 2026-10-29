import { useCallback, useEffect, useId, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { publicAccessApi, type PublicAccessServerStatus } from '@/api/publicAccess'
import { getDesktopHost } from '@/lib/desktopHost'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
import { buildTailscaleServeCommand, DEFAULT_PUBLIC_ACCESS_PORT, normalizeTailscaleOrigin } from '@/lib/desktopHost/publicAccessConfiguration'
import { copyTextToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/Button'
import { StatusDot } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/i18n'

// Official stable aliases follow releases without pinning users to an old installer.
const tailscaleDownloads = {
  mac: 'https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg',
  windows: 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe',
  android: 'https://pkgs.tailscale.com/stable/tailscale-android-universal-latest.apk',
  googlePlay: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
  ios: 'https://apps.apple.com/us/app/tailscale/id1470499037?ls=1',
}

export function PublicAccessSettings() {
  const t = useTranslation()
  const host = getDesktopHost()
  const bridge = host.publicAccess
  const [status, setStatus] = useState<Awaited<ReturnType<typeof bridge.getStatus>> | null>(null)
  const [server, setServer] = useState<PublicAccessServerStatus | null>(null)
  const [customUrl, setCustomUrl] = useState('')
  const [copiedCommand, setCopiedCommand] = useState(false)
  const [localPort, setLocalPort] = useState(String(DEFAULT_PUBLIC_ACCESS_PORT))
  const portId = useId()
  const installQrId = useId()
  const [showInstallQr, setShowInstallQr] = useState(false)
  const [installQrs, setInstallQrs] = useState<{ android: string, ios: string } | null>(null)
  const [installQrError, setInstallQrError] = useState(false)
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
    if (!showInstallQr) return
    let active = true
    setInstallQrs(null)
    setInstallQrError(false)
    void Promise.all([
      QRCode.toDataURL(tailscaleDownloads.android, { margin: 1, width: 160 }),
      QRCode.toDataURL(tailscaleDownloads.ios, { margin: 1, width: 160 }),
    ]).then(([android, ios]) => {
      if (active) setInstallQrs({ android, ios })
    }).catch(() => { if (active) setInstallQrError(true) })
    return () => { active = false }
  }, [showInstallQr])
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
            setCustomUrl(next.customUrl ?? '')
            setLocalPort(String(next.localPort ?? DEFAULT_PUBLIC_ACCESS_PORT))
          }
          setStatus(next)
          setServer(details)
        }
      } catch { if (active && generation === actionGeneration.current && sequence === refreshSequence.current) setError(true) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => { active = false; actionGeneration.current += 1; pendingPairing.current = false; clearInterval(timer) }
  }, [bridge, host.kind])
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
      if (generation === actionGeneration.current) { setStatus(next); setServer(details) }
    } catch { if (generation === actionGeneration.current) setError(true) }
    finally {
      if (generation === actionGeneration.current) {
        // Discard polls started while this operation was still in flight.
        actionGeneration.current += 1
        setBusy(false)
      }
    }
  }, [bridge])
  const showPairing = useCallback(async (publicUrl: string, generation: number) => {
    const pair = await publicAccessApi.pairing()
    if (generation !== actionGeneration.current) return
    const url = new URL('/remote', publicUrl)
    url.hash = new URLSearchParams({ pair: pair.secret }).toString()
    const image = await QRCode.toDataURL(url.toString(), { margin: 1, width: 192 })
    if (generation !== actionGeneration.current) return
    pairingOrigin.current = publicUrl
    setQr(image)
    setExpiresAt(pair.expiresAt)
  }, [])
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
    actionGeneration.current += 1
    pendingPairing.current = false
    setStopping(true)
    setBusy(true)
    setError(false)
    try {
      setStatus(await bridge.stop())
      setQr(null)
      setExpiresAt(null)
      setServer(await publicAccessApi.get())
    } catch { setError(true) }
    finally { actionGeneration.current += 1; setStopping(false); setBusy(false) }
  }
  const normalizedUrl = normalizeTailscaleOrigin(customUrl) ?? ''
  const port = Number(localPort)
  const validPort = Number.isInteger(port) && port >= 1024 && port <= 65535
  const validConfiguration = !!normalizedUrl && validPort
  const command = buildTailscaleServeCommand(port, customUrl.trim() || undefined)
  const configuration = { mode: 'tailscale' as const, customUrl: normalizedUrl, localPort: port }
  const configurationChanged = configuration.mode !== status?.mode || configuration.customUrl !== (status?.customUrl ?? '') || configuration.localPort !== (status?.localPort ?? DEFAULT_PUBLIC_ACCESS_PORT)
  const start = () => run(async (generation) => {
    if (!validConfiguration) return
    setConsent(false)
    if (configurationChanged) {
      const saved = await bridge.configure(configuration)
      if (generation !== actionGeneration.current) return
      if (saved.mode !== configuration.mode || saved.customUrl !== configuration.customUrl ||
          saved.localPort !== configuration.localPort) {
        throw new Error('Public access configuration was not saved')
      }
    }
    setQr(null)
    setExpiresAt(null)
    pendingPairing.current = true
    const next = await bridge.start(PUBLIC_ACCESS_CONSENT_VERSION)
    if (generation !== actionGeneration.current) return
    setStatus(next)
  })
  const stateLabels = {
    unconfigured: t('publicAccess.unconfigured'), disabled: t('publicAccess.disabled'), connecting: t('publicAccess.connecting'),
    online: t('publicAccess.gatewayReady'), reconnecting: t('publicAccess.reconnecting'), failed: t('publicAccess.failed'),
  }
  const errorLabels = {
    network: t('publicAccess.networkError'), configuration: t('publicAccess.customConfigurationError'), stop: t('publicAccess.stopError'),
  }
  const online = status?.state === 'online'
  const stopUnconfirmed = status?.error === 'stop'
  const running = online || status?.state === 'connecting' || status?.state === 'reconnecting' || stopUnconfirmed
  const configured = !!normalizeTailscaleOrigin(status?.customUrl)
  const privacy = t('publicAccess.privacy')
  return <SettingsSection title={t('publicAccess.title')} description={t('publicAccess.intro')}>
    <div className="space-y-4">
      <SettingsGroup>
        <SettingsBlock className="space-y-2">
          <h4 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text-primary)]">
            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-surface-container)] text-[11px]">1</span>
            {t('publicAccess.stepInstall')}
          </h4>
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.tailscaleSetup')}</p>
          <div role="group" aria-label={t('publicAccess.installComputer')} className="space-y-2">
            <p className="text-xs font-medium text-[var(--color-text-primary)]">{t('publicAccess.installComputer')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => host.shell.open(tailscaleDownloads.mac))}>{t('publicAccess.downloadMac')}</Button>
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => host.shell.open(tailscaleDownloads.windows))}>{t('publicAccess.downloadWindows')}</Button>
            </div>
          </div>
          <div role="group" aria-label={t('publicAccess.installPhone')} className="space-y-2">
            <p className="text-xs font-medium text-[var(--color-text-primary)]">{t('publicAccess.installPhone')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => host.shell.open(tailscaleDownloads.android))}>{t('publicAccess.downloadAndroid')}</Button>
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => host.shell.open(tailscaleDownloads.googlePlay))}>{t('publicAccess.googlePlay')}</Button>
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => host.shell.open(tailscaleDownloads.ios))}>{t('publicAccess.downloadIos')}</Button>
              <Button size="base" variant="secondary" aria-expanded={showInstallQr} aria-controls={installQrId} onClick={() => setShowInstallQr(value => !value)}>{t('publicAccess.phoneInstallQr')}</Button>
            </div>
            <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.phoneInstallHint')}</p>
          </div>
          {showInstallQr && <div id={installQrId} className="space-y-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] p-3">
            <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.phoneInstallQrHint')}</p>
            {installQrError ? <p role="alert" className="text-xs text-[var(--color-error)]">{t('publicAccess.phoneInstallQrError')}</p> : installQrs ? <div className="flex flex-wrap gap-4">
              <figure className="space-y-1">
                <img src={installQrs.android} width={160} height={160} alt={t('publicAccess.androidInstallQrAlt')} className="rounded-[var(--radius-sm)]" />
                <figcaption className="text-xs text-[var(--color-text-primary)]">{t('publicAccess.downloadAndroid')}</figcaption>
              </figure>
              <figure className="space-y-1">
                <img src={installQrs.ios} width={160} height={160} alt={t('publicAccess.iosInstallQrAlt')} className="rounded-[var(--radius-sm)]" />
                <figcaption className="text-xs text-[var(--color-text-primary)]">{t('publicAccess.downloadIos')}</figcaption>
              </figure>
            </div> : <p role="status" className="text-xs text-[var(--color-text-secondary)]">{t('common.loading')}</p>}
          </div>}
          <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">{t('publicAccess.installSourceHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="base" variant="link" disabled={busy} onClick={() => void run(() => host.shell.open('https://tailscale.com/download'))}>{t('publicAccess.installGuide')}</Button>
            <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(() => host.shell.open('https://cchaha.ai/desktop/remote'))}>{t('publicAccess.connectionGuide')}</Button>
          </div>
          {status?.migrationRequired && <p role="status" className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.migrationNotice')}</p>}
        </SettingsBlock>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsBlock className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h4 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text-primary)]">
              <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-surface-container)] text-[11px]">2</span>
              {t('publicAccess.stepConfigure')}
            </h4>
            <Button size="base" variant="secondary" disabled={!command || busy || !status} onClick={() => void run(async () => {
              if (!command || !await copyTextToClipboard(command)) throw new Error('copy')
              setCopiedCommand(true)
            })}>{t(copiedCommand ? 'publicAccess.commandCopied' : 'publicAccess.copyCommand')}</Button>
          </div>
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.terminalHint')}</p>
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.macCliHint')}</p>
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.runCommandHint')}</p>
          <code className="block break-all rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-3 py-2 text-xs text-[var(--color-text-primary)]">{command ?? '—'}</code>
          <details className="text-xs text-[var(--color-text-secondary)]">
            <summary className="cursor-pointer">{t('publicAccess.commandHelp')}</summary>
            <p className="mt-2 leading-5">{t('publicAccess.commandHint')}</p>
          </details>
          <details className="text-xs text-[var(--color-text-secondary)]">
            <summary className="cursor-pointer">{t('publicAccess.portSettings')}</summary>
            <div className="mt-2 max-w-[240px] space-y-2">
              <label htmlFor={portId}>{t('publicAccess.localPort')}</label>
              <Input
                id={portId}
                aria-describedby={!validPort ? 'public-access-port-error' : undefined}
                aria-invalid={!validPort}
                type="number"
                min={1024}
                max={65535}
                step={1}
                size="md"
                value={localPort}
                disabled={busy || running}
                onChange={(event) => { setLocalPort(event.target.value); setCopiedCommand(false) }}
              />
              {!validPort && <p id="public-access-port-error" role="alert" className="text-[var(--color-error)]">{t('publicAccess.localPortError')}</p>}
            </div>
          </details>
        </SettingsBlock>
        <SettingsRow title={t('publicAccess.customUrl')} description={running ? t('publicAccess.stopToChange') : t('publicAccess.customHint')}>
          <Input
            aria-label={t('publicAccess.customUrl')}
            aria-describedby={customUrl && !normalizedUrl ? 'public-access-url-error' : undefined}
            aria-invalid={!!customUrl && !normalizedUrl}
            type="url"
            size="md"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://computer.tailnet.ts.net"
            containerClassName="w-full sm:w-[280px]"
            value={customUrl}
            disabled={busy || running || !status}
            onChange={(event) => { setCustomUrl(event.target.value); setCopiedCommand(false) }}
          />
        </SettingsRow>
        {customUrl && !normalizedUrl && <SettingsBlock>
          <p id="public-access-url-error" role="alert" className="text-xs text-[var(--color-error)]">{t('publicAccess.customUrlError')}</p>
        </SettingsBlock>}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsBlock className="space-y-1.5">
          <h4 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text-primary)]">
            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-surface-container)] text-[11px]">3</span>
            {t('publicAccess.stepPair')}
          </h4>
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t('publicAccess.pairSetupHint')}</p>
        </SettingsBlock>
        <SettingsRow
          title={(
            <span className="inline-flex items-center gap-2">
              <StatusDot tone={online ? 'success' : status?.state === 'failed' ? 'danger' : status?.state === 'connecting' || status?.state === 'reconnecting' ? 'info' : 'neutral'} />
              <span role="status">{status ? stateLabels[status.state] : t('common.loading')}</span>
            </span>
          )}
          description={online ? t('publicAccess.customStatusHint') : undefined}
        >
          <Button size="base" disabled={busy || !status || !validConfiguration || running} onClick={() => { if (status?.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION && !configurationChanged) void start(); else setConsent(true) }}>{t('publicAccess.enable')}</Button>
          <Button size="base" variant="secondary" disabled={stopping || (busy && status?.state !== 'connecting' && status?.state !== 'reconnecting') || !status || status.state === 'unconfigured' || status.state === 'disabled'} onClick={() => void stop()}>{t('publicAccess.disable')}</Button>
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
              <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(async () => { if (!await copyTextToClipboard(`${status.publicUrl}/remote`)) throw new Error('copy') })}>{t('publicAccess.copy')}</Button>
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
        <SettingsBlock>
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
