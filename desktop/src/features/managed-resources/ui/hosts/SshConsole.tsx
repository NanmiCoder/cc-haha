import { useEffect, useRef } from 'react'
import { Terminal as XTermTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Cable, ShieldAlert, TerminalSquare, Unplug } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { useHostSshStore } from '../../stores/hostSshStore'
import { useTranslation } from '../../../../i18n'
import { getDesktopHost } from '../../../../lib/desktopHost'
import type { Host } from '../../types/resourceTypes'
import type { HostManagementEvent } from '../../types/resourceTypes'

type Props = {
  host: Host
}

type Translator = ReturnType<typeof useTranslation>
function statusLabel(t: Translator, status: ReturnType<typeof useHostSshStore.getState>['byHostId'][string] | undefined) {
  if (!status) return t('managedResources.ssh.statusIdle' as never)
  switch (status.status) {
    case 'idle':
      return t('managedResources.ssh.statusIdle') || '未连接'
    case 'allocating':
      return t('managedResources.ssh.statusAllocating') || '正在分配连接'
    case 'connecting':
      return t('managedResources.ssh.statusConnecting') || '正在连接'
    case 'awaiting_host_key':
      return t('managedResources.ssh.statusAwaitingHostKey') || '等待主机密钥确认'
    case 'ready':
      return t('managedResources.ssh.statusReady') || '已连接'
    case 'closing':
      return t('managedResources.ssh.statusClosing') || '正在关闭'
    case 'closed':
      return t('managedResources.ssh.statusClosed') || '已关闭'
    case 'failed':
      return t('managedResources.ssh.statusFailed') || '连接失败'
  }
}

function errorLabel(t: Translator, error: string): string {
  const key = `managedResources.errors.${error}`
  const translated = t(key as never)
  return translated && translated !== key ? translated : error
}

