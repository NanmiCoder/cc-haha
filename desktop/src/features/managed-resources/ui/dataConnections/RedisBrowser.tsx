import { useEffect, useRef, useState } from 'react'
import { getDesktopHost } from '../../../../lib/desktopHost'
import { useTranslation } from '../../../../i18n'
import type { DataSessionRef, RedisKeySummary, RedisReadResult } from '../../api/dataConnectionsApi'
import type { RedisConnection } from '../../types/dataConnectionTypes'
import { dataBrowserMessage } from './dataBrowserMessage'

function renderValue(result: RedisReadResult): string {
  return JSON.stringify(result.items, null, 2)
}

export function RedisBrowser({ connection }: { connection: RedisConnection }) {
  const host = getDesktopHost()
  const t = useTranslation()
  const [session, setSession] = useState<DataSessionRef | null>(null)
  const sessionRef = useRef<DataSessionRef | null>(null)
  const lifecycle = useRef(0)
  const disconnecting = useRef(false)
  const [match, setMatch] = useState('')
  const [cursor, setCursor] = useState('0')
  const [complete, setComplete] = useState(false)
  const [keys, setKeys] = useState<RedisKeySummary[]>([])
  const [selectedToken, setSelectedToken] = useState<string | null>(null)
  const [value, setValue] = useState<RedisReadResult | null>(null)
  const [readCursor, setReadCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    lifecycle.current += 1
    setBusy(false)
    setSession(null)
    setCursor('0')
    setComplete(false)
    setKeys([])
    setSelectedToken(null)
    setValue(null)
    setReadCursor(null)
    setError(null)
    return () => {
      lifecycle.current += 1
      const current = sessionRef.current
      sessionRef.current = null
      if (current) void host.dataConnections.closeConnection(current.dataSessionId, current.generation).catch(() => undefined)
    }
  }, [connection.id, connection.revision, host])

  const connect = async () => {
    const epoch = lifecycle.current
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.openConnection(connection.id, connection.revision)
      if (epoch !== lifecycle.current) {
        if (response.ok) await host.dataConnections.closeConnection(response.data.dataSessionId, response.data.generation)
        return
      }
      if (!response.ok) setError(response.error.code)
      else {
        sessionRef.current = response.data
        setSession(response.data)
      }
    } catch {
      if (epoch === lifecycle.current) setError('INTERNAL_ERROR')
    } finally {
      if (epoch === lifecycle.current) setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!session || disconnecting.current) return
    disconnecting.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.closeConnection(session.dataSessionId, session.generation)
      if (sessionRef.current !== session) return
      if (!response.ok) { setError(response.error.code); return }
      sessionRef.current = null
      setSession(null)
      setKeys([])
      setValue(null)
      setCursor('0')
      setComplete(false)
      setSelectedToken(null)
      setReadCursor(null)
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally { disconnecting.current = false; setBusy(false) }
  }

  const scan = async (reset = false) => {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.scanKeys({
        dataSessionId: session.dataSessionId,
        generation: session.generation,
        cursor: reset ? '0' : cursor,
        ...(match.trim() ? { match: match.trim() } : {}),
        countHint: 100,
      })
      if (sessionRef.current !== session) return
      if (!response.ok) {
        setError(response.error.code)
        return
      }
      setCursor(response.data.nextCursor)
      setComplete(response.data.complete)
      setKeys(current => reset ? response.data.keys : [...current, ...response.data.keys])
      if (reset) {
        setSelectedToken(null)
        setValue(null)
        setReadCursor(null)
      }
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally { if (sessionRef.current === session) setBusy(false) }
  }

  const read = async (key: RedisKeySummary, nextCursor?: string | null) => {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.readKey({
        dataSessionId: session.dataSessionId,
        generation: session.generation,
        rawKeyToken: key.rawKeyToken,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        count: 100,
      })
      if (sessionRef.current !== session) return
      if (!response.ok) {
        setError(response.error.code)
        return
      }
      setSelectedToken(key.rawKeyToken)
      setValue(response.data)
      setReadCursor(response.data.nextCursor)
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally { if (sessionRef.current === session) setBusy(false) }
  }

  const selectedKey = keys.find(key => key.rawKeyToken === selectedToken) ?? null

  return (
    <section data-testid="redis-browser" className="mt-6 border-t border-[var(--color-border)] pt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('managedResources.dataBrowser.redisTitle')}</h3>
          <p className="text-xs text-[var(--color-text-secondary)]">{t('managedResources.dataBrowser.redisHint')}</p>
        </div>
        {session
          ? <button type="button" data-testid="data-browser-disconnect" className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs" onClick={() => void disconnect()}>{t('managedResources.dataBrowser.disconnect')}</button>
          : <button type="button" data-testid="data-browser-connect" className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-xs text-[var(--color-on-primary)]" disabled={busy} onClick={() => void connect()}>{t('managedResources.dataBrowser.connect')}</button>}
      </div>
      {error && <div role="alert" className="mb-3 text-xs text-[var(--color-error)]">{dataBrowserMessage(error)}</div>}
      {session && (
        <div className="grid min-h-64 grid-cols-1 gap-3 md:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.3fr)]">
          <div className="min-w-0 rounded-md border border-[var(--color-border)] p-2">
            <div className="mb-2 flex gap-2">
              <input aria-label={t('managedResources.dataBrowser.match')} disabled={busy} data-testid="redis-match" className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs" value={match} placeholder="orders:*" onChange={(event) => setMatch(event.currentTarget.value)} />
              <button type="button" data-testid="redis-refresh" className="rounded-md border border-[var(--color-border)] px-2 text-xs" disabled={busy} onClick={() => void scan(true)}>{t('managedResources.dataBrowser.refresh')}</button>
            </div>
            <div className="max-h-64 overflow-auto">
              {keys.map(key => (
                <button key={key.rawKeyToken} disabled={busy} type="button" className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-xs ${selectedToken === key.rawKeyToken ? 'bg-[var(--color-surface-selected)]' : 'hover:bg-[var(--color-surface-hover)]'}`} onClick={() => void read(key)} title={key.displayKey}>
                  {key.displayKey}{key.binary ? ' [binary]' : ''}
                </button>
              ))}
              {!complete && (
                <button type="button" data-testid="redis-scan-more" className="mt-2 w-full rounded-md border border-[var(--color-border)] py-1 text-xs" disabled={busy} onClick={() => void scan(false)}>{t('managedResources.dataBrowser.more')}</button>
              )}
            </div>
          </div>
          <div className="min-w-0 rounded-md border border-[var(--color-border)] p-3">
            {selectedKey && value ? (
              <>
                <div className="mb-2 flex flex-wrap gap-3 text-xs text-[var(--color-text-secondary)]">
                  <span>{selectedKey.displayKey}</span>
                  <span>{value.exists ? value.type : t('managedResources.dataBrowser.expired')}</span>
                  <span>TTL: {value.ttlSeconds ?? '—'}</span>
                  <span>{value.byteCount} {t('managedResources.dataBrowser.bytes')}</span>
                  {value.truncated && <span>{t('managedResources.dataBrowser.truncated')}</span>}
                </div>
                <pre data-testid="redis-value" className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-surface-container)] p-3 text-xs">{renderValue(value)}</pre>
                {readCursor && <button type="button" data-testid="redis-read-more" className="mt-2 rounded-md border border-[var(--color-border)] px-3 py-1 text-xs" disabled={busy} onClick={() => void read(selectedKey, readCursor)}>{t('managedResources.dataBrowser.more')}</button>}
              </>
            ) : <div className="text-xs text-[var(--color-text-secondary)]">{t('managedResources.dataBrowser.selectKey')}</div>}
          </div>
        </div>
      )}
    </section>
  )
}
