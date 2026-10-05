import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { remoteAccessApi } from '@/api/publicAccess'
import { ApiError } from '@/api/client'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { useTranslation } from '@/i18n'

export function RemoteAccessGate({ children }: { children: ReactNode }) {
  const t = useTranslation()
  const secret = useRef<string | null>(null)
  const initialized = useRef(false)
  useLayoutEffect(() => {
    // Capture after React commits: StrictMode may discard the first render's refs.
    // A layout effect still clears the address before paint and any API request.
    if (initialized.current) return
    initialized.current = true
    secret.current = new URLSearchParams(window.location.hash.slice(1)).get('pair')
    if (secret.current) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [])
  const [state, setState] = useState<'loading' | 'pair' | 'pending' | 'ready' | 'error' | 'unpaired'>('loading')
  const [name, setName] = useState('')
  const [claim, setClaim] = useState<{ id: string, claimSecret: string } | null>(null)
  useEffect(() => {
    let active = true
    remoteAccessApi.session().then((result) => {
      if (active) setState(result.authenticated ? 'ready' : secret.current ? 'pair' : 'unpaired')
    }).catch(() => { if (active) setState('error') })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!claim || state !== 'pending') return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await remoteAccessApi.claim(claim.id, claim.claimSecret)
        if (!active) return
        if (result.status === 'approved') { setClaim(null); setState('ready') }
        else if (result.status === 'rejected') { setClaim(null); setState('unpaired') }
        else timer = setTimeout(() => void poll(), 1500)
      } catch (error) {
        if (!active) return
        if (error instanceof ApiError && error.status === 401) {
          setClaim(null)
          setState('unpaired')
        } else setState('error')
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [claim, state])
  useEffect(() => {
    if (state !== 'ready') return
    secret.current = null
    let active = true
    const check = () => {
      if (document.visibilityState === 'hidden') return
      void remoteAccessApi.session().then((result) => {
        if (active && !result.authenticated) setState('unpaired')
      }).catch(() => { /* Existing chat reconnection owns transient network failures. */ })
    }
    const timer = setInterval(check, 30000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [state])
  const retry = async () => {
    setState('loading')
    try {
      // The cookie may have arrived even if the one-use claim response was lost.
      const session = await remoteAccessApi.session()
      if (session.authenticated) {
        setClaim(null)
        setState('ready')
      } else if (claim) {
        setState('pending')
      } else {
        setState(secret.current ? 'pair' : 'unpaired')
      }
    } catch { setState('error') }
  }
  const pair = async () => {
    if (!secret.current || !name.trim()) return
    setState('loading')
    try {
      const result = await remoteAccessApi.pair(secret.current, name.trim())
      secret.current = null
      setClaim(result)
      setState('pending')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        secret.current = null
        setClaim(null)
        setState('unpaired')
      } else setState('error')
    }
  }
  if (state === 'ready') return children
  const waiting = state === 'loading' || state === 'pending'
  return <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface)] px-4 py-10 text-[var(--color-text-primary)]">
    <div className="w-full max-w-[400px] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-6 pb-6 pt-7 shadow-[var(--shadow-card)]">
      <div className="flex flex-col items-center text-center">
        <BrandSeal size="lg" />
        <h1 className="mt-4 text-[18px] font-semibold leading-snug">{t('publicAccess.title')}</h1>
        <div className="mt-2 flex w-full items-start justify-center gap-2">
          {waiting && <Spinner size={14} className="mt-[3px] shrink-0 text-[var(--color-text-tertiary)]" />}
          <p
            id="remote-access-status"
            role={state === 'error' ? 'alert' : 'status'}
            className={state === 'error'
              ? 'w-full rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-left text-xs leading-[1.6] text-[var(--color-on-error-container)]'
              : 'text-[13px] leading-[1.6] text-[var(--color-text-secondary)]'}
          >
            {state === 'pair' ? t('publicAccess.phoneIntro') : state === 'pending' ? t('publicAccess.phonePending') : state === 'error' ? t('publicAccess.phoneError') : state === 'unpaired' ? t('publicAccess.phoneUnpaired') : t('common.loading')}
          </p>
        </div>
      </div>
      {state === 'pair' && <div className="mt-5 grid gap-3">
        <Input size="lg" aria-describedby="remote-access-status" aria-label={t('publicAccess.deviceName')} placeholder={t('publicAccess.deviceName')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <Button variant="primary" size="lg" block disabled={!name.trim()} onClick={() => void pair()}>{t('publicAccess.requestPair')}</Button>
      </div>}
      {state === 'error' && <Button variant="secondary" size="lg" block className="mt-4" onClick={() => void retry()}>{t('common.retry')}</Button>}
    </div>
  </main>
}
