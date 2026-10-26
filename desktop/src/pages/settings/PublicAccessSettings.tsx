import { useCallback, useEffect, useId, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { publicAccessApi, type PublicAccessServerStatus } from '@/api/publicAccess'
import { getDesktopHost } from '@/lib/desktopHost'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
import { DEFAULT_PUBLIC_ACCESS_PORT, isNgrokDevOrigin, normalizeNgrokDomain, normalizePublicAccessOrigin } from '@/lib/desktopHost/publicAccessConfiguration'
import { copyTextToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/Button'
import { StatusDot } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/i18n'

export function PublicAccessSettings() {
  const t = useTranslation()
  const host = getDesktopHost()
  const bridge = host.publicAccess
  const [status, setStatus] = useState<Awaited<ReturnType<typeof bridge.getStatus>> | null>(null)
  const [server, setServer] = useState<PublicAccessServerStatus | null>(null)
  const [token, setToken] = useState('')
  const [mode, setMode] = useState<'ngrok' | 'custom'>('ngrok')
  const [customUrl, setCustomUrl] = useState('')
  const [ngrokDomain, setNgrokDomain] = useState('')
  const [localPort, setLocalPort] = useState(String(DEFAULT_PUBLIC_ACCESS_PORT))
  const portId = useId()
  const domainId = useId()
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
            setMode(next.mode ?? 'ngrok')
            setCustomUrl(next.customUrl ?? '')
            setNgrokDomain(next.ngrokDomain ?? '')
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
  const normalizedUrl = normalizePublicAccessOrigin(customUrl) ?? ''
  const normalizedNgrokDomain = normalizeNgrokDomain(ngrokDomain) ?? ''
  const validNgrokDomain = !ngrokDomain.trim() || !!normalizedNgrokDomain
  const port = Number(localPort)
  const validPort = Number.isInteger(port) && port >= 1024 && port <= 65535
  const validConfiguration = mode === 'ngrok' ? validNgrokDomain && !!(token.trim() || status?.hasCredential) : !!normalizedUrl && validPort
  const configuration = {
    mode,
    ngrokDomain: mode === 'ngrok' ? normalizedNgrokDomain : status?.ngrokDomain ?? '',
    customUrl: mode === 'custom' ? normalizedUrl : status?.customUrl ?? '',
    localPort: mode === 'custom' ? port : status?.localPort ?? DEFAULT_PUBLIC_ACCESS_PORT,
  }
  const configurationChanged = configuration.ngrokDomain !== (status?.ngrokDomain ?? '') || configuration.mode !== (status?.mode ?? 'ngrok') || configuration.customUrl !== (status?.customUrl ?? '') || configuration.localPort !== (status?.localPort ?? DEFAULT_PUBLIC_ACCESS_PORT)
  const start = () => run(async (generation) => {
    if (!validConfiguration) return
    setConsent(false)
    if (configurationChanged) {
      const saved = await bridge.configure(configuration)
      if (generation !== actionGeneration.current) return
      if (saved.mode !== configuration.mode || saved.customUrl !== configuration.customUrl ||
          saved.localPort !== configuration.localPort || saved.ngrokDomain !== configuration.ngrokDomain) {
        throw new Error('Public access configuration was not saved')
      }
    }
    if (mode === 'ngrok' && token.trim()) {
      await bridge.saveCredential(token.trim())
      if (generation !== actionGeneration.current) return
      setToken('')
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
    online: mode === 'custom' ? t('publicAccess.gatewayReady') : t('publicAccess.online'), reconnecting: t('publicAccess.reconnecting'), failed: t('publicAccess.failed'),
  }
  const errorLabels = {
    auth: t('publicAccess.authError'), quota: t('publicAccess.quotaError'), network: t('publicAccess.networkError'), configuration: t(mode === 'custom' ? 'publicAccess.customConfigurationError' : 'publicAccess.configurationError'),
  }
  const online = status?.state === 'online'
  const running = online || status?.state === 'connecting' || status?.state === 'reconnecting'
  const configured = status?.mode === 'custom' ? !!status.customUrl : !!status?.hasCredential
  const privacy = t(mode === 'custom' ? 'publicAccess.customPrivacy' : 'publicAccess.privacy')
  return <SettingsSection title={t('publicAccess.title')} description={t('publicAccess.intro')}>
    <SettingsGroup>
      <SettingsRow title={t('publicAccess.method')} description={running ? t('publicAccess.stopToChange') : t('publicAccess.methodHint')}>
        <SelectField
          label={t('publicAccess.method')}
          labelHidden
          size="md"
          value={mode}
          disabled={busy || running || !status}
          onChange={(value) => { pendingPairing.current = false; setMode(value); setError(false); setQr(null); setExpiresAt(null) }}
          options={[
            { value: 'ngrok', label: t('publicAccess.methodNgrok') },
            { value: 'custom', label: t('publicAccess.methodCustom') },
          ]}
          containerClassName="w-full sm:w-[240px]"
        />
      </SettingsRow>
      {mode === 'ngrok' ? <><SettingsRow
        title={t('publicAccess.token')}
        description={(
          <button
            type="button"
            className="font-medium text-[var(--color-text-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            onClick={() => void run(() => host.shell.open('https://dashboard.ngrok.com/get-started/your-authtoken'))}
          >
            {t('publicAccess.account')}
          </button>
        )}
      >
        <Input
          aria-describedby="public-access-error"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={t('publicAccess.token')}
          size="md"
          containerClassName="w-full sm:w-[240px]"
          className="font-mono text-xs"
          placeholder={status?.hasCredential ? t('publicAccess.tokenSaved') : t('publicAccess.token')}
          value={token}
          disabled={busy || running}
          onChange={(event) => setToken(event.target.value)}
        />
      </SettingsRow>
        <SettingsBlock>
          <details className="text-xs text-[var(--color-text-secondary)]">
            <summary className="cursor-pointer">{t('publicAccess.ngrokDomainSettings')}</summary>
            <div className="mt-2 space-y-2">
              <label htmlFor={domainId}>{t('publicAccess.ngrokDomain')}</label>
              <Input
                id={domainId}
                type="url"
                size="md"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://your-name.ngrok-free.dev"
                containerClassName="max-w-[320px]"
                value={ngrokDomain}
                disabled={busy || running}
                aria-invalid={!validNgrokDomain}
                aria-describedby={!validNgrokDomain ? 'public-access-domain-error' : undefined}
                onChange={(event) => setNgrokDomain(event.target.value)}
              />
              <p className="leading-5">{t('publicAccess.ngrokDomainHint')}</p>
              {!validNgrokDomain && <p id="public-access-domain-error" role="alert" className="text-[var(--color-error)]">{t('publicAccess.ngrokDomainError')}</p>}
            </div>
          </details>
        </SettingsBlock>
      </> : <>
        <SettingsRow title={t('publicAccess.customUrl')} description={t('publicAccess.customHint')}>
          <Input
            aria-label={t('publicAccess.customUrl')}
            aria-describedby={customUrl && !normalizedUrl ? 'public-access-url-error' : undefined}
            aria-invalid={!!customUrl && !normalizedUrl}
            type="url"
            size="md"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://phone.example.com"
            containerClassName="w-full sm:w-[280px]"
            value={customUrl}
            disabled={busy || running}
            onChange={(event) => setCustomUrl(event.target.value)}
          />
        </SettingsRow>
        {customUrl && !normalizedUrl && <SettingsBlock>
          <p id="public-access-url-error" role="alert" className="text-xs text-[var(--color-error)]">{t('publicAccess.customUrlError')}</p>
        </SettingsBlock>}
        <SettingsRow title={t('publicAccess.localTarget')} description={t('publicAccess.localTargetHint')}>
          <code className="break-all text-xs text-[var(--color-text-primary)]">{validPort ? `http://127.0.0.1:${port}` : '—'}</code>
          <Button size="base" variant="secondary" disabled={!validPort || busy} onClick={() => void run(async () => {
            if (!await copyTextToClipboard(`http://127.0.0.1:${port}`)) throw new Error('copy')
          })}>{t('publicAccess.copyTarget')}</Button>
        </SettingsRow>
        <SettingsBlock>
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
                onChange={(event) => setLocalPort(event.target.value)}
              />
              {!validPort && <p id="public-access-port-error" role="alert" className="text-[var(--color-error)]">{t('publicAccess.localPortError')}</p>}
            </div>
          </details>
        </SettingsBlock>
      </>}
      <SettingsRow
        title={(
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={online ? 'success' : status?.state === 'failed' ? 'danger' : status?.state === 'connecting' || status?.state === 'reconnecting' ? 'info' : 'neutral'} />
            <span role="status">{status ? stateLabels[status.state] : t('common.loading')}</span>
          </span>
        )}
        description={t(mode === 'custom' ? 'publicAccess.customStatusHint' : 'publicAccess.freeNotice')}
      >
        <Button size="base" disabled={busy || !status || !validConfiguration || running} onClick={() => { if (status?.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION && !configurationChanged) void start(); else setConsent(true) }}>{t('publicAccess.enable')}</Button>
        <Button size="base" variant="secondary" disabled={stopping || (busy && status?.state !== 'connecting' && status?.state !== 'reconnecting') || !status || status.state === 'unconfigured' || status.state === 'disabled'} onClick={() => void stop()}>{t('publicAccess.disable')}</Button>
        {mode === 'ngrok' && status?.hasCredential && <Button size="base" variant="danger-ghost" disabled={busy} onClick={() => void run(async () => { pendingPairing.current = false; await bridge.deleteCredential(); setToken(''); setQr(null); setExpiresAt(null) })}>{t('publicAccess.deleteCredential')}</Button>}
      </SettingsRow>
      <SettingsSwitchRow
        title={t('publicAccess.autoStart')}
        description={t('publicAccess.autoStartHint')}
        checked={status?.autoStart ?? false}
        disabled={busy || !configured || configurationChanged || status?.consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION}
        onChange={(checked) => void run(() => bridge.setAutoStart(checked))}
      />
      {(error || status?.error) && (
        <SettingsBlock>
          <p id="public-access-error" role="alert" className="text-xs text-[var(--color-error)]">{status?.error ? errorLabels[status.error] : t('publicAccess.genericError')}</p>
        </SettingsBlock>
      )}
      {online && status.publicUrl && (
        <SettingsBlock className="space-y-3">
          <p className="break-all rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)]">{status.publicUrl}/remote</p>
          {mode === 'ngrok' && <p className="text-xs text-[var(--color-text-tertiary)]">{t(status.ngrokDomain || isNgrokDevOrigin(status.publicUrl) ? 'publicAccess.stableAddress' : 'publicAccess.randomAddress')}</p>}
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
      <SettingsBlock>
        <details className="text-xs text-[var(--color-text-secondary)]">
          <summary className="cursor-pointer">{t('publicAccess.privacyTitle')}</summary>
          <p className="mt-2 whitespace-pre-line leading-6 text-[var(--color-text-tertiary)]">{privacy}</p>
        </details>
      </SettingsBlock>
    </SettingsGroup>
    <ConfirmDialog open={consent} onClose={() => { if (!busy) setConsent(false) }} onConfirm={start} title={t('publicAccess.privacyTitle')} body={<p className="whitespace-pre-line">{privacy}</p>} confirmLabel={t('publicAccess.consent')} cancelLabel={t('common.cancel')} loading={busy} />
  </SettingsSection>
}
