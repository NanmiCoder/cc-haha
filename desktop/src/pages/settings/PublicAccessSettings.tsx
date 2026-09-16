import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { publicAccessApi, type PublicAccessServerStatus } from '@/api/publicAccess'
import { getDesktopHost } from '@/lib/desktopHost'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
import { copyTextToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
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
  return <section aria-labelledby="public-access-title" className="mt-8">
    <h2 id="public-access-title" className="mb-3 text-xl font-semibold">{t('publicAccess.title')}</h2>
    <Card radius="xl" surface="low" padding="none" className="space-y-4 p-4">
      <p className="text-sm text-[var(--color-text-secondary)]">{t('publicAccess.intro')}</p>
      <Button variant="secondary" onClick={() => void run(() => host.shell.open('https://dashboard.ngrok.com/get-started/your-authtoken'))}>{t('publicAccess.account')}</Button>
      <Input aria-describedby="public-access-error" type="password" autoComplete="off" spellCheck={false} aria-label={t('publicAccess.token')} placeholder={status?.hasCredential ? t('publicAccess.tokenSaved') : t('publicAccess.token')} value={token} onChange={(event) => setToken(event.target.value)} />
      <p role="status" className="text-sm">{status ? stateLabels[status.state] : t('common.loading')}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || (!token.trim() && !status?.hasCredential) || status?.state === 'online' || status?.state === 'connecting' || status?.state === 'reconnecting'} onClick={() => { if (status?.consentVersion === PUBLIC_ACCESS_CONSENT_VERSION) void start(); else setConsent(true) }}>{t('publicAccess.enable')}</Button>
        <Button variant="secondary" disabled={stopping || (busy && status?.state !== 'connecting' && status?.state !== 'reconnecting') || !status || status.state === 'unconfigured' || status.state === 'disabled'} onClick={() => void stop()}>{t('publicAccess.disable')}</Button>
        {status?.hasCredential && <Button variant="danger" disabled={busy} onClick={() => void run(async () => { await bridge.deleteCredential(); setToken(''); setQr(null); setExpiresAt(null) })}>{t('publicAccess.deleteCredential')}</Button>}
      </div>
      <Checkbox label={t('publicAccess.autoStart')} checked={status?.autoStart ?? false} disabled={busy || !status?.hasCredential || status.consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION} onChange={(event) => void run(() => bridge.setAutoStart(event.target.checked))} />
      <p className="text-xs text-[var(--color-text-tertiary)]">{t('publicAccess.freeNotice')}</p>
      {(error || status?.error) && <p id="public-access-error" role="alert" className="text-sm text-[var(--color-error)]">{status?.error ? errorLabels[status.error] : t('publicAccess.genericError')}</p>}
      {status?.state === 'online' && status.publicUrl && <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
        <p className="break-all font-mono text-sm">{status.publicUrl}/remote</p>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => void run(async () => { if (!await copyTextToClipboard(`${status.publicUrl}/remote`)) throw new Error('copy') })}>{t('publicAccess.copy')}</Button>
          <Button disabled={busy} onClick={() => void run(async () => {
            const pair = await publicAccessApi.pairing()
            const url = new URL('/remote', status.publicUrl!)
            url.hash = new URLSearchParams({ pair: pair.secret }).toString()
            setQr(await QRCode.toDataURL(url.toString(), { margin: 1, width: 192 }))
            setExpiresAt(pair.expiresAt)
          })}>{t('publicAccess.pairPhone')}</Button></div>
        {qr && <><img src={qr} width={192} height={192} alt={t('publicAccess.qrAlt')} /><p className="text-xs">{t('publicAccess.qrHint')}</p></>}
      </div>}
      {server?.pending.map((device) => <div key={device.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-all text-sm">{t('publicAccess.pending')}: {device.name}</span><Button disabled={busy} onClick={() => void run(() => publicAccessApi.approve(device.id))}>{t('publicAccess.approve')}</Button><Button variant="secondary" disabled={busy} onClick={() => void run(() => publicAccessApi.reject(device.id))}>{t('publicAccess.reject')}</Button></div>)}
      {!!server?.devices.length && <h3 className="text-sm font-medium">{t('publicAccess.devices')}</h3>}
      {server?.devices.map((device) => <div key={device.id} className="flex items-center justify-between gap-3"><span className="min-w-0 break-all text-sm">{device.name}</span><Button variant="danger" disabled={busy} onClick={() => void run(() => publicAccessApi.revoke(device.id))}>{t('publicAccess.revoke')}</Button></div>)}
      <details className="text-xs text-[var(--color-text-secondary)]"><summary>{t('publicAccess.privacyTitle')}</summary><p className="mt-2 whitespace-pre-line leading-6">{t('publicAccess.privacy')}</p></details>
    </Card>
    <ConfirmDialog open={consent} onClose={() => { if (!busy) setConsent(false) }} onConfirm={start} title={t('publicAccess.privacyTitle')} body={<p className="whitespace-pre-line">{t('publicAccess.privacy')}</p>} confirmLabel={t('publicAccess.consent')} cancelLabel={t('common.cancel')} loading={busy} />
  </section>
}