export function SshConsole({ host }: Props) {

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTermTerminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const t = useTranslation()
  const entry = useHostSshStore(state => state.byHostId[host.id])

  // Mount xterm only after the user initiates a connection. This keeps
  // jsdom tests from exercising xterm (which needs canvas metrics) and lets
  // us defer the DOM cost until there's actually something to display.
  useEffect(() => {
    const connectionId = entry?.connectionId
    if (!connectionId) return
    if (!containerRef.current) return
    if (termRef.current) return
    const generation = entry.generation
    let disposed = false
    let unlistenEvent: (() => void) | undefined
    const isCurrent = () => {
      const current = useHostSshStore.getState().byHostId[host.id]
      return !disposed && current?.connectionId === connectionId && current.generation === generation
    }
    const term = new XTermTerminal({
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      scrollback: 10_000,
      lineHeight: 1.2,
      theme: { background: '#050505' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    try { fit.fit() } catch {}
    termRef.current = term
    fitRef.current = fit

    const resize = () => { try { fit.fit() } catch {} }
    window.addEventListener('resize', resize)
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(resize)
      : null
    resizeObserver?.observe(containerRef.current)
    try { term.focus() } catch {}

    const hostApi = getDesktopHost().hostManagement
    void hostApi.onEvent((event: HostManagementEvent) => {
      if (!isCurrent() || !('connectionId' in event)) return
      if (event.connectionId !== connectionId || event.generation !== generation) return
      if (event.type === 'terminal-output') {
        try {
          const binary = atob(event.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          // xterm consumes writes asynchronously. ACK only this generation's
          // parsed bytes, never a disposed terminal's late callback.
          term.write(bytes, () => {
            if (!isCurrent()) return
            void hostApi.ackOutput({ connectionId, generation, bytesAcked: event.byteLength }).catch(() => undefined)
          })
        } catch {
          // ignore malformed base64; service already validated.
        }
      } else if (event.type === 'connection-state') {
        if (event.status === 'ready') term.writeln('\x1b[32m[connected]\x1b[0m')
        else if (event.status === 'failed') term.writeln(`\x1b[31m[failed] ${event.error ?? 'unknown'}\x1b[0m`)
        else if (event.status === 'closing' || event.status === 'closed') term.writeln('\x1b[33m[closed]\x1b[0m')
      }
    }).then(unlisten => {
      if (disposed) unlisten()
      else unlistenEvent = unlisten
    }).catch(() => undefined)

    const inputSubscription = term.onData(data => {
      if (!isCurrent() || useHostSshStore.getState().byHostId[host.id]?.status !== 'ready') return
      void hostApi.writeConnection({ connectionId, generation, data }).catch(() => undefined)
    })

    const resizeSubscription = term.onResize(({ cols, rows }) => {
      if (!isCurrent()) return
      void hostApi.resizeConnection({ connectionId, generation, cols, rows }).catch(() => undefined)
    })

    return () => {
      disposed = true
      unlistenEvent?.()
      inputSubscription.dispose()
      resizeSubscription.dispose()
      window.removeEventListener('resize', resize)
      resizeObserver?.disconnect()
      try { term.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
    }
  }, [host.id, entry?.connectionId, entry?.generation])

  const start = () => useHostSshStore.getState().start(host, 80, 24)
  const disconnect = () => useHostSshStore.getState().disconnect(host.id)
  const answerTrust = () => useHostSshStore.getState().answer(host.id, 'trust')
  const answerReject = () => useHostSshStore.getState().answer(host.id, 'reject')

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container)] shadow-sm" data-host-id={host.id}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-container-high)] px-3 py-2" role="toolbar" aria-label={t('managedResources.ssh.toolbar') || 'SSH 控制台工具栏'}>
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare size={16} className="shrink-0 text-[var(--color-success)]" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[var(--color-text-primary)]">{t('managedResources.ssh.title' as never) || 'SSH Terminal'}</div>
            <div className="truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">{host.username}@{host.address}:{host.port}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-[var(--color-surface-container-highest)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]" data-status={entry?.status ?? 'idle'} aria-live="polite">
            {statusLabel(t, entry)}
          </span>
          {!entry || entry.status === 'idle' || entry.status === 'closed' || entry.status === 'failed' ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded border border-[var(--color-success)] bg-[var(--color-success-container)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-on-success-container)] hover:bg-[var(--color-surface-hover)]"
              onClick={start}
              aria-label={t('managedResources.ssh.connect') || '连接'}
            >
              <Cable size={13} />
              {t('managedResources.ssh.connect') || '连接'}
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded border border-[var(--color-error)] bg-[var(--color-error-container)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-on-error-container)] hover:bg-[var(--color-surface-hover)]"
              onClick={disconnect}
              aria-label={t('managedResources.ssh.disconnect') || '断开'}
            >
              <Unplug size={13} />
              {t('managedResources.ssh.disconnect') || '断开'}
            </button>
          )}
        </div>
      </div>
      {entry?.challenge ? (
        <div className="m-3 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3 text-xs text-[var(--color-on-warning-container)]" role="alertdialog" aria-modal="true" aria-labelledby="ssh-challenge-title">
          <div className="flex items-start gap-2">
            <ShieldAlert size={17} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <h3 id="ssh-challenge-title" className="font-semibold">{t('managedResources.ssh.hostKeyTitle') || '首次主机密钥确认'}</h3>
              <p className="mt-1 text-[var(--color-text-secondary)]">{t('managedResources.ssh.hostKeyPrompt' as never) || '请核对服务器主机密钥指纹。确认后才会继续 SSH 身份验证。'}</p>
              <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono">
                <dt className="font-sans text-[var(--color-text-tertiary)]">{t('managedResources.ssh.hostKeyEndpoint') || '端点'}</dt>
                <dd className="break-all">{entry.challenge.endpoint}</dd>
                <dt className="font-sans text-[var(--color-text-tertiary)]">{t('managedResources.ssh.hostKeyAlgorithm') || '算法'}</dt>
                <dd className="break-all">{entry.challenge.algorithm}</dd>
                <dt className="font-sans text-[var(--color-text-tertiary)]">{t('managedResources.ssh.hostKeyFingerprint') || 'SHA-256 指纹'}</dt>
                <dd className="break-all">SHA256:{entry.challenge.fingerprint}</dd>
              </dl>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]" onClick={answerReject} aria-label={t('managedResources.ssh.reject') || '拒绝'}>
                  {t('managedResources.ssh.reject') || '拒绝'}
                </button>
                <button type="button" className="rounded border border-[var(--color-success)] bg-[var(--color-success-container)] px-3 py-1.5 font-medium text-[var(--color-on-success-container)] hover:bg-[var(--color-surface-hover)]" onClick={answerTrust} aria-label={t('managedResources.ssh.trustAndContinue' as never) || '信任并继续'}>
                  {t('managedResources.ssh.trustAndContinue' as never) || '信任并继续'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {entry?.changedKey ? (
        <div className="ssh-console__alert" role="alert">
          {t('managedResources.ssh.hostKeyChanged') || '主机密钥已变更；连接已拒绝。请人工核验。'}
        </div>
      ) : null}
      {entry?.lastError && entry.status === 'failed' ? (
        <div className="mx-3 mt-3 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-xs text-[var(--color-on-error-container)]" role="alert">
          {errorLabel(t, entry.lastError)}
        </div>
      ) : null}
      <div className="relative h-[48vh] min-h-[360px] max-h-[640px] bg-[var(--color-surface)] p-2">
        {!entry?.connectionId && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-xs text-[var(--color-text-tertiary)]">
            {t('managedResources.ssh.clickToConnect' as never) || 'Click Connect to open an interactive SSH terminal.'}
          </div>
        )}
        <div
          ref={containerRef}
          className="h-full min-h-[344px] w-full overflow-hidden rounded"
          role="region"
          aria-label={t('managedResources.ssh.terminalRegion') || 'SSH 终端输出'}
        />
      </div>
    </div>
  )
}
