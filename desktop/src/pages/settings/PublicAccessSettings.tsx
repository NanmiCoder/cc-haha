import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { publicAccessApi, type PublicAccessServerStatus } from '@/api/publicAccess'
import { getDesktopHost } from '@/lib/desktopHost'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
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

export function PublicAccessSettings() {
  const t = useTranslation()
  const host = getDesktopHost()
  const bridge = host.publicAccess
  const [status, setStatus] = useState<Awaited<ReturnType<typeof bridge.getStatus>> | null>(null)
  const [server, setServer] = useState<PublicAccessServerStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const actionGeneration = useRef(0)
  const [error, setError] = useState(false)
  const [consent, setConsent] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  useEffect(() => {
    if (host.kind !== 'electron' || !bridge) return
    let active = true
    const refresh = async () => {
      try {
        const [next, details] = await Promise.all([bridge.getStatus(), publicAccessApi.get()])
        if (active) {
          setStatus(next)
          setServer(details)
          if (next.state !== 'online') { setQr(null); setExpiresAt(null) }
        }
      } catch { if (active) setError(true) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => { active = false; clearInterval(timer) }
  }, [bridge, host.kind])
  useEffect(() => {
    if (!expiresAt) return
    const timer = setTimeout(() => { setQr(null); setExpiresAt(null) }, Math.max(0, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt])
  const run = async (action: () => Promise<unknown>) => {
    const generation = ++actionGeneration.current
    setBusy(true)
    setError(false)
    try {
      await action()
      if (generation !== actionGeneration.current) return
      const [next, details] = await Promise.all([bridge.getStatus(), publicAccessApi.get()])
      if (generation === actionGeneration.current) { setStatus(next); setServer(details) }
    } catch { if (generation === actionGeneration.current) setError(true) }
    finally { if (generation === actionGeneration.current) setBusy(false) }
  }
  if (host.kind !== 'electron' || !bridge) return null
  const stop = async () => {
    if (stopping) return
    actionGeneration.current += 1
    setStopping(true)
    setBusy(true)
    setError(false)
    try {
      setStatus(await bridge.stop())
      setQr(null)
      setExpiresAt(null)
      setServer(await publicAccessApi.get())
    } catch { setError(true) }
    finally { setStopping(false); setBusy(false) }
  }
  const start = () => run(async () => {
    if (token.trim()) { await bridge.saveCredential(token.trim()); setToken('') }
    setConsent(false)
    await bridge.start(PUBLIC_ACCESS_CONSENT_VERSION)
  })
  const stateLabels = {
    unconfigured: t('publicAccess.unconfigured'), disabled: t('publicAccess.disabled'), connecting: t('publicAccess.connecting'),
    online: t('publicAccess.online'), reconnecting: t('publicAccess.reconnecting'), failed: t('publicAccess.failed'),
  }
  const errorLabels = {
    auth: t('publicAccess.authError'), quota: t('publicAccess.quotaError'), network: t('publicAccess.networkError'), configuration: t('publicAccess.configurationError'),
  }
  const online = status?.state === 'online'
  return <SettingsSection title={t('publicAccess.title')} description={t('publicAccess.intro')}>
    <SettingsGroup>
      <SettingsRow
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
          onChange={(event) => setToken(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow
        title={(
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={online ? 'success' : status?.state === 'failed' ? 'danger' : status?.state === 'connecting' || status?.state === 'reconnecting' ? 'info' : 'neutral'} />
            <span role="status">{status ? stateLabels[status.state] : t('common.loading')}</span>
          </span>
        )}
        description={t('publicAccess.freeNotice')}
      >
        <Button size="base" disabled={busy || (!token.trim() && !status?.hasCredential) || status?.state === 'online' || status?.state === 'connecting' || status?.state === 'reconnecting'} onClick={() => { if (status?.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION) void start(); else setConsent(true) }}>{t('publicAccess.enable')}</Button>
        <Button size="base" variant="secondary" disabled={stopping || (busy && status?.state !== 'connecting' && status?.state !== 'reconnecting') || !status || status.state === 'unconfigured' || status.state === 'disabled'} onClick={() => void stop()}>{t('publicAccess.disable')}</Button>
        {status?.hasCredential && <Button size="base" variant="danger-ghost" disabled={busy} onClick={() => void run(async () => { await bridge.deleteCredential(); setToken(''); setQr(null); setExpiresAt(null) })}>{t('publicAccess.deleteCredential')}</Button>}
      </SettingsRow>
      <SettingsSwitchRow
        title={t('publicAccess.autoStart')}
        checked={status?.autoStart ?? false}
        disabled={busy || !status?.hasCredential || status.consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION}
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
          <div className="flex flex-wrap gap-2">
            <Button size="base" variant="secondary" disabled={busy} onClick={() => void run(async () => { if (!await copyTextToClipboard(`${status.publicUrl}/remote`)) throw new Error('copy') })}>{t('publicAccess.copy')}</Button>
            <Button size="base" disabled={busy} onClick={() => void run(async () => {
              const pair = await publicAccessApi.pairing()
              const url = new URL('/remote', status.publicUrl!)
              url.hash = new URLSearchParams({ pair: pair.secret }).toString()
              setQr(await QRCode.toDataURL(url.toString(), { margin: 1, width: 192 }))
              setExpiresAt(pair.expiresAt)
            })}>{t('publicAccess.pairPhone')}</Button>
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
          <p className="mt-2 whitespace-pre-line leading-6 text-[var(--color-text-tertiary)]">{t('publicAccess.privacy')}</p>
        </details>
      </SettingsBlock>
    </SettingsGroup>
    <ConfirmDialog open={consent} onClose={() => { if (!busy) setConsent(false) }} onConfirm={start} title={t('publicAccess.privacyTitle')} body={<p className="whitespace-pre-line">{t('publicAccess.privacy')}</p>} confirmLabel={t('publicAccess.consent')} cancelLabel={t('common.cancel')} loading={busy} />
  </SettingsSection>
}
